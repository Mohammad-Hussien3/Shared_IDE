"""Rootless host worker. Only fixed Python/C/C++ jobs, never arbitrary engine calls.

Run via scripts/runner-service.py. This module deliberately does not import
Django, load its .env, connect to PostgreSQL, or receive user JWTs.
"""
import argparse
import asyncio
import base64
import fcntl
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import signal
import subprocess

from .interactive_runner import InteractiveRunner, INTERACTIVE_TIMEOUT_SECONDS
from .runner import (RunnerUnavailable, run_program, _ensure_image_available,
                     PYTHON_RUNNER_IMAGE, CPP_RUNNER_IMAGE, RUNNER_ENGINE, RUNNER_PULL_POLICY)
from .worker_protocol import receive, send

logger = logging.getLogger(__name__)


class Worker:
    def __init__(self, token, capacity=2):
        if len(token) < 32 or not 1 <= capacity <= 8:
            raise ValueError('Invalid worker configuration.')
        self.token, self.capacity = token, capacity
        self.active = 0
        self.connections = set()

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        if len(self.connections) >= 32:
            writer.close()
            return
        self.connections.add(task)
        acquired = False
        try:
            auth = await asyncio.wait_for(receive(reader, 4096), 5)
            token = auth.get('token')
            if not isinstance(token, str) or not hmac.compare_digest(token, self.token):
                return
            await send(writer, {'type': 'authenticated'})
            message = await asyncio.wait_for(receive(reader), 5)
            if message.get('type') == 'health':
                await send(writer, {'type': 'healthy', 'active': self.active,
                                    'capacity': self.capacity})
                return
            if (message.get('type') != 'run' or message.get('mode') not in {'batch', 'interactive'}
                    or message.get('language') not in {'python', 'c', 'cpp'}
                    or not isinstance(message.get('source'), str)
                    or len(message['source'].encode()) > 65536
                    or set(message) != {'type', 'mode', 'language', 'source'}):
                raise ValueError('Invalid execution request.')
            if self.active >= self.capacity:
                await send(writer, {'type': 'error', 'message': 'Execution worker is busy. Try again shortly.'})
                return
            # No await between checking and acquiring: one event loop, no queue.
            self.active += 1
            acquired = True
            if message['mode'] == 'batch':
                # Keep the slot until the bounded local process has actually ended,
                # even if this connection or the worker is being shut down.
                job = asyncio.create_task(asyncio.to_thread(run_program, message['language'], message['source']))
                try:
                    result = await asyncio.shield(job)
                except asyncio.CancelledError:
                    await job
                    raise
                await send(writer, {'type': 'result', 'result': result})
            else:
                await self.interactive(reader, writer, message)
        except (asyncio.IncompleteReadError, ConnectionError, BrokenPipeError):
            pass
        except asyncio.CancelledError:
            raise
        except (ValueError, UnicodeError):
            await self.error(writer, 'Invalid execution request or terminal input limit exceeded.')
        except asyncio.TimeoutError:
            await self.error(writer, 'Execution worker request timed out.')
        except RunnerUnavailable:
            logger.warning('Runner unavailable; check worker images and runtime (no payload logged).')
            await self.error(writer, 'Isolated runner unavailable. Ask the administrator to check runner images and worker health.')
        except Exception as exc:
            # Never log exception messages/tracebacks: subprocess exceptions may
            # embed commands containing source. No Sentry SDK runs in this worker.
            logger.error('Worker infrastructure failure: %s', type(exc).__name__)
            await self.error(writer, 'Execution worker failed. Please try again.')
        finally:
            if acquired:
                self.active -= 1
            self.connections.discard(task)
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass

    async def error(self, writer, message):
        try:
            await send(writer, {'type': 'error', 'message': message})
        except (OSError, asyncio.TimeoutError):
            pass

    async def interactive(self, reader, writer, message):
        runner = InteractiveRunner(message['language'], message['source'])
        tasks = []
        try:
            async with asyncio.timeout(INTERACTIVE_TIMEOUT_SECONDS):
                await runner.start()
                await send(writer, {'type': 'ready'})

                async def output():
                    async for chunk in runner.output_chunks():
                        await send(writer, {'type': 'output', 'data': base64.b64encode(chunk).decode()})
                    if runner.output_limited:
                        await runner.stop()
                    code = await runner.process.wait()
                    if code == 125 and not runner.output_limited:
                        raise RunnerUnavailable('Container startup failed')
                    return code

                async def inputs():
                    while True:
                        event = await receive(reader, 32768)
                        if event.get('type') == 'input' and isinstance(event.get('data'), str):
                            await runner.write(event['data'])
                        elif (event.get('type') == 'resize' and type(event.get('cols')) is int
                              and type(event.get('rows')) is int
                              and 20 <= event['cols'] <= 500 and 5 <= event['rows'] <= 200):
                            runner.resize(event['cols'], event['rows'])
                        else:
                            raise ValueError('Invalid terminal event')

                tasks = [asyncio.create_task(output()), asyncio.create_task(inputs())]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                # EOF/invalid input must terminate the runner, not leave an orphan.
                if tasks[1] in done:
                    await tasks[1]
                code = await tasks[0]
                await send(writer, {'type': 'finished', 'exit_code': code,
                                    'output_limited': runner.output_limited, 'timed_out': False})
        except asyncio.TimeoutError:
            await send(writer, {'type': 'finished', 'exit_code': None,
                                'output_limited': False, 'timed_out': True})
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await runner.stop()

    async def close(self):
        tasks = list(self.connections)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def preflight():
    """Fail closed unless the host actually enforces the configured sandbox."""
    if RUNNER_ENGINE != 'podman' or RUNNER_PULL_POLICY != 'never':
        raise RuntimeError('Worker requires Podman with pull policy never.')
    if os.geteuid() == 0:
        raise RuntimeError('The execution worker must run as an unprivileged Linux user.')
    info = json.loads(subprocess.check_output(['podman', 'info', '--format=json'], timeout=15))
    host = info['host']
    if not host['security']['rootless'] or host['cgroupVersion'] != 'v2':
        raise RuntimeError('Rootless Podman with cgroup v2 is required.')
    if not {'cpu', 'memory', 'pids'} <= set(host['cgroupControllers']):
        raise RuntimeError('Delegate cpu, memory and pids cgroup controllers to the worker user.')
    for image in (PYTHON_RUNNER_IMAGE, CPP_RUNNER_IMAGE):
        _ensure_image_available(image)
    probe = '''import os, pathlib, socket
assert os.getuid() == 65534
root = pathlib.Path('/sys/fs/cgroup')
assert int((root/'memory.max').read_text()) == 134217728
assert int((root/'memory.swap.max').read_text()) == 0
assert int((root/'pids.max').read_text()) == 32
quota, period = map(int, (root/'cpu.max').read_text().split())
assert quota / period == 0.5
status = pathlib.Path('/proc/self/status').read_text()
assert 'CapEff:\\t0000000000000000' in status and 'NoNewPrivs:\\t1' in status
assert 'Seccomp:\\t2' in status
assert not pathlib.Path('/app').exists()
try:
    pathlib.Path('/etc/worker-write-probe').write_text('no')
except OSError:
    pass
else:
    raise AssertionError('writable root filesystem')
assert [name for _, name in socket.if_nameindex()] == ['lo']
print('sandbox-ok')
'''
    result = run_program('python', probe)
    if result['exit_code'] != 0 or result['stdout'].strip() != 'sandbox-ok':
        raise RuntimeError('Sandbox verification failed; required isolation/limits are not effective.')
    for language, source in [('c', 'int main(void) {return 0;}'), ('cpp', 'int main() {return 0;}')]:
        if run_program(language, source)['exit_code'] != 0:
            raise RuntimeError(f'{language} compiler sandbox verification failed.')


def cleanup(label):
    """Only containers belonging to this worker installation, including crash leftovers."""
    result = subprocess.run(['podman', 'ps', '-aq', '--filter', f'label=shared-ide-worker={label}'],
                            capture_output=True, text=True, timeout=10, check=True)
    ids = result.stdout.split()
    if ids:
        subprocess.run(['podman', 'rm', '-f', *ids], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=15, check=True)


async def serve(directory, capacity):
    worker = Worker((directory / 'token').read_text().strip(), capacity)
    path = directory / 'worker.sock'
    path.unlink(missing_ok=True)
    server = await asyncio.start_unix_server(worker.handle, path=str(path), backlog=16)
    path.chmod(0o660)
    stopped = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, stopped.set)
    try:
        async with server:
            logger.info('Execution worker ready (private Unix socket, capacity=%s).', capacity)
            await stopped.wait()
    finally:
        server.close()
        await server.wait_closed()
        await worker.close()
        path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--capacity', type=int, default=2, choices=range(1, 9))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    # Fixed runtime and no recursive remote dispatch. No env inherited from Django.
    os.environ.update(CODE_EXECUTION_ENABLED='true', CODE_RUNNER_TRANSPORT='local')
    directory = args.directory.resolve()
    label = hashlib.sha256(str(directory).encode()).hexdigest()[:20]
    os.environ['CODE_RUNNER_LABEL'] = label
    # Serializes startup/cleanup so a second worker cannot kill active sessions.
    with (directory / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            cleanup(label)
            preflight()
            asyncio.run(serve(directory, args.capacity))
        except Exception as exc:
            logger.error('Worker startup/shutdown failed (%s). Run make runner-check; see EXECUTION.md.', type(exc).__name__)
            raise SystemExit(1) from None
        finally:
            cleanup(label)


if __name__ == '__main__':
    main()
