"""Real private transport; only the Podman process boundary is mocked."""
import asyncio
from contextlib import asynccontextmanager
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from django.test import SimpleTestCase

from workspace.execution_worker import Worker, preflight
from workspace.runner import RunnerUnavailable, run_program
from workspace.worker_client import RemoteInteractiveRunner, request, interactive_runner
from workspace.worker_protocol import receive, send
from .test_websockets import FakeInteractiveRunner


class WorkerTests(SimpleTestCase):
    @asynccontextmanager
    async def worker(self, capacity=2):
        FakeInteractiveRunner.instances = []
        FakeInteractiveRunner.failure = None
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'token').write_text('a' * 48)
            worker = Worker('a' * 48, capacity)
            server = await asyncio.start_unix_server(worker.handle, path=directory + '/worker.sock')
            with patch.dict(os.environ, {'CODE_EXECUTION_ENABLED': 'true', 'CODE_WORKER_DIRECTORY': directory}), patch(
                'workspace.execution_worker.InteractiveRunner', FakeInteractiveRunner,
            ):
                try:
                    yield worker, directory
                finally:
                    server.close()
                    await server.wait_closed()
                    await worker.close()

    async def idle(self, worker):
        async with asyncio.timeout(2):
            while worker.active:
                await asyncio.sleep(0.01)

    async def test_health_and_unauthenticated_connections_cannot_run(self):
        async with self.worker() as (worker, directory):
            self.assertEqual(await request({'type': 'health'}), {'type': 'healthy', 'active': 0, 'capacity': 2})
            reader, writer = await asyncio.open_unix_connection(directory + '/worker.sock')
            await send(writer, {'token': 'wrong'})
            self.assertEqual(await reader.read(), b'')
            writer.close(); await writer.wait_closed()
            self.assertEqual(FakeInteractiveRunner.instances, [])

    async def test_snapshot_input_output_resize_and_exit(self):
        async with self.worker() as (worker, _):
            remote = RemoteInteractiveRunner('cpp', 'immutable source')
            await remote.start()
            fake = FakeInteractiveRunner.instances[0]
            self.assertEqual((fake.language, fake.source), ('cpp', 'immutable source'))
            remote.resize(100, 30)
            await remote.write('first\r')
            await remote.write('done\r')
            output = b''.join([chunk async for chunk in remote.output_chunks()])
            self.assertEqual(output, b'prompt: echo: first\recho: done\r')
            self.assertEqual(await remote.process.wait(), 0)
            self.assertEqual(fake.inputs, ['first\r', 'done\r'])
            await remote.stop(); await self.idle(worker)
            self.assertTrue(fake.stopped)
            fake.resize.assert_called_with(100, 30)

    async def test_capacity_is_bounded_and_sessions_are_private(self):
        async with self.worker() as (worker, _):
            first, second = RemoteInteractiveRunner('python', 'one'), RemoteInteractiveRunner('c', 'two')
            await first.start(); await second.start()
            third = RemoteInteractiveRunner('cpp', 'three')
            with self.assertRaisesRegex(RunnerUnavailable, 'busy'):
                await third.start()
            await third.stop()
            self.assertEqual(worker.active, 2)
            await first.write('done\r')
            self.assertIn(b'echo: done', b''.join([part async for part in first.output_chunks()]))
            self.assertEqual(FakeInteractiveRunner.instances[1].inputs, [])
            await first.stop(); await second.stop(); await self.idle(worker)
            self.assertTrue(all(fake.stopped for fake in FakeInteractiveRunner.instances))
            fresh = RemoteInteractiveRunner('python', 'fresh')
            await fresh.start(); await fresh.stop(); await self.idle(worker)

    async def test_oversized_unsupported_or_engine_options_are_rejected(self):
        async with self.worker():
            for extra in [{'source': 'é' * 40000}, {'language': 'bash'}, {'privileged': True}, {'volumes': ['/']}]:
                payload = {'type': 'run', 'mode': 'interactive', 'language': 'python', 'source': 'print(1)', **extra}
                with self.assertRaises(RunnerUnavailable):
                    await request(payload)
            self.assertEqual(FakeInteractiveRunner.instances, [])

    async def test_missing_image_fails_safely_and_releases_slot(self):
        async with self.worker() as (worker, _):
            FakeInteractiveRunner.failure = RunnerUnavailable('private runtime details')
            remote = RemoteInteractiveRunner('python', '')
            with self.assertRaisesRegex(RunnerUnavailable, 'runner images') as failure:
                await remote.start()
            self.assertNotIn('private', str(failure.exception))
            await remote.stop(); await self.idle(worker)
            self.assertTrue(FakeInteractiveRunner.instances[0].stopped)

    async def test_worker_timeout_and_output_limit_propagate(self):
        async with self.worker() as (worker, _):
            with patch('workspace.execution_worker.INTERACTIVE_TIMEOUT_SECONDS', 0.08):
                remote = RemoteInteractiveRunner('python', 'wait')
                await remote.start()
                with self.assertRaises(asyncio.TimeoutError):
                    _ = [part async for part in remote.output_chunks()]
                await remote.stop(); await self.idle(worker)
            remote = RemoteInteractiveRunner('python', 'flood')
            await remote.start()
            FakeInteractiveRunner.instances[-1].output_limited = True
            FakeInteractiveRunner.instances[-1].queue.put_nowait(None)
            _ = [part async for part in remote.output_chunks()]
            self.assertTrue(remote.output_limited)
            await remote.stop(); await self.idle(worker)

    async def test_worker_shutdown_cleans_sessions_and_restart_accepts_new_jobs(self):
        async with self.worker() as (worker, _):
            remote = RemoteInteractiveRunner('python', 'wait')
            await remote.start()
            await worker.close()
            with self.assertRaisesRegex(RunnerUnavailable, 'unavailable'):
                _ = [part async for part in remote.output_chunks()]
            await remote.stop()
            self.assertTrue(FakeInteractiveRunner.instances[-1].stopped)
            fresh = RemoteInteractiveRunner('python', 'fresh')
            await fresh.start(); await fresh.stop(); await self.idle(worker)

    async def test_disabled_and_missing_worker_never_fall_back_to_host_execution(self):
        with patch.dict(os.environ, {'CODE_EXECUTION_ENABLED': 'false'}), patch('asyncio.open_unix_connection') as connect:
            with self.assertRaisesRegex(RunnerUnavailable, 'not configured'):
                await RemoteInteractiveRunner('python', '').start()
            connect.assert_not_called()
        with patch.dict(os.environ, {'CODE_EXECUTION_ENABLED': 'true', 'CODE_WORKER_DIRECTORY': '/nonexistent'}):
            with self.assertRaisesRegex(RunnerUnavailable, 'worker unavailable'):
                await request({'type': 'health'})

    async def test_batch_response_preserves_stdout_stderr_and_flags(self):
        result = {'stdout': 'hello', 'stderr': 'error', 'exit_code': 1, 'timed_out': False, 'output_limited': False}
        async with self.worker() as (worker, _):
            with patch('workspace.execution_worker.run_program', return_value=result) as run:
                response = await request({'type': 'run', 'mode': 'batch', 'language': 'c', 'source': 'snapshot'})
                self.assertEqual(response, {'type': 'result', 'result': result})
                run.assert_called_once_with('c', 'snapshot')
            await self.idle(worker)

    def test_remote_dispatch_does_not_launch_local_process(self):
        from unittest.mock import AsyncMock
        with patch.dict(os.environ, {'CODE_RUNNER_TRANSPORT': 'unix'}), patch('workspace.worker_client.request', new_callable=AsyncMock, return_value={'type': 'result', 'result': {'stdout': 'ok'}}) as rpc, patch('workspace.runner.subprocess.Popen') as spawn:
            self.assertEqual(run_program('python', 'print(1)'), {'stdout': 'ok'})
            self.assertIsInstance(interactive_runner('python', ''), RemoteInteractiveRunner)
            spawn.assert_not_called()
            rpc.assert_awaited_once_with({'type': 'run', 'mode': 'batch', 'language': 'python', 'source': 'print(1)'})

    @patch('workspace.execution_worker.os.geteuid', return_value=0)
    def test_preflight_rejects_root(self, uid):
        with self.assertRaisesRegex(RuntimeError, 'unprivileged'):
            preflight()

    @patch('workspace.execution_worker.RUNNER_ENGINE', 'docker')
    def test_preflight_rejects_a_different_runtime(self):
        with self.assertRaisesRegex(RuntimeError, 'requires Podman'):
            preflight()

    @patch('workspace.execution_worker.os.geteuid', return_value=1000)
    @patch('workspace.execution_worker.subprocess.check_output')
    def test_preflight_rejects_rootful_and_missing_controllers(self, info, uid):
        import json
        for host in [
            {'security': {'rootless': False}, 'cgroupVersion': 'v2'},
            {'security': {'rootless': True}, 'cgroupVersion': 'v1'},
            {'security': {'rootless': True}, 'cgroupVersion': 'v2', 'cgroupControllers': ['memory']},
        ]:
            info.return_value = json.dumps({'host': host})
            with self.assertRaises(RuntimeError):
                preflight()

    async def test_invalid_input_terminates_only_its_session(self):
        async with self.worker() as (worker, _):
            remote = RemoteInteractiveRunner('python', 'wait')
            await remote.start()
            await remote._send({'type': 'input', 'data': 'x' * 4097})
            with self.assertRaisesRegex(RunnerUnavailable, 'input limit'):
                _ = [part async for part in remote.output_chunks()]
            await remote.stop(); await self.idle(worker)
            self.assertTrue(FakeInteractiveRunner.instances[-1].stopped)

    @patch('workspace.execution_worker.os.geteuid', return_value=1000)
    @patch('workspace.execution_worker.subprocess.check_output')
    @patch('workspace.execution_worker._ensure_image_available')
    @patch('workspace.execution_worker.run_program')
    def test_preflight_checks_only_runner_images_and_effective_limits(self, run, images, info, uid):
        import json
        from unittest.mock import call
        from workspace.runner import PYTHON_RUNNER_IMAGE, CPP_RUNNER_IMAGE
        info.return_value = json.dumps({'host': {'security': {'rootless': True},
            'cgroupVersion': 'v2', 'cgroupControllers': ['cpu', 'memory', 'pids']}})
        run.side_effect = [{'exit_code': 0, 'stdout': 'sandbox-ok\n'}, {'exit_code': 0}, {'exit_code': 0}]
        preflight()
        self.assertEqual(images.call_args_list, [call(PYTHON_RUNNER_IMAGE), call(CPP_RUNNER_IMAGE)])
        self.assertEqual([args.args[0] for args in run.call_args_list], ['python', 'c', 'cpp'])
        run.side_effect = [{'exit_code': 1, 'stdout': ''}]
        with self.assertRaisesRegex(RuntimeError, 'Sandbox verification failed'):
            preflight()

    async def test_cancelled_authentication_closes_the_private_socket(self):
        from unittest.mock import AsyncMock, Mock
        from workspace.worker_client import connect
        async with self.worker() as (_, directory):
            reader, writer = Mock(), Mock()
            writer.drain = AsyncMock()
            waiting = asyncio.Event()
            async def blocked_receive(*args):
                waiting.set()
                await asyncio.Future()
            with patch('workspace.worker_client.asyncio.open_unix_connection', new_callable=AsyncMock, return_value=(reader, writer)), patch('workspace.worker_client.receive', side_effect=blocked_receive):
                task = asyncio.create_task(connect())
                await waiting.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                writer.close.assert_called_once()
