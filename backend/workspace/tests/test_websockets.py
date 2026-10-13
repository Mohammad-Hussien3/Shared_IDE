import asyncio
import json
import os
import subprocess
import uuid
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from asgiref.testing import ApplicationCommunicator
from django.test import SimpleTestCase, TestCase
from django.contrib.auth import get_user_model

from Shared_IDE.asgi import application
from workspace.consumers import TerminalConsumer
from workspace.models import File, Workspace


ORIGIN = [(b"origin", b"http://localhost:5173")]
LIVE_RUNNER = os.getenv("RUN_PODMAN_INTEGRATION_TESTS") == "1"


class TerminalClient:
    def __init__(self, path, origin):
        self.app = ApplicationCommunicator(application, {
            "type": "websocket",
            "path": path,
            "headers": origin,
            "query_string": b"",
            "subprotocols": [],
        })

    async def connect(self):
        await self.app.send_input({"type": "websocket.connect"})
        await asyncio.sleep(0.01)
        return await self.app.receive_output(timeout=5)

    async def send_json_to(self, value):
        await self.app.send_input({"type": "websocket.receive", "text": json.dumps(value)})
        await asyncio.sleep(0.01)

    async def receive_json_from(self, timeout=25):
        response = await self.app.receive_output(timeout=timeout)
        return json.loads(response["text"])

    async def receive_nothing(self, timeout=0.2):
        return await self.app.receive_nothing(timeout=timeout)

    async def disconnect(self):
        await self.app.send_input({"type": "websocket.disconnect", "code": 1000})
        await asyncio.sleep(0.01)
        await self.app.wait(timeout=3)


class TerminalWebSocketTests(SimpleTestCase):
    def setUp(self):
        self.workspace = SimpleNamespace(id=uuid.uuid4())
        self.file = SimpleNamespace(
            id=uuid.uuid4(), name="main.py", language="python", content='print("hello")'
        )
        self.other_workspace = SimpleNamespace(id=uuid.uuid4())

        async def saved_file(consumer):
            route = consumer.scope["url_route"]["kwargs"]
            if route["workspace_id"] != str(self.workspace.id) or route["file_id"] != str(self.file.id):
                return None
            return {"name": self.file.name, "content": self.file.content}

        patcher = patch.object(TerminalConsumer, "_saved_file", saved_file)
        patcher.start()
        self.addCleanup(patcher.stop)
        async def authenticate(consumer, token):
            return SimpleNamespace(id=1), {'sid': 'test-session'}
        auth_patcher = patch.object(TerminalConsumer, '_authenticate', authenticate)
        auth_patcher.start()
        self.addCleanup(auth_patcher.stop)

    def communicator(self, workspace_id=None, file_id=None, origin=ORIGIN):
        workspace_id = workspace_id or self.workspace.id
        file_id = file_id or self.file.id
        path = f"/api/workspaces/{workspace_id}/files/{file_id}/run/"
        return TerminalClient(path, origin)

    async def connect_and_start(self, **kwargs):
        client = self.communicator(**kwargs)
        response = await client.connect()
        self.assertEqual(response["type"], "websocket.accept")
        await client.send_json_to({'type': 'authenticate', 'token': 'test-access'})
        self.assertEqual((await client.receive_json_from())['type'], 'authenticated')
        await client.send_json_to({"type": "start"})
        return client

    async def collect_until(self, client, kind="finished", timeout=25):
        messages = []
        while True:
            message = await client.receive_json_from(timeout=timeout)
            messages.append(message)
            if message["type"] == kind:
                return messages

    async def close_client(self, client):
        await client.disconnect()

    def test_rejects_other_workspace_file_and_unapproved_origin(self):
        async def exercise():
            client = self.communicator(workspace_id=self.other_workspace.id)
            await client.connect()
            await client.send_json_to({'type': 'authenticate', 'token': 'test-access'})
            self.assertEqual((await client.app.receive_output())['code'], 4404)
            await self.close_client(client)

            rejected = self.communicator(origin=[(b"origin", b"http://untrusted.example")])
            response = await rejected.connect()
            self.assertEqual(response["type"], "websocket.close")
            await rejected.disconnect()

        asyncio.run(exercise())

    @skipUnless(LIVE_RUNNER, "Set RUN_PODMAN_INTEGRATION_TESTS=1 to exercise Podman")
    def test_python_output_input_multiple_inputs_and_errors(self):
        async def immediate_output():
            client = await self.connect_and_start()
            messages = await self.collect_until(client)
            self.assertIn("hello", "".join(item.get("data", "") for item in messages))
            self.assertEqual(messages[-1]["exit_code"], 0)
            await self.close_client(client)

        asyncio.run(immediate_output())

        self.file.content = 'a = input("First: ")\nb = input("Second: ")\nprint("Hello", a, b)'

        async def exercise():
            client = await self.connect_and_start()
            first = await self.collect_until(client, "output")
            self.assertTrue(any("First:" in item.get("data", "") for item in first))
            await client.send_json_to({"type": "input", "data": "Mohammad\r"})
            second = await self.collect_until(client, "output")
            while not any("Second:" in item.get("data", "") for item in second):
                second += await self.collect_until(client, "output")
            await client.send_json_to({"type": "input", "data": "Hussein\r"})
            rest = await self.collect_until(client)
            output = "".join(item.get("data", "") for item in first + second + rest)
            self.assertIn("Hello Mohammad Hussein", output)
            self.assertEqual(rest[-1]["exit_code"], 0)
            await self.close_client(client)

        asyncio.run(exercise())

        self.file.content = "def bad(:\n    pass"

        async def syntax_error():
            client = await self.connect_and_start()
            messages = await self.collect_until(client)
            self.assertIn("SyntaxError", "".join(item.get("data", "") for item in messages))
            self.assertNotEqual(messages[-1]["exit_code"], 0)
            await self.close_client(client)

        asyncio.run(syntax_error())

        self.file.content = 'raise RuntimeError("broken")'

        async def runtime_error():
            client = await self.connect_and_start()
            messages = await self.collect_until(client)
            self.assertIn("RuntimeError: broken", "".join(item.get("data", "") for item in messages))
            self.assertNotEqual(messages[-1]["exit_code"], 0)
            await self.close_client(client)

        asyncio.run(runtime_error())

    @skipUnless(LIVE_RUNNER, "Set RUN_PODMAN_INTEGRATION_TESTS=1 to exercise Podman")
    def test_c_and_cpp_accept_input(self):
        programs = [
            ("c", "main.c", '#include <stdio.h>\nint main(void) { int n; printf("Number: "); scanf("%d", &n); printf("C=%d\\n", n); }', "C=42"),
            ("cpp", "main.cpp", '#include <iostream>\nint main() { int n; std::cout << "Number: "; std::cin >> n; std::cout << "CPP=" << n << "\\n"; }', "CPP=42"),
        ]

        for language, name, source, expected in programs:
            with self.subTest(language=language):
                self.file.name = name
                self.file.language = language
                self.file.content = source

                async def exercise():
                    client = await self.connect_and_start()
                    messages = await self.collect_until(client, "output")
                    while "Number:" not in "".join(item.get("data", "") for item in messages):
                        messages += await self.collect_until(client, "output")
                    await client.send_json_to({"type": "input", "data": "42\r"})
                    messages += await self.collect_until(client)
                    self.assertIn(expected, "".join(item.get("data", "") for item in messages))
                    self.assertEqual(messages[-1]["exit_code"], 0)
                    await self.close_client(client)

                asyncio.run(exercise())

    @skipUnless(LIVE_RUNNER, "Set RUN_PODMAN_INTEGRATION_TESTS=1 to exercise Podman")
    def test_stop_fresh_session_and_socket_isolation(self):
        self.file.content = 'value = input("Enter: ")\nprint("Echo:", value)'

        async def exercise():
            first = await self.connect_and_start()
            second = await self.connect_and_start()
            await self.collect_until(first, "output")
            await self.collect_until(second, "output")

            await first.send_json_to({"type": "input", "data": "first\r"})
            first_messages = await self.collect_until(first)
            self.assertIn("Echo: first", "".join(item.get("data", "") for item in first_messages))
            self.assertTrue(await second.receive_nothing(timeout=0.2))
            await self.close_client(first)

            await second.send_json_to({"type": "stop"})
            second_messages = await self.collect_until(second)
            self.assertEqual(second_messages[-1]["reason"], "stopped")
            await self.close_client(second)

            fresh = await self.connect_and_start()
            fresh_messages = await self.collect_until(fresh, "output")
            self.assertIn("Enter:", "".join(item.get("data", "") for item in fresh_messages))
            await fresh.send_json_to({"type": "input", "data": "new\r"})
            fresh_messages += await self.collect_until(fresh)
            self.assertIn("Echo: new", "".join(item.get("data", "") for item in fresh_messages))
            await self.close_client(fresh)

            abandoned = await self.connect_and_start()
            await self.collect_until(abandoned, "output")
            await self.close_client(abandoned)

        asyncio.run(exercise())

        containers = subprocess.run(
            ["podman", "ps", "-a", "--filter", "name=workspace-terminal", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        self.assertEqual(containers.stdout.strip(), "")


class TerminalSavedFileTests(TestCase):
    def test_websocket_loads_only_saved_file_in_requested_workspace(self):
        user = get_user_model().objects.create_user(username='owner')
        workspace = Workspace.objects.create(name="one", owner=user)
        other_workspace = Workspace.objects.create(name="two", owner=user)
        file = File.objects.create(
            workspace=workspace,
            name="main.py",
            language="python",
            content='print("saved source")',
        )
        consumer = TerminalConsumer()
        consumer.user = user
        consumer.scope = {"url_route": {"kwargs": {
            "workspace_id": str(workspace.id), "file_id": str(file.id)
        }}}
        saved_file_query = TerminalConsumer.__dict__["_saved_file"].func
        self.assertEqual(saved_file_query(consumer), {
            "name": "main.py", "content": 'print("saved source")'
        })

        consumer.scope["url_route"]["kwargs"]["workspace_id"] = str(other_workspace.id)
        self.assertIsNone(saved_file_query(consumer))


class FakeInteractiveRunner:
    """An in-memory process boundary; the real ASGI consumer still runs."""
    instances = []
    failure = None

    def __init__(self, language, source):
        from unittest.mock import AsyncMock, Mock
        self.language, self.source = language, source
        self.process = SimpleNamespace(wait=AsyncMock(return_value=0))
        self.output_limited = False
        self.queue = asyncio.Queue()
        self.inputs = []
        self.resize = Mock()
        self.stopped = False
        self.instances.append(self)

    async def start(self):
        if self.failure: raise self.failure
        self.queue.put_nowait(b'prompt: ')

    async def output_chunks(self):
        while True:
            chunk = await self.queue.get()
            if chunk is None: return
            yield chunk

    async def write(self, text):
        if len(text) > 4096: raise ValueError('Terminal input limit reached.')
        self.inputs.append(text)
        self.queue.put_nowait(('echo: ' + text).encode())
        if text == 'done\r': self.queue.put_nowait(None)

    async def stop(self):
        if not self.stopped:
            self.stopped = True
            self.queue.put_nowait(None)


class MockTerminalTests(SimpleTestCase):
    communicator = TerminalWebSocketTests.communicator
    connect_and_start = TerminalWebSocketTests.connect_and_start
    collect_until = TerminalWebSocketTests.collect_until

    def setUp(self):
        TerminalWebSocketTests.setUp(self)
        FakeInteractiveRunner.instances = []
        FakeInteractiveRunner.failure = None
        patcher = patch('workspace.consumers.InteractiveRunner', FakeInteractiveRunner)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def ready_client(self):
        client = await self.connect_and_start()
        messages = await self.collect_until(client, 'output')
        self.assertEqual(messages[0]['type'], 'ready')
        self.assertEqual(messages[-1]['data'], 'prompt: ')
        return client

    async def test_saved_content_streaming_multiple_inputs_and_completion(self):
        client = await self.ready_client()
        process = FakeInteractiveRunner.instances[0]
        self.assertEqual((process.language, process.source), ('python', self.file.content))
        await client.send_json_to({'type': 'input', 'data': 'first\r'})
        self.assertEqual((await client.receive_json_from())['data'], 'echo: first\r')
        await client.send_json_to({'type': 'input', 'data': 'done\r'})
        messages = await self.collect_until(client)
        self.assertEqual(messages[-1], {'type': 'finished', 'reason': 'completed', 'exit_code': 0})
        self.assertEqual(process.inputs, ['first\r', 'done\r'])
        await client.disconnect()
        self.assertTrue(process.stopped)

    async def test_socket_ownership_stop_and_fresh_session(self):
        first, second = await self.ready_client(), await self.ready_client()
        a, b = FakeInteractiveRunner.instances
        await first.send_json_to({'type': 'input', 'data': 'private\r'})
        self.assertIn('private', (await first.receive_json_from())['data'])
        self.assertEqual(b.inputs, [])
        self.assertTrue(await second.receive_nothing(timeout=0.02))
        await first.send_json_to({'type': 'stop'})
        self.assertEqual((await self.collect_until(first))[-1]['reason'], 'stopped')
        await first.disconnect()
        self.assertFalse(b.stopped)
        await second.disconnect()
        self.assertTrue(b.stopped)
        fresh = await self.ready_client()
        self.assertEqual(FakeInteractiveRunner.instances[-1].inputs, [])
        await fresh.disconnect()

    async def test_invalid_messages_duplicate_start_and_input_limits(self):
        client = await self.ready_client()
        for payload, expected in [([], 'Invalid'), ({'type': 'unknown'}, 'Unknown'), ({'type': 'start'}, 'already started'), ({'type': 'input', 'data': 42}, 'must be text'), ({'type': 'input', 'data': 'x' * 4097}, 'limit')]:
            await client.send_json_to(payload)
            message = await client.receive_json_from()
            self.assertEqual(message['type'], 'error')
            self.assertIn(expected, message['message'])
        self.assertEqual(len(FakeInteractiveRunner.instances), 1)
        await client.disconnect()

    async def test_resize_validation(self):
        client = await self.ready_client()
        process = FakeInteractiveRunner.instances[0]
        for cols, rows in [(0, 24), (80, 0), (501, 24), (80, 201), (True, 24), ('80', 24)]:
            await client.send_json_to({'type': 'resize', 'cols': cols, 'rows': rows})
        process.resize.assert_not_called()
        await client.send_json_to({'type': 'resize', 'cols': 100, 'rows': 30})
        process.resize.assert_called_once_with(100, 30)
        await client.disconnect()

    async def test_timeout_reports_failure_and_cleans_up(self):
        with patch('workspace.consumers.INTERACTIVE_TIMEOUT_SECONDS', 0.08):
            client = await self.connect_and_start()
            messages = await self.collect_until(client)
            self.assertTrue(any(item.get('message') == 'Execution timed out.' for item in messages))
            self.assertEqual(messages[-1]['reason'], 'timeout')
            await client.disconnect()
            self.assertTrue(FakeInteractiveRunner.instances[0].stopped)

    async def test_output_limit_and_split_utf8(self):
        client = await self.ready_client()
        process = FakeInteractiveRunner.instances[0]
        process.queue.put_nowait(b'\xe2\x82')
        process.queue.put_nowait(b'\xac')
        process.output_limited = True
        process.queue.put_nowait(None)
        messages = await self.collect_until(client)
        self.assertEqual(''.join(item.get('data', '') for item in messages), '€')
        self.assertEqual(messages[-1]['reason'], 'output_limit')
        self.assertTrue(any('Output limit' in item.get('message', '') for item in messages))
        await client.disconnect()

    async def test_runner_unavailable_and_unexpected_error_are_safe(self):
        from workspace.runner import RunnerUnavailable
        for error, expected in [(RunnerUnavailable('image missing'), 'image missing'), (RuntimeError('private internal detail'), 'The terminal session failed.')]:
            FakeInteractiveRunner.failure = error
            with patch('workspace.consumers.logger.exception'):
                client = await self.connect_and_start()
                messages = await self.collect_until(client)
            self.assertEqual(messages[0]['message'], expected)
            self.assertEqual(messages[-1]['reason'], 'error')
            await client.disconnect()
            self.assertTrue(FakeInteractiveRunner.instances[-1].stopped)

    async def test_unsupported_ambiguous_and_oversized_files_never_start_runner(self):
        for name, source in [('main.js', 'console.log(1)'), ('main', 'x = 1'), ('main.py', 'x' * 65537)]:
            self.file.name, self.file.content = name, source
            client = await self.connect_and_start()
            messages = await self.collect_until(client)
            self.assertEqual(messages[0]['type'], 'error')
            self.assertEqual(messages[-1]['reason'], 'error')
            await client.disconnect()
        self.assertEqual(FakeInteractiveRunner.instances, [])

    async def test_disconnect_before_start_does_not_create_process(self):
        client = self.communicator()
        await client.connect()
        await client.send_json_to({'type': 'input', 'data': 'ignored'})
        await client.disconnect()
        self.assertEqual(FakeInteractiveRunner.instances, [])
