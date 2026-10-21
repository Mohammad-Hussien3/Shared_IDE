"""Redis configuration is unit-tested; real idle sockets are explicitly opt-in."""
import asyncio
from datetime import datetime, timezone
import importlib.util
import os
import sys
from pathlib import Path
from unittest import skipUnless
from unittest.mock import patch

from channels.layers import get_channel_layer
from channels.db import database_sync_to_async
from channels_redis.core import RedisChannelLayer
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import connection
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TransactionTestCase
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import AuthSession
from workspace.collaboration import ensure_document, encode, decode, read_doc
from workspace.models import File, FileCollaborator, Workspace
from .test_websockets import ORIGIN, TerminalClient


class RedisConfigurationTests(SimpleTestCase):
    def load_settings(self, **environment):
        spec = importlib.util.spec_from_file_location('Shared_IDE._redis_settings_test',
            Path(settings.BASE_DIR) / 'Shared_IDE/settings.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'REDIS_URL': '', 'DJANGO_DEBUG': 'true',
                                    'SENTRY_DISABLED': 'true', **environment}), \
                patch('Shared_IDE.monitoring.init_sentry'):
            if 'REDIS_REQUIRED' not in environment:
                os.environ.pop('REDIS_REQUIRED', None)
            # Real .env files must not supply missing flags during these checks.
            with patch.object(Path, 'is_file', return_value=False):
                spec.loader.exec_module(module)
        return module

    def test_effective_channel_pool_allows_blocking_receives_but_bounds_connects(self):
        module = self.load_settings(REDIS_URL='redis://localhost:6379/15')
        config = module.CHANNEL_LAYERS['default']
        self.assertEqual(config['BACKEND'], 'channels_redis.core.RedisChannelLayer')
        layer = RedisChannelLayer(**config['CONFIG'])
        pool = layer.create_pool(0)  # No connection or real Redis required.
        self.assertIsNone(pool.connection_kwargs['socket_timeout'])
        self.assertEqual(pool.connection_kwargs['socket_connect_timeout'], 5)
        self.assertGreaterEqual(layer.brpop_timeout, 5)


    def test_single_process_development_uses_in_memory_layer(self):
        module = self.load_settings()
        self.assertFalse(module.REDIS_REQUIRED)
        self.assertEqual(module.CHANNEL_LAYERS['default']['BACKEND'], 'channels.layers.InMemoryChannelLayer')

    def test_production_and_explicit_multi_process_modes_require_redis(self):
        for environment in ({'DJANGO_DEBUG': 'false'}, {'REDIS_REQUIRED': 'true'}):
            with self.subTest(environment=environment), self.assertRaisesMessage(ImproperlyConfigured, 'REDIS_URL is required'):
                self.load_settings(REDIS_URL='  ', **environment)

    def test_isolated_ci_can_explicitly_opt_out_with_debug_disabled(self):
        module = self.load_settings(DJANGO_DEBUG='false', REDIS_REQUIRED='false')
        self.assertEqual(module.CHANNEL_LAYERS['default']['BACKEND'], 'channels.layers.InMemoryChannelLayer')

    def test_required_mode_uses_same_redis_for_channel_layer_and_cache(self):
        module = self.load_settings(DJANGO_DEBUG='false', REDIS_URL=' redis://redis:6379/15 ')
        self.assertTrue(module.REDIS_REQUIRED)
        self.assertEqual(module.CHANNEL_LAYERS['default']['CONFIG']['hosts'][0]['address'], 'redis://redis:6379/15')
        self.assertEqual(module.CACHES['default']['LOCATION'], 'redis://redis:6379/15')

    def test_url_cannot_override_safe_channel_timeouts_or_expose_credentials(self):
        for option in ('socket_timeout=5', 'socket_connect_timeout=0', 'socket_timeout='):
            with self.subTest(option=option):
                with self.assertRaises(ImproperlyConfigured) as raised:
                    self.load_settings(REDIS_URL=f'redis://test-user:private-test-password@redis:6379/15?{option}')
                self.assertIn('Do not set', str(raised.exception))
                self.assertNotIn('private-test-password', str(raised.exception))


@skipUnless(os.getenv('RUN_REDIS_INTEGRATION_TESTS') == '1', 'Set RUN_REDIS_INTEGRATION_TESTS=1 with a dedicated Redis test database')
class LiveRedisTests(TransactionTestCase):
    def setUp(self):
        self.assertIsInstance(get_channel_layer(), RedisChannelLayer)
        user = get_user_model().objects.create_user('redis-idle-check')
        owner = get_user_model().objects.create_user('redis-file-owner')
        workspace = Workspace.objects.create(owner=owner)
        self.file = File.objects.create(workspace=workspace, name='idle.py', content='print(1)')
        ensure_document(self.file)
        FileCollaborator.objects.create(file=self.file, user=user, permission='edit', granted_by=owner)
        self.editor_id = user.pk
        self.database_name = connection.settings_dict['NAME']
        token = RefreshToken.for_user(user)
        session = AuthSession.objects.create(user=user, refresh_jti=token['jti'],
            expires_at=datetime.fromtimestamp(token['exp'], timezone.utc))
        token['sid'] = str(session.pk)
        self.token = str(token.access_token)

    async def test_idle_channel_and_authenticated_websocket_survive_multiple_blocking_receives(self):
        layer = get_channel_layer()
        channel = await layer.new_channel('test.idle.')
        pending = asyncio.create_task(layer.receive(channel))
        client = TerminalClient(f'/api/collaboration/files/{self.file.pk}/', ORIGIN)
        try:
            self.assertEqual((await client.connect())['type'], 'websocket.accept')
            await client.send_json_to({'type': 'authenticate', 'token': self.token})
            self.assertEqual((await client.receive_json_from())['type'], 'ready')
            self.assertEqual((await client.receive_json_from())['type'], 'sync')
            # Exceeds both redis-py 8's old five-second read timeout and two
            # BZPOPMIN windows, without sending anything to the idle channel.
            await asyncio.sleep(12)
            if pending.done():
                pending.result()  # Surface the actual transport error, if any.
                self.fail('An idle channel receive returned without a message')
            await layer.send(channel, {'type': 'test.complete'})
            self.assertEqual(await asyncio.wait_for(pending, 3), {'type': 'test.complete'})
            await client.send_json_to({'type': 'sync', 'vector': encode(b'\0')})
            # Periodic sync frames may be queued, but the same socket stays open.
            self.assertEqual((await client.receive_json_from())['type'], 'sync')
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            await client.disconnect()


    async def worker(self, action):
        # Fresh interpreter, independent Django connections and channel layer.
        # Explicitly target the isolated test DB, never the application's DB.
        program = r"""
import os, sys
os.environ['DJANGO_SETTINGS_MODULE'] = 'Shared_IDE.settings'
import django
django.setup()
from workspace.models import File
from django.core.cache import cache
from workspace.collaboration import apply_update, read_doc
from rest_framework.test import APIClient
file = File.objects.select_related('workspace__owner').get(pk=sys.argv[1])
assert cache.get(f'presence:{file.pk}:{sys.argv[3]}') is True
if sys.argv[2] == 'edit':
    doc = read_doc(file.document.state)
    vector = doc.get_state()
    doc['content'] += '\n# separate backend process'
    apply_update(file.pk, file.workspace.owner, doc.get_update(vector))
else:
    client = APIClient()
    client.force_authenticate(file.workspace.owner)
    response = client.delete(f'/api/sharing/files/{file.pk}/members/{sys.argv[3]}/')
    assert response.status_code == 204
"""
        env = {**os.environ, 'POSTGRES_DB': self.database_name, 'SENTRY_DISABLED': 'true',
               'DJANGO_ALLOWED_HOSTS': 'testserver'}
        process = await asyncio.create_subprocess_exec(sys.executable, '-c', program,
            str(self.file.pk), action, str(self.editor_id), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            await asyncio.wait_for(process.communicate(), 15)
            self.assertEqual(process.returncode, 0, 'Separate backend worker failed; private output suppressed')
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def test_separate_backend_process_publishes_edits_and_revokes_active_access(self):
        client = TerminalClient(f'/api/collaboration/files/{self.file.pk}/', ORIGIN)
        # Disable periodic recovery so only real cross-process Redis delivery can
        # satisfy these assertions. Authorization remains active on every event.
        with patch('workspace.collaboration_consumer.SESSION_CHECK_SECONDS', 60):
            try:
                await client.connect()
                await client.send_json_to({'type': 'authenticate', 'token': self.token})
                self.assertEqual((await client.receive_json_from())['permission'], 'edit')
                initial = await client.receive_json_from()
                doc = read_doc(decode(initial['update']))
                await self.worker('edit')
                updated = await client.receive_json_from(timeout=3)
                self.assertEqual(updated['type'], 'sync')
                self.assertGreater(updated['revision'], initial['revision'])
                doc.apply_update(decode(updated['update']))
                self.assertIn('# separate backend process', str(doc['content']))
                content = await database_sync_to_async(lambda: File.objects.get(pk=self.file.pk).content)()
                self.assertEqual(content, str(doc['content']))
                await self.worker('revoke')
                self.assertEqual((await client.receive_json_from(timeout=3))['message'], 'access_revoked')
                self.assertEqual((await client.app.receive_output(timeout=3))['code'], 4403)
            finally:
                await client.disconnect()


class RedisDisconnectCleanupTests(SimpleTestCase):
    async def test_collaboration_dispatch_failure_cancels_background_watcher(self):
        from channels.generic.websocket import AsyncWebsocketConsumer
        from redis.exceptions import ConnectionError
        from workspace.collaboration_consumer import CollaborationConsumer
        for already_closed in (False, True):
            with self.subTest(already_closed=already_closed):
                consumer = CollaborationConsumer()
                consumer.closed = already_closed; consumer.joined = False
                consumer.watcher = asyncio.create_task(asyncio.Event().wait())
                try:
                    with patch.object(AsyncWebsocketConsumer, '__call__', side_effect=ConnectionError('Test disconnect')):
                        with self.assertRaises(ConnectionError):
                            await consumer({}, None, None)
                    self.assertTrue(consumer.watcher.done())
                    self.assertTrue(consumer.closed)
                finally:
                    consumer.watcher.cancel()
                    await asyncio.gather(consumer.watcher, return_exceptions=True)

    async def test_terminal_send_failure_flag_does_not_skip_resource_cleanup(self):
        from unittest.mock import AsyncMock
        from channels.generic.websocket import AsyncJsonWebsocketConsumer
        from redis.exceptions import ConnectionError
        from workspace.consumers import TerminalConsumer
        consumer = TerminalConsumer()
        # _send marks the socket disconnected on a transport error, before the
        # dispatch loop finishes. Runner cleanup must still happen afterward.
        consumer.disconnected = True
        consumer.disconnect = AsyncMock()
        with patch.object(AsyncJsonWebsocketConsumer, '__call__', side_effect=ConnectionError('Test disconnect')):
            with self.assertRaises(ConnectionError):
                await consumer({}, None, None)
        consumer.disconnect.assert_awaited_once_with(1006)

    async def test_failed_presence_cleanup_still_closes_the_socket(self):
        from unittest.mock import AsyncMock, Mock
        from redis.exceptions import ConnectionError
        from workspace.collaboration_consumer import CollaborationConsumer
        consumer = CollaborationConsumer()
        consumer.closed = False; consumer.joined = True; consumer.group = 'test.file'; consumer.channel_name = 'test.channel'
        consumer.channel_layer = Mock(group_discard=AsyncMock(side_effect=ConnectionError('Test disconnect')))
        consumer.send_data = AsyncMock(); consumer.close = AsyncMock()
        with patch('workspace.collaboration_consumer.capture_unexpected') as capture:
            await consumer.stop(1011, 'unavailable')
        capture.assert_called_once()
        consumer.close.assert_awaited_once_with(code=1011)
        self.assertFalse(consumer.joined)
