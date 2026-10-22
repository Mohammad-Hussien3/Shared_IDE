"""Django-side client of the restricted host worker, never a container API."""
import asyncio
import base64
import os
from pathlib import Path

from .runner import MAX_OUTPUT_BYTES, RunnerUnavailable
from .worker_protocol import receive, send

UNAVAILABLE = 'Execution worker unavailable. Ask the administrator to check make runner-status.'


def enabled():
    return os.getenv('CODE_EXECUTION_ENABLED', 'false').lower() in {'true', '1', 'yes', 'on'}


async def connect():
    if not enabled():
        raise RunnerUnavailable('Code execution is not configured for this deployment.')
    writer = None
    try:
        directory = Path(os.environ.get('CODE_WORKER_DIRECTORY', '/run/shared-ide-worker'))
        token = (directory / 'token').read_text().strip()
        if len(token) < 32:
            raise ValueError('Invalid worker credential')
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(directory / 'worker.sock')), 3,
        )
        await send(writer, {'token': token})
        response = await asyncio.wait_for(receive(reader, 4096), 5)
        if response != {'type': 'authenticated'}:
            raise ValueError('Worker authentication failed')
        return reader, writer
    except asyncio.CancelledError:
        if writer:
            writer.close()
        raise
    except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError) as exc:
        if writer:
            writer.close()
        raise RunnerUnavailable(UNAVAILABLE) from exc


async def request(message, timeout=20):
    reader, writer = await connect()
    try:
        await send(writer, message)
        result = await asyncio.wait_for(receive(reader), timeout)
        if result.get('type') == 'error':
            raise RunnerUnavailable(result.get('message', UNAVAILABLE))
        return result
    except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError) as exc:
        raise RunnerUnavailable(UNAVAILABLE) from exc
    finally:
        writer.close()
        await writer.wait_closed()


class RemoteInteractiveRunner:
    """Same consumer interface as the existing PTY runner; one socket per run."""
    def __init__(self, language, source):
        self.language, self.source = language, source
        self.process = None
        self.output_limited = False
        self.reader = self.writer = None
        self.returncode = None
        self._stopped = False
        self._send_lock = asyncio.Lock()
        self._resize_task = None
        self._pending_size = None

    async def start(self):
        self.reader, self.writer = await connect()
        if self._stopped:
            self.writer.close()
            return
        try:
            await self._send({'type': 'run', 'mode': 'interactive',
                              'language': self.language, 'source': self.source})
            message = await asyncio.wait_for(receive(self.reader), 10)
            if message.get('type') != 'ready':
                raise RunnerUnavailable(message.get('message', UNAVAILABLE))
            self.process = self
        except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError) as exc:
            raise RunnerUnavailable(UNAVAILABLE) from exc

    async def _send(self, message):
        async with self._send_lock:
            if self.writer and not self._stopped:
                try:
                    await send(self.writer, message)
                except (OSError, asyncio.TimeoutError) as exc:
                    raise RunnerUnavailable(UNAVAILABLE) from exc

    async def output_chunks(self):
        count = 0
        try:
            while not self._stopped:
                message = await receive(self.reader)
                if message.get('type') == 'output':
                    chunk = base64.b64decode(message['data'], validate=True)
                    count += len(chunk)
                    if count > MAX_OUTPUT_BYTES:
                        raise ValueError('Invalid output size')
                    yield chunk
                elif message.get('type') == 'finished':
                    self.returncode = message.get('exit_code')
                    self.output_limited = bool(message.get('output_limited'))
                    if message.get('timed_out'):
                        raise asyncio.TimeoutError()
                    return
                else:
                    raise RunnerUnavailable(message.get('message', UNAVAILABLE))
        except asyncio.TimeoutError:
            raise
        except asyncio.IncompleteReadError as exc:
            if not self._stopped:
                raise RunnerUnavailable(UNAVAILABLE) from exc
        except (OSError, ValueError, KeyError) as exc:
            raise RunnerUnavailable(UNAVAILABLE) from exc

    async def wait(self):
        return self.returncode

    async def write(self, text):
        if len(text.encode()) > 4096:
            raise ValueError('Terminal input limit reached.')
        await self._send({'type': 'input', 'data': text})

    def resize(self, cols, rows):
        self._pending_size = (cols, rows)
        if self._resize_task is None or self._resize_task.done():
            self._resize_task = asyncio.create_task(self._resize())

    async def _resize(self):
        try:
            while self._pending_size:
                cols, rows = self._pending_size
                self._pending_size = None
                await self._send({'type': 'resize', 'cols': cols, 'rows': rows})
        except RunnerUnavailable:
            # The read side reports connection loss to the existing output panel.
            pass

    async def stop(self):
        self._stopped = True
        if self._resize_task:
            self._resize_task.cancel()
            await asyncio.gather(self._resize_task, return_exceptions=True)
        if self.writer:
            self.writer.close()  # EOF always terminates this socket's container.
            try:
                await self.writer.wait_closed()
            except OSError:
                pass


def interactive_runner(language, source):
    transport = os.getenv('CODE_RUNNER_TRANSPORT', 'local')
    if transport == 'unix':
        return RemoteInteractiveRunner(language, source)
    if transport != 'local':
        raise RunnerUnavailable('Invalid execution transport configuration.')
    from .interactive_runner import InteractiveRunner
    return InteractiveRunner(language, source)
