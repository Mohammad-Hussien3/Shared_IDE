import asyncio
import errno
import fcntl
import os
import pty
import struct
import subprocess
import termios
import uuid

from .runner import (
    MAX_OUTPUT_BYTES,
    RUNNER_ENGINE,
    RunnerUnavailable,
    _ensure_image_available,
    build_runner_command,
)


INTERACTIVE_TIMEOUT_SECONDS = 60
MAX_INPUT_BYTES = 64 * 1024
MAX_INPUT_CHUNK_BYTES = 4096


class InteractiveRunner:
    """One Podman process attached to one private PTY and WebSocket."""

    def __init__(self, language, source):
        self.name = f"workspace-terminal-{uuid.uuid4().hex}"
        self.command, self.image = build_runner_command(
            language, source, self.name, interactive=True
        )
        self.process = None
        self.master_fd = None
        self.output_limited = False
        self._output_bytes = 0
        self._input_bytes = 0
        self._output = asyncio.Queue()
        self._reader_closed = False
        self._stopping = False
        self._stopped = False
        self._stop_lock = asyncio.Lock()

    async def start(self):
        await asyncio.to_thread(_ensure_image_available, self.image)
        async with self._stop_lock:
            if self._stopping:
                return

            master_fd, slave_fd = pty.openpty()
            os.set_blocking(master_fd, False)
            try:
                self.process = await asyncio.create_subprocess_exec(
                    *self.command,
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    start_new_session=True,
                )
            except OSError as exc:
                os.close(master_fd)
                raise RunnerUnavailable(f"Could not start the isolated runner: {exc}") from exc
            except BaseException:
                os.close(master_fd)
                raise
            finally:
                os.close(slave_fd)

            self.master_fd = master_fd
            asyncio.get_running_loop().add_reader(master_fd, self._read_ready)

    def _finish_output(self):
        if self._reader_closed:
            return
        self._reader_closed = True
        if self.master_fd is not None:
            asyncio.get_running_loop().remove_reader(self.master_fd)
        self._output.put_nowait(None)

    def _read_ready(self):
        try:
            chunk = os.read(self.master_fd, 4096)
        except BlockingIOError:
            return
        except OSError as exc:
            if exc.errno != errno.EIO:
                self._output.put_nowait(str(exc).encode("utf-8"))
            chunk = b""

        if not chunk:
            self._finish_output()
            return

        remaining = MAX_OUTPUT_BYTES - self._output_bytes
        if remaining > 0:
            self._output.put_nowait(chunk[:remaining])
            self._output_bytes += min(len(chunk), remaining)
        if len(chunk) > remaining:
            self.output_limited = True
            self._finish_output()

    async def output_chunks(self):
        while True:
            chunk = await self._output.get()
            if chunk is None:
                return
            yield chunk

    async def write(self, text):
        data = text.encode("utf-8")
        if len(data) > MAX_INPUT_CHUNK_BYTES or self._input_bytes + len(data) > MAX_INPUT_BYTES:
            raise ValueError("Terminal input limit reached.")
        if self.master_fd is None or self._reader_closed or self._stopping:
            return
        self._input_bytes += len(data)
        while data:
            try:
                written = os.write(self.master_fd, data)
                data = data[written:]
            except BlockingIOError:
                await asyncio.sleep(0.01)
            except OSError:
                return

    def resize(self, cols, rows):
        if self.master_fd is None or self._reader_closed:
            return
        fcntl.ioctl(
            self.master_fd,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", rows, cols, 0, 0),
        )

    async def stop(self):
        self._stopping = True
        async with self._stop_lock:
            if self._stopped:
                return
            if self.process is not None and self.process.returncode is None:
                await asyncio.to_thread(self._podman_cleanup, "kill")
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=2)
                except asyncio.TimeoutError:
                    self.process.kill()
                    await self.process.wait()
            await asyncio.to_thread(self._podman_cleanup, "rm", "-f")
            self._finish_output()
            if self.master_fd is not None:
                os.close(self.master_fd)
                self.master_fd = None
            self._stopped = True

    def _podman_cleanup(self, action, *extra):
        try:
            subprocess.run(
                [RUNNER_ENGINE, action, *extra, self.name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
