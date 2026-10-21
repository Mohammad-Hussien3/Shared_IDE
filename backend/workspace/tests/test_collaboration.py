import asyncio
from datetime import datetime, timezone
from unittest.mock import patch
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import transaction, close_old_connections
from django.test import TestCase, TransactionTestCase, override_settings
from pycrdt import Doc, Text
from rest_framework.exceptions import APIException
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken
from accounts.models import AuthSession
from workspace.collaboration import apply_update, decode, encode, ensure_document, read_doc, snapshot
from workspace.models import File, FileCollaborator, Workspace
from workspace.sharing import locked_file
from .test_websockets import TerminalClient


class DocumentTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user('owner')
        self.editor = get_user_model().objects.create_user('editor')
        self.viewer = get_user_model().objects.create_user('viewer')
        self.workspace = Workspace.objects.create(owner=self.owner)
        self.file = File.objects.create(workspace=self.workspace, name='main.py', language='python', content='abc')
        self.member = FileCollaborator.objects.create(file=self.file, user=self.editor, permission='edit', granted_by=self.owner)
        FileCollaborator.objects.create(file=self.file, user=self.viewer, permission='view', granted_by=self.owner)
        ensure_document(self.file)

    def doc(self):
        self.file.refresh_from_db()
        return read_doc(self.file.document.state)

    def test_concurrent_updates_merge_duplicate_and_reordered_delivery_survive_restart(self):
        a, b = self.doc(), self.doc()
        va, vb = a.get_state(), b.get_state()
        a['content'].insert(0, 'A'); ua = a.get_update(va)
        b['content'].insert(0, 'B'); ub = b.get_update(vb)
        apply_update(self.file.pk, self.owner, ua)
        apply_update(self.file.pk, self.editor, ub)
        first = snapshot(self.file.pk, self.owner)
        apply_update(self.file.pk, self.editor, ub)
        self.assertEqual(snapshot(self.file.pk, self.owner)['revision'], first['revision'])
        a.apply_update(ub); b.apply_update(ua)
        self.assertEqual(str(a['content']), str(b['content']))
        self.assertEqual(str(self.doc()['content']), str(a['content']))
        # A later update arrives before its dependency; raw merged state retains it.
        c = self.doc(); v1 = c.get_state(); c['content'] += '1'; u1 = c.get_update(v1)
        v2 = c.get_state(); c['content'] += '2'; u2 = c.get_update(v2)
        apply_update(self.file.pk, self.editor, u2)
        apply_update(self.file.pk, self.editor, u1)
        self.assertEqual(str(self.doc()['content']), str(c['content']))
        self.file.refresh_from_db()
        self.assertEqual(self.file.content, str(c['content']))
        missing = snapshot(self.file.pk, self.owner, a.get_state())
        a.apply_update(decode(missing['update']))
        self.assertEqual(str(a['content']), self.file.content)

    def test_viewer_and_revoked_editor_cannot_write(self):
        d = self.doc(); old = d.get_state(); d['content'] += 'private'
        for user in (self.viewer,):
            with self.assertRaises(APIException): apply_update(self.file.pk, user, d.get_update(old))
        self.member.delete()
        with self.assertRaises(APIException): apply_update(self.file.pk, self.editor, d.get_update(old))
        self.assertEqual(str(self.doc()['content']), 'abc')

    def test_legacy_owner_save_cannot_overwrite_crdt_and_metadata_updates_work(self):
        client = APIClient(); client.force_authenticate(self.owner)
        url = f'/api/workspaces/{self.workspace.pk}/files/{self.file.pk}/'
        self.assertEqual(client.patch(url, {'content':'stale'}).status_code, 409)
        self.assertEqual(client.patch(url, {'name':'new.py', 'language':'python'}).status_code, 200)
        self.assertEqual(str(self.doc()['content']), 'abc')
        client.force_authenticate(self.viewer)
        self.assertEqual(client.patch(f'/api/sharing/files/{self.file.pk}/', {'update':encode(b'\0\0')}).status_code, 403)

    def test_malformed_oversized_and_nontext_updates_rejected(self):
        with self.assertRaises(APIException): apply_update(self.file.pk, self.editor, b'invalid')
        d = self.doc(); v = d.get_state(); d['content'] += 'x' * 65537
        with self.assertRaises(APIException): apply_update(self.file.pk, self.editor, d.get_update(v))
        d = self.doc(); v = d.get_state(); d['content'] += '\x00'
        with self.assertRaises(APIException): apply_update(self.file.pk, self.editor, d.get_update(v))
        d = Doc({'other': Text('not source')})
        with self.assertRaises(APIException): apply_update(self.file.pk, self.editor, d.get_update())
        self.assertEqual(str(self.doc()['content']), 'abc')


    def test_shared_rest_updates_only_the_authorized_document(self):
        client = APIClient(); client.force_authenticate(self.editor)
        doc = self.doc(); vector = doc.get_state(); doc['content'] += 'shared change'
        url = f'/api/sharing/files/{self.file.pk}/'
        response = client.patch(url, {'update': encode(doc.get_update(vector))}, format='json')
        self.assertEqual(response.status_code, 200)
        self.file.refresh_from_db(); self.assertEqual(self.file.content, 'abcshared change')
        for payload in ([], [{'update':'invalid'}], 'not an object'):
            self.assertEqual(client.patch(url, payload, format='json').status_code,400)
        for field in ('name', 'language', 'workspace', 'folder', 'owner', 'content'):
            self.assertEqual(client.patch(url, {field:'forbidden'},format='json').status_code,400)
        other = File.objects.create(workspace=self.workspace,name='private',content='secret')
        self.assertEqual(client.patch(f'/api/sharing/files/{other.pk}/',
            {'update':encode(doc.get_update())},format='json').status_code,404)
        other.refresh_from_db(); self.assertEqual(other.content,'secret')
        self.assertFalse(hasattr(other,'document'))

    def test_owner_cannot_disable_collaboration_with_serializer_input(self):
        client = APIClient(); client.force_authenticate(self.owner)
        url = f'/api/workspaces/{self.workspace.pk}/files/{self.file.pk}/'
        self.assertEqual(client.patch(url, {'collaborative':False,'content':'stale'},format='json').status_code,409)
        response = client.patch(url, {'collaborative':False,'name':'safe.py'},format='json')
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.data['collaborative'])


@override_settings(CHANNEL_LAYERS={'default': {'BACKEND':'channels.layers.InMemoryChannelLayer'}})
class CollaborationSocketTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.owner = get_user_model().objects.create_user('owner')
        self.editor = get_user_model().objects.create_user('editor')
        self.viewer = get_user_model().objects.create_user('viewer')
        self.outsider = get_user_model().objects.create_user('outsider')
        self.workspace = Workspace.objects.create(owner=self.owner)
        self.file = File.objects.create(workspace=self.workspace, name='main.py', content='abc')
        self.member = FileCollaborator.objects.create(file=self.file, user=self.editor, permission='edit', granted_by=self.owner)
        FileCollaborator.objects.create(file=self.file, user=self.viewer, permission='view', granted_by=self.owner)
        with transaction.atomic(): ensure_document(self.file)
        self.tokens = {}
        for user in [self.owner, self.editor, self.viewer, self.outsider]:
            refresh = RefreshToken.for_user(user)
            session = AuthSession.objects.create(user=user, refresh_jti=refresh['jti'],
                expires_at=datetime.fromtimestamp(refresh['exp'],tz=timezone.utc))
            refresh['sid'] = str(session.pk)
            self.tokens[user.pk] = str(refresh.access_token)

    def socket(self, origin='http://localhost:5173'):
        return TerminalClient(f'/api/collaboration/files/{self.file.pk}/', [(b'origin',origin.encode())])

    async def until(self, socket, kind):
        for _ in range(30):
            message = await socket.receive_json_from(timeout=4)
            if message['type'] == kind: return message
        self.fail('Expected socket event not received')

    async def connect(self, user):
        socket = self.socket()
        self.assertEqual((await socket.connect())['type'], 'websocket.accept')
        await socket.send_json_to({'type':'authenticate','token':self.tokens[user.pk]})
        ready = await self.until(socket,'ready')
        state = await self.until(socket,'sync')
        return socket, ready, state

    async def test_real_crdt_updates_converge_and_reconnect_recovers(self):
        a, _, sa = await self.connect(self.owner)
        b, _, sb = await self.connect(self.editor)
        da, db = read_doc(decode(sa['update'])), read_doc(decode(sb['update']))
        va, vb = da.get_state(), db.get_state()
        da['content'].insert(0,'A'); db['content'].insert(0,'B')
        await a.send_json_to({'type':'update','seq':1,'update':encode(da.get_update(va))})
        await b.send_json_to({'type':'update','seq':1,'update':encode(db.get_update(vb))})
        await self.until(a,'ack'); await self.until(b,'ack')
        await a.disconnect(); await b.disconnect()
        reopened, _, state = await self.connect(self.owner)
        content = str(read_doc(decode(state['update']))['content'])
        self.assertIn(content, ['ABabc','BAabc'])
        self.assertEqual(content, await database_sync_to_async(lambda: File.objects.get(pk=self.file.pk).content)())
        await reopened.disconnect()

    async def test_revocation_downgrade_and_viewer_write_are_enforced_live(self):
        for action, user, expected in [('revoke',self.editor,'access_revoked'),('write',self.viewer,'read_only')]:
            socket, _, _ = await self.connect(user)
            if action == 'revoke':
                await database_sync_to_async(lambda: FileCollaborator.objects.filter(pk=self.member.pk).delete())()
                await socket.send_json_to({'type':'sync','vector':encode(b'\0')})
            else:
                await socket.send_json_to({'type':'update','seq':1,'update':encode(b'\0\0')})
            self.assertEqual((await self.until(socket,'denied'))['message'],expected)
            await socket.disconnect()
        socket, _, _ = await self.connect(self.owner)
        viewer, _, _ = await self.connect(self.viewer)
        await database_sync_to_async(lambda: FileCollaborator.objects.filter(user=self.viewer).update(permission='edit'))()
        await viewer.send_json_to({'type':'sync','vector':encode(b'\0')})
        self.assertEqual((await self.until(viewer,'denied'))['message'],'permission_changed')
        await viewer.disconnect(); await socket.disconnect()

    async def test_identity_spoofing_is_ignored_and_presence_leaves(self):
        owner, ro, _ = await self.connect(self.owner)
        editor, re, _ = await self.connect(self.editor)
        self.assertNotEqual(ro['user']['color'],re['user']['color'])
        await editor.send_json_to({'type':'awareness','user':{'username':'fake'},'id':ro['presence_id'],'selection':None})
        message = await self.until(owner,'awareness')
        self.assertEqual(message['state']['user']['username'],'editor')
        self.assertEqual(message['id'],re['presence_id'])
        await editor.disconnect()
        for _ in range(10):
            message = await self.until(owner,'awareness')
            if message['state'] is None: break
        self.assertIsNone(message['state'])
        await owner.disconnect()

    async def test_colors_survive_other_members_leaving_and_reconnect(self):
        editor, editor_ready, _ = await self.connect(self.editor)
        viewer, viewer_ready, _ = await self.connect(self.viewer)
        self.assertNotEqual(editor_ready['user']['color'], viewer_ready['user']['color'])
        await database_sync_to_async(self.member.delete)()
        await editor.disconnect()
        await viewer.disconnect()
        reconnected, ready, _ = await self.connect(self.viewer)
        self.assertEqual(ready['user'], viewer_ready['user'])
        await reconnected.disconnect()

    async def test_unauthenticated_uninvited_and_foreign_origin_denied(self):
        socket = self.socket('https://evil.example')
        self.assertEqual((await socket.connect())['type'],'websocket.close')
        await socket.disconnect()
        for token in ('invalid',self.tokens[self.outsider.pk]):
            socket=self.socket(); await socket.connect()
            await socket.send_json_to({'type':'authenticate','token':token})
            await self.until(socket,'denied')
            await socket.disconnect()

    async def test_owner_removal_pushes_revocation_without_client_activity(self):
        owner, _, _ = await self.connect(self.owner)
        editor, re, _ = await self.connect(self.editor)
        viewer, _, _ = await self.connect(self.viewer)
        def remove():
            client = APIClient(); client.force_authenticate(self.owner)
            return client.delete(f'/api/sharing/files/{self.file.pk}/members/{self.editor.pk}/').status_code
        self.assertEqual(await database_sync_to_async(remove)(), 204)
        self.assertEqual((await self.until(editor, 'denied'))['message'], 'access_revoked')
        removed = False
        for _ in range(20):
            message = await self.until(owner, 'awareness')
            if message['id'] == re['presence_id'] and message['state'] is None:
                removed = True; break
        self.assertTrue(removed)
        # Unaffected viewer stays authorized, and delayed/replayed writes cannot pass.
        await viewer.send_json_to({'type':'sync','vector':encode(b'\0')})
        self.assertEqual((await self.until(viewer,'sync'))['permission'],'view')
        await editor.disconnect(); await owner.disconnect(); await viewer.disconnect()
        rejected = self.socket(); await rejected.connect()
        await rejected.send_json_to({'type':'authenticate','token':self.tokens[self.editor.pk]})
        self.assertEqual((await self.until(rejected,'denied'))['message'],'access_revoked')
        await rejected.disconnect()

    async def test_logout_session_revocation_and_authentication_deadline(self):
        with patch('workspace.collaboration_consumer.AUTH_TIMEOUT_SECONDS',0.02):
            idle = self.socket(); await idle.connect()
            self.assertEqual((await self.until(idle,'denied'))['message'],'session_expired')
            await idle.disconnect()
        with patch('workspace.collaboration_consumer.SESSION_CHECK_SECONDS',0.03):
            socket, _, _ = await self.connect(self.editor)
            await database_sync_to_async(AuthSession.objects.filter(user=self.editor).update)(
                revoked_at=datetime.now(timezone.utc))
            self.assertEqual((await self.until(socket,'denied'))['message'],'session_expired')
            await socket.disconnect()

    async def test_awareness_positions_are_whitelisted_and_never_persisted(self):
        owner, _, _ = await self.connect(self.owner)
        editor, ready, _ = await self.connect(self.editor)
        position = {'type':None,'tname':'content','item':None,'assoc':0}
        selection = {'anchor':position,'head':position}
        await editor.send_json_to({'type':'awareness','selection':selection,'username':'forged','color':'red'})
        for _ in range(10):
            message = await self.until(owner,'awareness')
            if message['state'].get('selection') == selection: break
        self.assertEqual(message['state']['selection'],selection)
        self.assertEqual(message['state']['user'],ready['user'])
        revision = await database_sync_to_async(lambda: File.objects.get(pk=self.file.pk).document.revision)()
        self.assertEqual(revision,0)
        await editor.send_json_to({'type':'awareness','selection':{'anchor':{'secret':'forbidden'},'head':position}})
        self.assertEqual((await self.until(editor,'denied'))['message'],'invalid_update')
        await editor.disconnect(); await owner.disconnect()

    async def test_oversized_and_high_frequency_messages_are_rejected(self):
        socket, _, _ = await self.connect(self.editor)
        await socket.send_json_to({'type':'update','seq':1,'update':'x' * 1500000})
        self.assertEqual((await self.until(socket,'denied'))['message'],'message_limit')
        await socket.disconnect()
        with patch('workspace.collaboration_consumer.MAX_MESSAGES_PER_SECOND',2):
            socket, _, _ = await self.connect(self.editor)
            for _ in range(3): await socket.send_json_to({'type':'awareness','selection':None})
            self.assertEqual((await self.until(socket,'denied'))['message'],'rate_limit')
            await socket.disconnect()

    def test_write_waiting_for_removal_lock_rechecks_permission_after_commit(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        started = Event()
        doc = read_doc(self.file.document.state); vector = doc.get_state(); doc['content'] += 'late edit'
        def delayed_write():
            close_old_connections(); started.set()
            try:
                apply_update(self.file.pk, self.editor, doc.get_update(vector))
                return 200
            except APIException as exc:
                return exc.status_code
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as executor:
            with transaction.atomic():
                locked_file(self.file.pk)
                self.member.delete()
                future = executor.submit(delayed_write)
                self.assertTrue(started.wait(timeout=2))
            self.assertEqual(future.result(timeout=5),404)
        self.file.refresh_from_db(); self.assertEqual(self.file.content,'abc')
