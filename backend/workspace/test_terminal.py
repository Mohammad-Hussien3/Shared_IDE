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

from Shared_IDE.asgi import application
from .consumers import TerminalConsumer
from .models import File, Workspace


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

    def communicator(self, workspace_id=None, file_id=None, origin=ORIGIN):
        workspace_id = workspace_id or self.workspace.id
        file_id = file_id or self.file.id
        path = f"/api/workspaces/{workspace_id}/files/{file_id}/run/"
        return TerminalClient(path, origin)

    async def connect_and_start(self, **kwargs):
        client = self.communicator(**kwargs)
        response = await client.connect()
        self.assertEqual(response["type"], "websocket.accept")
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
            client = await self.connect_and_start(workspace_id=self.other_workspace.id)
            messages = await self.collect_until(client)
            self.assertEqual(messages[0]["type"], "error")
            self.assertIn("not found", messages[0]["message"])
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
        workspace = Workspace.objects.create(name="one")
        other_workspace = Workspace.objects.create(name="two")
        file = File.objects.create(
            workspace=workspace,
            name="main.py",
            language="python",
            content='print("saved source")',
        )
        consumer = TerminalConsumer()
        consumer.scope = {"url_route": {"kwargs": {
            "workspace_id": str(workspace.id), "file_id": str(file.id)
        }}}
        saved_file_query = TerminalConsumer.__dict__["_saved_file"].func
        self.assertEqual(saved_file_query(consumer), {
            "name": "main.py", "content": 'print("saved source")'
        })

        consumer.scope["url_route"]["kwargs"]["workspace_id"] = str(other_workspace.id)
        self.assertIsNone(saved_file_query(consumer))
