from datetime import datetime, timezone
from unittest.mock import patch

from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.test import TransactionTestCase
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken, AccessToken

from accounts.models import AuthSession, EmailVerification
from workspace.models import Workspace, File
from .test_websockets import TerminalClient, ORIGIN, FakeInteractiveRunner


class AuthenticatedTerminalTests(TransactionTestCase):
    def setUp(self):
        self.alice = get_user_model().objects.create_user(username='alice')
        self.bob = get_user_model().objects.create_user(username='bob')
        self.workspace = Workspace.objects.create(owner=self.alice, name='one')
        self.other = Workspace.objects.create(owner=self.alice, name='two')
        self.file = File.objects.create(workspace=self.workspace, name='main.py', language='python', content='print("saved")')
        self.alice_token, self.alice_refresh = self.session(self.alice)
        self.bob_token, _ = self.session(self.bob)
        FakeInteractiveRunner.instances = []
        FakeInteractiveRunner.failure = None
        patcher = patch('workspace.consumers.InteractiveRunner', FakeInteractiveRunner)
        patcher.start()
        self.addCleanup(patcher.stop)

    def session(self, user):
        refresh = RefreshToken.for_user(user)
        session = AuthSession.objects.create(user=user, refresh_jti=refresh['jti'], expires_at=datetime.fromtimestamp(refresh['exp'], tz=timezone.utc))
        refresh['sid'] = str(session.pk)
        return str(refresh.access_token), str(refresh)

    def socket(self, workspace=None, origin=ORIGIN):
        return TerminalClient(f'/api/workspaces/{(workspace or self.workspace).pk}/files/{self.file.pk}/run/', origin)

    async def authenticate(self, token, workspace=None):
        client = self.socket(workspace)
        self.assertEqual((await client.connect())['type'], 'websocket.accept')
        await client.send_json_to({'type': 'authenticate', 'token': token})
        return client

    async def start(self, token):
        client = await self.authenticate(token)
        self.assertEqual(await client.receive_json_from(), {'type': 'authenticated'})
        await client.send_json_to({'type': 'start'})
        self.assertEqual((await client.receive_json_from())['type'], 'ready')
        self.assertEqual((await client.receive_json_from())['data'], 'prompt: ')
        return client

    async def test_no_token_invalid_expired_refresh_and_foreign_tokens_are_rejected(self):
        client = self.socket()
        await client.connect()
        await client.send_json_to({'type': 'start'})
        self.assertEqual((await client.app.receive_output())['code'], 4401)
        await client.disconnect()
        expired = AccessToken(self.alice_token)
        expired['exp'] = 1
        for token, code in [('invalid', 4401), (str(expired), 4401), (self.alice_refresh, 4401), (self.bob_token, 4404)]:
            client = await self.authenticate(token)
            self.assertEqual((await client.app.receive_output())['code'], code)
            await client.disconnect()
        self.assertEqual(FakeInteractiveRunner.instances, [])

    async def test_same_user_wrong_workspace_and_unapproved_origin_are_rejected(self):
        client = await self.authenticate(self.alice_token, self.other)
        self.assertEqual((await client.app.receive_output())['code'], 4404)
        await client.disconnect()
        client = self.socket(origin=[(b'origin', b'https://evil.example')])
        self.assertEqual((await client.connect())['type'], 'websocket.close')
        await client.disconnect()
        self.assertEqual(FakeInteractiveRunner.instances, [])

    async def test_authentication_deadline_closes_idle_connection(self):
        with patch('workspace.consumers.AUTH_TIMEOUT_SECONDS', 0.02):
            client = self.socket()
            await client.connect()
            self.assertEqual((await client.app.receive_output(timeout=1))['code'], 4401)
            await client.disconnect()

    async def test_logout_revokes_terminal_and_stops_container(self):
        client = await self.start(self.alice_token)
        process = FakeInteractiveRunner.instances[0]
        self.assertEqual(process.source, 'print("saved")')
        def logout():
            http = APIClient()
            http.cookies['ide_refresh'] = self.alice_refresh
            return http.post('/api/auth/logout/').status_code
        with patch('workspace.consumers.SESSION_CHECK_SECONDS', 0.02):
            self.assertEqual(await database_sync_to_async(logout)(), 204)
            message = await client.receive_json_from(timeout=3)
            self.assertIn('revoked', message['message'])
            self.assertEqual((await client.app.receive_output())['code'], 4401)
        await client.disconnect()
        self.assertTrue(process.stopped)

    async def test_authenticated_sockets_cannot_control_each_other(self):
        first = await self.start(self.alice_token)
        second = await self.start(self.alice_token)
        a, b = FakeInteractiveRunner.instances
        await first.send_json_to({'type': 'input', 'data': 'private\r', 'session_id': 'second'})
        self.assertEqual((await first.receive_json_from())['data'], 'echo: private\r')
        self.assertEqual(b.inputs, [])
        await first.send_json_to({'type': 'stop', 'session_id': 'second'})
        self.assertEqual((await first.receive_json_from())['reason'], 'stopped')
        self.assertFalse(b.stopped)
        await first.disconnect()
        await second.disconnect()
        self.assertTrue(a.stopped)
        self.assertTrue(b.stopped)

    async def test_revoked_token_cannot_reconnect(self):
        await database_sync_to_async(AuthSession.objects.filter(user=self.alice).update)(revoked_at=datetime.now(timezone.utc))
        client = await self.authenticate(self.alice_token)
        self.assertEqual((await client.app.receive_output())['code'], 4401)
        await client.disconnect()

    async def test_unverified_password_account_cannot_start_terminal_with_old_token(self):
        await database_sync_to_async(EmailVerification.objects.create)(user=self.alice, email='alice@example.com')
        client = await self.authenticate(self.alice_token)
        self.assertEqual((await client.app.receive_output())['code'], 4401)
        await client.disconnect()
        self.assertEqual(FakeInteractiveRunner.instances, [])
