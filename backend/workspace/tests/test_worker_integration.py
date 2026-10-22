"""Opt-in ASGI → authenticated host worker → real Podman integration.

Run inside Compose with RUN_WORKER_INTEGRATION_TESTS=1, transport=unix and
execution enabled. Uses Django's isolated test database, never real accounts.
"""
import asyncio
import os
from unittest import skipUnless

from channels.db import database_sync_to_async
from django.test import TransactionTestCase, override_settings
from rest_framework.test import APIClient

from workspace.collaboration import apply_update, read_doc
from workspace.models import File
from workspace.worker_client import request
from . import test_shared_execution
from .test_websockets import TerminalClient, ORIGIN


@skipUnless(os.getenv('RUN_WORKER_INTEGRATION_TESTS') == '1', 'Requires a prepared private Podman worker')
@override_settings(CHANNEL_LAYERS={'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}})
class LiveWorkerTerminalTests(TransactionTestCase):
    connect = test_shared_execution.SharedExecutionTests.connect

    def setUp(self):
        test_shared_execution.SharedExecutionTests.setUp(self)
        self.runner_patch.stop()
        self.assertEqual(os.getenv('CODE_RUNNER_TRANSPORT'), 'unix')

    async def receive_until(self, socket, kind):
        messages = []
        while True:
            message = await socket.receive_json_from(timeout=20)
            messages.append(message)
            self.assertNotEqual(message['type'], 'error', message)
            self.assertTrue(message['type'] != 'finished' or kind == 'finished', messages)
            if message['type'] == kind:
                return messages

    async def test_shared_snapshot_live_edits_private_terminals_and_revocation(self):
        def source():
            doc = read_doc(self.file.document.state)
            vector = doc.get_state()
            doc['content'].clear()
            doc['content'] += 'value=input("Snapshot: "); print("original", value)'
            apply_update(self.file.pk, self.owner, doc.get_update(vector))
        await database_sync_to_async(source)()
        first, second = await self.connect(self.owner), await self.connect(self.editor)
        try:
            for socket in (first, second):
                self.assertEqual((await socket.receive_json_from())['type'], 'authenticated')
                await socket.send_json_to({'type': 'start'})
                messages = await self.receive_until(socket, 'output')
                self.assertEqual(messages[0]['type'], 'ready')
                self.assertEqual(messages[0]['revision'], 1)
                self.assertIn('Snapshot:', messages[-1]['data'])

            def edit():
                self.file.refresh_from_db()
                doc = read_doc(self.file.document.state)
                vector = doc.get_state()
                doc['content'] += '\nprint("newer collaborative edit")'
                return apply_update(self.file.pk, self.editor, doc.get_update(vector))['revision']
            self.assertEqual(await database_sync_to_async(edit)(), 2)
            await first.send_json_to({'type': 'input', 'data': 'owner-only\r'})
            messages = await self.receive_until(first, 'finished')
            output = ''.join(message.get('data', '') for message in messages)
            self.assertIn('original owner-only', output)
            self.assertNotIn('newer collaborative edit', output)
            self.assertEqual(messages[-1]['exit_code'], 0)
            self.assertTrue(await second.receive_nothing(timeout=0.1))

            def revoke():
                client = APIClient(); client.force_authenticate(self.owner)
                return client.delete(f'/api/sharing/files/{self.file.pk}/members/{self.editor.pk}/').status_code
            self.assertEqual(await database_sync_to_async(revoke)(), 204)
            self.assertEqual((await second.receive_json_from())['type'], 'error')
            self.assertEqual((await second.app.receive_output())['code'], 4403)
            content = await database_sync_to_async(lambda: File.objects.get(pk=self.file.pk).content)()
            self.assertIn('newer collaborative edit', content)
        finally:
            await first.disconnect(); await second.disconnect()
        async with asyncio.timeout(10):
            while (await request({'type': 'health'}))['active']:
                await asyncio.sleep(0.1)

    async def test_owned_python_c_cpp_through_authenticated_terminal(self):
        for name, source in [
            ('main.py', 'value=input("Number: "); print("answer",value)'),
            ('main.c', '#include <stdio.h>\nint main(void){int n;printf("Number: ");scanf("%d",&n);printf("answer %d\\n",n);}'),
            ('main.cpp', '#include <iostream>\nint main(){int n;std::cout<<"Number: ";std::cin>>n;std::cout<<"answer "<<n<<"\\n";}'),
        ]:
            file = await database_sync_to_async(File.objects.create)(workspace=self.workspace, name=name, content=source)
            client = TerminalClient(f'/api/workspaces/{self.workspace.pk}/files/{file.pk}/run/', ORIGIN)
            try:
                self.assertEqual((await client.connect())['type'], 'websocket.accept')
                await client.send_json_to({'type': 'authenticate', 'token': self.tokens[self.owner.pk]})
                self.assertEqual((await client.receive_json_from())['type'], 'authenticated')
                await client.send_json_to({'type': 'start', 'content': 'ignored spoof'})
                messages = await self.receive_until(client, 'output')
                self.assertEqual(messages[0]['type'], 'ready')
                self.assertIn('Number:', messages[-1]['data'])
                await client.send_json_to({'type': 'input', 'data': '42\r'})
                messages = await self.receive_until(client, 'finished')
                self.assertIn('answer 42', ''.join(message.get('data', '') for message in messages))
                self.assertEqual(messages[-1]['exit_code'], 0)
            finally:
                await client.disconnect()
