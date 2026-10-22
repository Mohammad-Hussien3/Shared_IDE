import asyncio
import base64
import errno
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from django.test import SimpleTestCase
from workspace import runner
from workspace.interactive_runner import InteractiveRunner, MAX_INPUT_BYTES, MAX_INPUT_CHUNK_BYTES


class RunnerEnvironmentMixin:
    def setUp(self):
        super().setUp()
        self.enterContext(patch.dict('os.environ', {'CODE_EXECUTION_ENABLED': 'true'}))
        self.enterContext(patch.multiple(runner, RUNNER_ENGINE='podman', RUNNER_PULL_POLICY='never'))


class RunnerCommandTests(RunnerEnvironmentMixin, SimpleTestCase):
    def test_security_limits_and_no_host_mounts_for_each_language(self):
        for language in ['python', 'c', 'cpp']:
            with self.subTest(language=language):
                command, image = runner.build_runner_command(language, 'source', 'test')
                for option in ['--rm', '--timeout=65', '--log-driver=none', '--pull=never', '--network=none', '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges', '--user=65534:65534', '--cpus=0.5', '--pids-limit=32', '--ulimit=cpu=5:5']:
                    self.assertIn(option, command)
                self.assertTrue(any(arg.startswith('--memory=') for arg in command))
                self.assertFalse(any(arg.startswith(('--volume', '--privileged')) for arg in command))
                self.assertNotIn('sudo', command)
                self.assertIn(image, command)

    def test_python_source_is_a_single_argument_and_interactive_is_unbuffered(self):
        source = 'print("$(do_not_run)")'
        command, _ = runner.build_runner_command('python', source, 'test', interactive=True)
        self.assertEqual(command[-4:], ['python', '-u', '-c', source])
        self.assertIn('--interactive', command)
        self.assertIn('--tty', command)

    def test_compiled_sources_are_encoded_and_compiler_matches_language(self):
        source = '"; $(untrusted); \n café'
        for language, compiler, filename in [('c', 'gcc -std=c17', 'main.c'), ('cpp', 'g++ -std=c++17', 'main.cpp')]:
            command, _ = runner.build_runner_command(language, source, 'test')
            self.assertIn(base64.b64encode(source.encode()).decode(), command[-1])
            self.assertIn(compiler, command[-1])
            self.assertIn('/work/' + filename, command[-1])
            self.assertNotIn(source, command[-1])

    def test_unsupported_language_is_rejected(self):
        with self.assertRaises(runner.RunnerUnavailable):
            runner.build_runner_command('javascript', '', 'test')


class ImageAvailabilityTests(RunnerEnvironmentMixin, SimpleTestCase):
    @patch('workspace.runner.shutil.which', return_value=None)
    @patch('workspace.runner.subprocess.run')
    def test_missing_runtime_is_actionable(self, run, which):
        with self.assertRaisesRegex(runner.RunnerUnavailable, 'PATH'):
            runner._ensure_image_available('image')
        run.assert_not_called()

    @patch('workspace.runner.shutil.which', return_value='/usr/bin/podman')
    @patch('workspace.runner.subprocess.run')
    def test_installed_image_does_not_pull_or_switch_users(self, run, which):
        run.return_value = SimpleNamespace(returncode=0)
        runner._ensure_image_available('image')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], [runner.RUNNER_ENGINE, 'image', 'exists', 'image'])

    @patch('workspace.runner.shutil.which', return_value='/usr/bin/podman')
    @patch('workspace.runner.os.geteuid', return_value=1000)
    @patch('workspace.runner.subprocess.run')
    def test_missing_image_identifies_user_store_and_setup_command(self, run, uid, which):
        run.side_effect = [SimpleNamespace(returncode=1, stderr=''), SimpleNamespace(returncode=0, stdout='/rootless/store', stderr='')]
        with self.assertRaisesRegex(runner.RunnerUnavailable, 'uid 1000, store /rootless/store') as error:
            runner._ensure_image_available('image')
        self.assertIn('podman pull image', str(error.exception))
        self.assertEqual(run.call_count, 2)

    @patch('workspace.runner.shutil.which', return_value='/usr/bin/podman')
    @patch('workspace.runner.subprocess.run')
    def test_runtime_query_timeout_and_access_failure(self, run, which):
        run.side_effect = subprocess.TimeoutExpired('podman', 5)
        with self.assertRaisesRegex(runner.RunnerUnavailable, 'Could not query'):
            runner._ensure_image_available('image')
        run.side_effect = [SimpleNamespace(returncode=125, stderr='permission denied'), OSError('store unavailable')]
        with self.assertRaisesRegex(runner.RunnerUnavailable, 'permission denied'):
            runner._ensure_image_available('image')


class FakeSelector:
    def __init__(self): self.streams = {}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def register(self, stream, events, label): self.streams[stream.fileno()] = SimpleNamespace(fileobj=stream, data=label)
    def unregister(self, stream): self.streams.pop(stream.fileno())
    def get_map(self): return self.streams
    def select(self, timeout): return [(key, 1) for key in list(self.streams.values())]


class CollectedExecutionTests(SimpleTestCase):
    def setUp(self):
        self.process = Mock(returncode=0)
        self.process.stdout.fileno.return_value = 10
        self.process.stderr.fileno.return_value = 11
        self.process.poll.return_value = 0
        for target, options in [
            ('_ensure_image_available', {}), ('subprocess.Popen', {'return_value': self.process}),
            ('selectors.DefaultSelector', {'side_effect': FakeSelector}), ('os.set_blocking', {}),
            ('subprocess.run', {}), ('os.read', {'side_effect': [b'hello\n', b'error\n', b'', b'']}),
        ]:
            patcher = patch('workspace.runner.' + target, **options)
            setattr(self, target.split('.')[-1], patcher.start())
            self.addCleanup(patcher.stop)

    def test_collects_stdout_stderr_exit_code_without_live_process(self):
        result = runner.run_program('python', 'print(1)')
        self.assertEqual(result, {'stdout': 'hello\n', 'stderr': 'error\n', 'exit_code': 0, 'timed_out': False, 'output_limited': False})
        self.Popen.assert_called_once()
        self.run.assert_not_called()

    def test_spawn_failure(self):
        self.Popen.side_effect = OSError('cannot spawn')
        with self.assertRaisesRegex(runner.RunnerUnavailable, 'cannot spawn'):
            runner.run_program('python', '')

    def test_timeout_kills_container_and_process_if_wait_hangs(self):
        self.process.poll.return_value = None
        self.process.wait.side_effect = [subprocess.TimeoutExpired('podman', 2), None]
        with patch('workspace.runner.time.monotonic', side_effect=[0, 100]):
            result = runner.run_program('python', '')
        self.assertTrue(result['timed_out'])
        self.assertIn('timed out', result['stderr'])
        self.assertEqual(self.run.call_args.args[0][1], 'kill')
        self.process.kill.assert_called_once()

    def test_output_limit_is_shared_between_stdout_and_stderr(self):
        self.read.side_effect = [b'abc', b'def']
        with patch('workspace.runner.MAX_OUTPUT_BYTES', 4):
            result = runner.run_program('python', '')
        self.assertEqual(result['stdout'], 'abc')
        self.assertTrue(result['stderr'].startswith('d\n'))
        self.assertTrue(result['output_limited'])
        self.assertEqual(self.run.call_args.args[0][1], 'kill')

    def test_runtime_launch_error_and_invalid_utf8(self):
        self.process.returncode = 125
        self.read.side_effect = [b'', b'Error: image not known', b'']
        with self.assertRaisesRegex(runner.RunnerUnavailable, 'pull'):
            runner.run_program('python', '')
        self.process.returncode = 1
        self.read.side_effect = [b'\xff', b'', b'']
        result = runner.run_program('python', '')
        self.assertEqual(result['stdout'], '\ufffd')
        self.assertEqual(result['exit_code'], 1)

    @patch('workspace.runner.run_program')
    def test_legacy_python_entrypoint(self, run):
        runner.run_python('source')
        run.assert_called_once_with('python', 'source')


class InteractiveRunnerTests(SimpleTestCase):
    async def test_start_uses_private_pty_and_closes_slave(self):
        session = InteractiveRunner('python', 'print(1)')
        process = Mock(returncode=0)
        loop = asyncio.get_running_loop()
        with patch('workspace.interactive_runner._ensure_image_available'), patch('workspace.interactive_runner.pty.openpty', return_value=(10, 11)), patch('workspace.interactive_runner.os.set_blocking'), patch('workspace.interactive_runner.os.close') as close, patch('workspace.interactive_runner.asyncio.create_subprocess_exec', new_callable=AsyncMock, return_value=process) as spawn, patch.object(loop, 'add_reader'), patch.object(loop, 'remove_reader'), patch.object(session, '_podman_cleanup'):
            await session.start()
            self.assertEqual(spawn.call_args.kwargs['stdin'], 11)
            self.assertEqual(spawn.call_args.kwargs['stdout'], 11)
            self.assertEqual(spawn.call_args.kwargs['stderr'], 11)
            close.assert_called_once_with(11)
            await session.stop()
            close.assert_any_call(10)
            self.assertIsNone(session.master_fd)

    async def test_failed_start_closes_both_pty_descriptors(self):
        session = InteractiveRunner('python', '')
        with patch('workspace.interactive_runner._ensure_image_available'), patch('workspace.interactive_runner.pty.openpty', return_value=(10, 11)), patch('workspace.interactive_runner.os.set_blocking'), patch('workspace.interactive_runner.os.close') as close, patch('workspace.interactive_runner.asyncio.create_subprocess_exec', new_callable=AsyncMock, side_effect=OSError('failed')):
            with self.assertRaises(runner.RunnerUnavailable): await session.start()
            self.assertEqual({call.args[0] for call in close.call_args_list}, {10, 11})

    async def test_input_partial_writes_and_limits_count_utf8_bytes(self):
        session = InteractiveRunner('python', '')
        session.master_fd = 10
        with patch('workspace.interactive_runner.os.write', side_effect=[BlockingIOError(), 1, 2]) as write:
            await session.write('abc')
            self.assertEqual(write.call_args.args, (10, b'bc'))
        for text in ['é' * MAX_INPUT_CHUNK_BYTES, 'a' * (MAX_INPUT_CHUNK_BYTES + 1)]:
            with self.assertRaisesRegex(ValueError, 'limit'): await session.write(text)
        session._input_bytes = MAX_INPUT_BYTES
        with self.assertRaises(ValueError): await session.write('a')

    async def test_output_limit_eof_and_eio_finish_stream(self):
        for chunk in [b'abcdef', b'', OSError(errno.EIO, 'pty closed')]:
            session = InteractiveRunner('python', '')
            with patch('workspace.interactive_runner.MAX_OUTPUT_BYTES', 4), patch('workspace.interactive_runner.os.read', side_effect=chunk if isinstance(chunk, Exception) else None, return_value=chunk):
                session._read_ready()
            output = [part async for part in session.output_chunks()]
            self.assertEqual(output, [b'abcd'] if chunk == b'abcdef' else [])
            self.assertEqual(session.output_limited, chunk == b'abcdef')

    async def test_stop_is_idempotent_and_forces_process_exit_after_timeout(self):
        session = InteractiveRunner('python', '')
        session.process = Mock(returncode=None)
        session.process.wait = AsyncMock(side_effect=[asyncio.TimeoutError(), 0])
        with patch.object(session, '_podman_cleanup') as cleanup:
            await session.stop()
            await session.stop()
        self.assertEqual([call.args for call in cleanup.call_args_list], [('kill',), ('rm', '-f')])
        session.process.kill.assert_called_once()

    async def test_resize_packs_rows_before_columns(self):
        import struct
        session = InteractiveRunner('c', '')
        session.master_fd = 10
        with patch('workspace.interactive_runner.fcntl.ioctl') as ioctl:
            session.resize(80, 24)
            self.assertEqual(ioctl.call_args.args[2], struct.pack('HHHH', 24, 80, 0, 0))
