"""Shared editing never shares a terminal or mutates a running snapshot."""
from datetime import datetime, timezone
from unittest.mock import patch

from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import AuthSession
from workspace.collaboration import apply_update, ensure_document, read_doc
from workspace.models import File, FileCollaborator, Workspace
from .test_websockets import FakeInteractiveRunner, ORIGIN, TerminalClient


@override_settings(CHANNEL_LAYERS={'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}})
class SharedExecutionTests(TransactionTestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user('owner')
        self.editor = get_user_model().objects.create_user('editor')
        self.viewer = get_user_model().objects.create_user('viewer')
        self.stranger = get_user_model().objects.create_user('stranger')
        self.workspace = Workspace.objects.create(owner=self.owner)
        self.file = File.objects.create(workspace=self.workspace, name='main.py', content='print("snapshot")')
        ensure_document(self.file)
        FileCollaborator.objects.create(file=self.file, user=self.editor, permission='edit', granted_by=self.owner)
        FileCollaborator.objects.create(file=self.file, user=self.viewer, permission='view', granted_by=self.owner)
        self.tokens = {}
        for user in (self.owner, self.editor, self.viewer, self.stranger):
            refresh = RefreshToken.for_user(user)
            session = AuthSession.objects.create(user=user, refresh_jti=refresh['jti'],
                expires_at=datetime.fromtimestamp(refresh['exp'], timezone.utc))
            refresh['sid'] = str(session.pk)
            self.tokens[user.pk] = str(refresh.access_token)
        FakeInteractiveRunner.instances = []
        FakeInteractiveRunner.failure = None
        self.runner_patch = patch('workspace.consumers.InteractiveRunner', FakeInteractiveRunner)
        self.runner_patch.start()
        self.addCleanup(self.runner_patch.stop)

    async def connect(self, user, file_id=None, origin=ORIGIN):
        client = TerminalClient(f'/api/sharing/files/{file_id or self.file.pk}/run/', origin)
        self.assertEqual((await client.connect())['type'], 'websocket.accept')
        await client.send_json_to({'type': 'authenticate', 'token': self.tokens[user.pk]})
        return client

    async def start(self, user, **start_options):
        client = await self.connect(user)
        self.assertEqual((await client.receive_json_from())['type'], 'authenticated')
        await client.send_json_to({'type': 'start', **start_options})
        self.assertEqual((await client.receive_json_from())['type'], 'ready')
        self.assertEqual((await client.receive_json_from())['data'], 'prompt: ')
        return client

    async def test_editor_runs_saved_snapshot_while_crdt_updates_continue(self):
        first = await self.start(self.owner)
        second = await self.start(self.editor)
        owner_run, editor_run = FakeInteractiveRunner.instances
        self.assertEqual(owner_run.source, 'print("snapshot")')
        self.assertEqual(editor_run.source, owner_run.source)

        def concurrent_edit():
            self.file.refresh_from_db()
            doc = read_doc(self.file.document.state)
            vector = doc.get_state()
            doc['content'] += '\nprint("newer edit")'
            apply_update(self.file.pk, self.editor, doc.get_update(vector))
            self.file.refresh_from_db()
            return self.file.content
        latest = await database_sync_to_async(concurrent_edit)()
        self.assertIn('newer edit', latest)
        self.assertNotIn('newer edit', owner_run.source)
        self.assertNotIn('newer edit', editor_run.source)
        # Spoofing a target never changes the socket's own terminal.
        await second.send_json_to({'type': 'input', 'data': 'mine\r', 'session_id': 'owner'})
        self.assertEqual((await second.receive_json_from())['data'], 'echo: mine\r')
        self.assertEqual(owner_run.inputs, [])
        await second.send_json_to({'type': 'stop'})
        self.assertEqual((await second.receive_json_from())['reason'], 'stopped')
        self.assertFalse(owner_run.stopped)
        await second.disconnect()
        await first.disconnect()
        self.assertEqual(await database_sync_to_async(lambda: File.objects.get(pk=self.file.pk).content)(), latest)

    async def test_viewers_unaccepted_users_and_private_siblings_cannot_run(self):
        for user in (self.viewer, self.stranger):
            client = await self.connect(user)
            self.assertEqual((await client.app.receive_output())['code'], 4404)
            await client.disconnect()
        sibling = await database_sync_to_async(File.objects.create)(workspace=self.workspace, name='private.py')
        client = await self.connect(self.editor, sibling.pk)
        self.assertEqual((await client.app.receive_output())['code'], 4404)
        await client.disconnect()
        # The original workspace terminal is still owner-only.
        client = TerminalClient(f'/api/workspaces/{self.workspace.pk}/files/{self.file.pk}/run/', ORIGIN)
        await client.connect()
        await client.send_json_to({'type': 'authenticate', 'token': self.tokens[self.editor.pk]})
        self.assertEqual((await client.app.receive_output())['code'], 4404)
        await client.disconnect()
        self.assertEqual(FakeInteractiveRunner.instances, [])

    async def test_revoke_or_downgrade_stops_only_the_removed_editors_run(self):
        for action in ('downgrade', 'remove'):
            await database_sync_to_async(FileCollaborator.objects.filter(file=self.file, user=self.editor).update)(permission='edit')
            owner = await self.start(self.owner)
            editor = await self.start(self.editor)
            owner_run, editor_run = FakeInteractiveRunner.instances[-2:]
            def revoke():
                http = APIClient(); http.force_authenticate(self.owner)
                url = f'/api/sharing/files/{self.file.pk}/members/{self.editor.pk}/'
                return (http.patch(url, {'permission': 'view'}) if action == 'downgrade' else http.delete(url)).status_code
            self.assertEqual(await database_sync_to_async(revoke)(), 200 if action == 'downgrade' else 204)
            self.assertEqual((await editor.receive_json_from())['type'], 'error')
            self.assertEqual((await editor.app.receive_output())['code'], 4403)
            self.assertTrue(editor_run.stopped)
            self.assertFalse(owner_run.stopped)
            await editor.disconnect(); await owner.disconnect()

    async def test_extension_has_priority_and_source_from_client_is_ignored(self):
        client = await self.start(self.editor, language='cpp', content='not the saved file')
        runner = FakeInteractiveRunner.instances[-1]
        self.assertEqual(runner.language, 'python')
        self.assertEqual(runner.source, 'print("snapshot")')
        await client.disconnect()

    async def test_ambiguous_extensionless_snapshot_requires_explicit_supported_choice(self):
        await database_sync_to_async(File.objects.filter(pk=self.file.pk).update)(name='main', content='x = 1')
        for choice in (None, 'javascript', {'bad': 'value'}):
            client = await self.connect(self.editor)
            await client.receive_json_from()
            await client.send_json_to({'type': 'start', 'language': choice})
            self.assertIn('confidently', (await client.receive_json_from())['message'])
            self.assertEqual((await client.receive_json_from())['reason'], 'error')
            await client.disconnect()
        client = await self.start(self.editor, language='python')
        self.assertEqual(FakeInteractiveRunner.instances[-1].language, 'python')
        await client.disconnect()

    async def test_code_execution_disabled_is_still_enforced(self):
        self.runner_patch.stop()
        with patch.dict('os.environ', {'CODE_EXECUTION_ENABLED': 'false'}):
            client = await self.connect(self.editor)
            await client.receive_json_from()
            await client.send_json_to({'type': 'start'})
            self.assertEqual((await client.receive_json_from())['message'], 'Code execution is not configured for this deployment.')
            self.assertEqual((await client.receive_json_from())['reason'], 'error')
            await client.disconnect()
        self.assertEqual(FakeInteractiveRunner.instances, [])

    async def test_ready_reports_the_captured_revision_and_next_run_uses_new_revision(self):
        first = await self.connect(self.editor)
        await first.receive_json_from()
        await first.send_json_to({'type': 'start', 'revision': 9000})
        ready = await first.receive_json_from()
        self.assertEqual(ready, {'type': 'ready', 'language': 'python', 'revision': 0})
        await first.receive_json_from()
        original = FakeInteractiveRunner.instances[-1]
        def edit():
            doc = read_doc(self.file.document.state)
            vector = doc.get_state()
            doc['content'] += '\nprint("new")'
            return apply_update(self.file.pk, self.editor, doc.get_update(vector))['revision']
        revision = await database_sync_to_async(edit)()
        self.assertEqual(revision, 1)
        self.assertEqual(original.source, 'print("snapshot")')
        await first.disconnect()
        second = await self.connect(self.editor)
        await second.receive_json_from()
        await second.send_json_to({'type': 'start'})
        self.assertEqual((await second.receive_json_from())['revision'], revision)
        self.assertIn('print("new")', FakeInteractiveRunner.instances[-1].source)
        await second.disconnect()

    async def test_channel_layer_failure_still_stops_the_private_runner(self):
        import asyncio
        from channels.layers import get_channel_layer
        from redis.exceptions import ConnectionError
        failure = asyncio.Event()
        async def failed_receive(channel):
            await failure.wait()
            raise ConnectionError('Test Redis disconnect')
        with patch.object(get_channel_layer(), 'receive', side_effect=failed_receive):
            socket = await self.start(self.editor)
            runner = FakeInteractiveRunner.instances[-1]
            failure.set()
            with self.assertRaises(ConnectionError):
                await socket.app.wait(timeout=5)
            self.assertTrue(runner.stopped)
