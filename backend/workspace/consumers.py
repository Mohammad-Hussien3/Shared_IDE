import asyncio
import codecs
import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .execution import SUPPORTED_RUNNERS, detect_language
from .interactive_runner import INTERACTIVE_TIMEOUT_SECONDS, InteractiveRunner
from .models import File
from .runner import RunnerUnavailable


logger = logging.getLogger(__name__)


class TerminalConsumer(AsyncJsonWebsocketConsumer):
    """A WebSocket owns exactly one isolated program and its terminal input."""

    async def connect(self):
        self.runner = None
        self.run_task = None
        self.started = False
        self.ready = False
        self.disconnected = False
        self.stop_requested = False
        await self.accept()

    async def receive_json(self, content, **kwargs):
        if not isinstance(content, dict):
            await self._send({"type": "error", "message": "Invalid terminal message."})
            return

        event_type = content.get("type")
        if event_type == "start":
            if self.started:
                await self._send({"type": "error", "message": "This terminal session has already started."})
                return
            self.started = True
            self.run_task = asyncio.create_task(self._run_session())
        elif event_type == "input":
            if not self.ready or self.runner is None:
                return
            data = content.get("data")
            if not isinstance(data, str):
                await self._send({"type": "error", "message": "Terminal input must be text."})
                return
            try:
                await self.runner.write(data)
            except ValueError as exc:
                await self._send({"type": "error", "message": str(exc)})
        elif event_type == "resize":
            if self.runner is None:
                return
            cols, rows = content.get("cols"), content.get("rows")
            if type(cols) is int and type(rows) is int and 20 <= cols <= 500 and 5 <= rows <= 200:
                try:
                    self.runner.resize(cols, rows)
                except OSError:
                    pass
        elif event_type == "stop":
            self.stop_requested = True
            if self.runner is not None:
                await self.runner.stop()
        else:
            await self._send({"type": "error", "message": "Unknown terminal message."})

    async def disconnect(self, close_code):
        self.disconnected = True
        self.stop_requested = True
        if self.runner is not None:
            await self.runner.stop()
        if self.run_task is not None and not self.run_task.done():
            self.run_task.cancel()
            await asyncio.gather(self.run_task, return_exceptions=True)

    @database_sync_to_async
    def _saved_file(self):
        return File.objects.filter(
            pk=self.scope["url_route"]["kwargs"]["file_id"],
            workspace_id=self.scope["url_route"]["kwargs"]["workspace_id"],
        ).values("name", "content").first()

    async def _run_session(self):
        try:
            await asyncio.wait_for(self._execute_saved_file(), timeout=INTERACTIVE_TIMEOUT_SECONDS)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            await self._send({"type": "error", "message": "Execution timed out."})
            await self._send({"type": "finished", "reason": "timeout", "exit_code": None})
        except RunnerUnavailable as exc:
            await self._send({"type": "error", "message": str(exc)})
            await self._send({"type": "finished", "reason": "error", "exit_code": None})
        except Exception:
            logger.exception("Terminal session failed")
            await self._send({"type": "error", "message": "The terminal session failed."})
            await self._send({"type": "finished", "reason": "error", "exit_code": None})
        finally:
            self.ready = False
            if self.runner is not None:
                await self.runner.stop()
            if not self.disconnected:
                await self.close()

    async def _execute_saved_file(self):
        file = await self._saved_file()
        if file is None:
            raise RunnerUnavailable("File was not found in this workspace.")
        source = file["content"]
        if len(source) > 65536:
            raise RunnerUnavailable("The file is too large to run (64 KB maximum).")
        language, detection_error = detect_language(file["name"], source)
        if detection_error:
            raise RunnerUnavailable(detection_error)
        if language not in SUPPORTED_RUNNERS:
            raise RunnerUnavailable(f"There is no isolated runner for {language}.")
        if self.stop_requested:
            await self._send({"type": "finished", "reason": "stopped", "exit_code": None})
            return

        self.runner = InteractiveRunner(language, source)
        await self.runner.start()
        if self.stop_requested or self.runner.process is None:
            await self._send({"type": "finished", "reason": "stopped", "exit_code": None})
            return

        self.ready = True
        await self._send({"type": "ready", "language": language})
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        async for chunk in self.runner.output_chunks():
            text = decoder.decode(chunk)
            if text:
                await self._send({"type": "output", "data": text})
        tail = decoder.decode(b"", final=True)
        if tail:
            await self._send({"type": "output", "data": tail})

        if self.runner.output_limited:
            await self._send({"type": "error", "message": "Output limit reached."})
            await self._send({"type": "finished", "reason": "output_limit", "exit_code": None})
            return

        exit_code = await self.runner.process.wait()
        reason = "stopped" if self.stop_requested else "completed"
        await self._send({"type": "finished", "reason": reason, "exit_code": exit_code})

    async def _send(self, payload):
        if self.disconnected:
            return
        try:
            await self.send_json(payload)
        except (OSError, RuntimeError):
            self.disconnected = True
