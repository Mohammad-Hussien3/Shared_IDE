import asyncio
import codecs
import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.core.exceptions import ValidationError
from django.db import transaction
from redis.exceptions import RedisError
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.exceptions import TokenError

from accounts.authentication import authenticate_access_token
from Shared_IDE.monitoring import capture_unexpected

from .execution import SUPPORTED_RUNNERS, detect_language, has_filename_extension
from .interactive_runner import INTERACTIVE_TIMEOUT_SECONDS, InteractiveRunner
from .models import File
from .sharing import permission_for
from .runner import RunnerUnavailable


logger = logging.getLogger(__name__)
AUTH_TIMEOUT_SECONDS = 5
SESSION_CHECK_SECONDS = 1


class TerminalConsumer(AsyncJsonWebsocketConsumer):
    """A WebSocket owns exactly one isolated program and its terminal input."""

    async def __call__(self, scope, receive, send):
        try:
            return await super().__call__(scope, receive, send)
        finally:
            # A failed channel-layer receive bypasses the normal disconnect
            # event. It must still stop this socket's private program and tasks.
            if hasattr(self, 'disconnected'):
                await self.disconnect(1006)

    async def connect(self):
        self.runner = None
        self.run_task = None
        self.started = False
        self.ready = False
        self.disconnected = False
        self.stop_requested = False
        self.user = None
        self.access_token = None
        self.auth_task = None
        self.denied = False
        await self.accept()
        self.auth_task = asyncio.create_task(self._authentication_deadline())

    async def _authentication_deadline(self):
        await asyncio.sleep(AUTH_TIMEOUT_SECONDS)
        if self.user is None:
            self.denied = True
            await self.close(code=4401)

    @database_sync_to_async
    def _authenticate(self, token):
        return authenticate_access_token(token)

    async def _check_access(self):
        try:
            await self._authenticate(self.access_token)
            return await self._saved_file() is not None
        except (AuthenticationFailed, TokenError, ValueError, ValidationError):
            return False
        except Exception as exc:
            capture_unexpected(exc, 'websocket')
            logger.exception('Could not verify terminal access')
            return False

    async def _reject(self, code):
        self.denied = True
        if self.auth_task:
            self.auth_task.cancel()
        await self.close(code=code)

    async def _watch_session(self):
        while not self.disconnected:
            await asyncio.sleep(SESSION_CHECK_SECONDS)
            if not await self._check_access():
                await self._send({'type': 'error', 'message': 'Session expired or access revoked. Please log in again.'})
                await self.disconnect(4401)
                await self.close(code=4401)
                return

    async def receive_json(self, content, **kwargs):
        if self.denied:
            return
        if self.user is None:
            if not isinstance(content, dict) or content.get('type') != 'authenticate':
                await self._reject(4401)
                return
            token = content.get('token')
            if not isinstance(token, str) or len(token) > 4096:
                await self._reject(4401)
                return
            try:
                self.user, _ = await self._authenticate(token)
                if await self._saved_file() is None:
                    await self._reject(4404)
                    return
            except (AuthenticationFailed, TokenError, ValueError, ValidationError):
                await self._reject(4401)
                return
            self.access_token = token
            self.auth_task.cancel()
            self.auth_task = asyncio.create_task(self._watch_session())
            await self._after_authenticate()
            await self._send({'type': 'authenticated'})
            return
        if not isinstance(content, dict):
            await self._send({"type": "error", "message": "Invalid terminal message."})
            return

        event_type = content.get("type")
        if not await self._check_access():
            await self.disconnect(4401)
            await self.close(code=4401)
            return
        if event_type == "start":
            if self.started:
                await self._send({"type": "error", "message": "This terminal session has already started."})
                return
            self.started = True
            # Copy saved source at the accepted start event, never retain a live
            # model or write execution results back over a newer document.
            snapshot = await self._saved_file()
            self.requested_language = content.get('language')
            self.run_task = asyncio.create_task(self._run_session(snapshot))
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
        if self.auth_task is not None and self.auth_task is not asyncio.current_task():
            self.auth_task.cancel()
            await asyncio.gather(self.auth_task, return_exceptions=True)
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
            workspace__owner=self.user,
        ).values("name", "content").first()

    async def _after_authenticate(self):
        pass

    def _detect_language(self, file):
        return detect_language(file['name'], file['content'])

    async def _run_session(self, snapshot=None):
        try:
            await asyncio.wait_for(self._execute_saved_file(snapshot), timeout=INTERACTIVE_TIMEOUT_SECONDS)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            await self._send({"type": "error", "message": "Execution timed out."})
            await self._send({"type": "finished", "reason": "timeout", "exit_code": None})
        except RunnerUnavailable as exc:
            if self.runner is not None:
                capture_unexpected(exc, 'runner')
            await self._send({"type": "error", "message": str(exc)})
            await self._send({"type": "finished", "reason": "error", "exit_code": None})
        except Exception as exc:
            capture_unexpected(exc, 'websocket')
            logger.exception("Terminal session failed")
            await self._send({"type": "error", "message": "The terminal session failed."})
            await self._send({"type": "finished", "reason": "error", "exit_code": None})
        finally:
            self.ready = False
            if self.runner is not None:
                try:
                    await self.runner.stop()
                except Exception as exc:
                    capture_unexpected(exc, 'runner')
                    raise
            if not self.disconnected:
                await self.close()

    async def _execute_saved_file(self, file):
        if file is None:
            raise RunnerUnavailable("File was not found in this workspace.")
        source = file["content"]
        if len(source) > 65536:
            raise RunnerUnavailable("The file is too large to run (64 KB maximum).")
        language, detection_error = self._detect_language(file)
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
        await self._send({"type": "ready", "language": language,
                          **({'revision': file['revision']} if 'revision' in file else {})})
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


class SharedTerminalConsumer(TerminalConsumer):
    """A private run of a saved shared document, never the owner's terminal.

    Only the owner and accepted editors may run. Authorization uses the same
    File row lock as CRDT writes and membership changes when copying a snapshot.
    The inherited runner retains every sandbox limit and enabled/disabled gate.
    """

    @database_sync_to_async
    def _saved_file(self):
        with transaction.atomic():
            file = File.objects.select_for_update(of=('self',)).select_related(
                'workspace__owner',
            ).filter(pk=self.scope['url_route']['kwargs']['file_id'], document__isnull=False).first()
            if file is None or permission_for(file, self.user) not in ('owner', 'edit'):
                return None
            # Read after obtaining the File lock, in a separate query: a JOIN
            # evaluated before a concurrent commit could pair new content with
            # an older revision under PostgreSQL READ COMMITTED isolation.
            return {'name': file.name, 'content': file.content, 'revision': file.document.revision}

    def _detect_language(self, file):
        language, error = super()._detect_language(file)
        # Explicit choice is only a fallback for ambiguous extensionless code;
        # it cannot override a filename or a confidently detected language.
        choice = getattr(self, 'requested_language', None)
        if error and not has_filename_extension(file['name']) and isinstance(choice, str) and choice in SUPPORTED_RUNNERS:
            return choice, None
        return language, error

    async def _after_authenticate(self):
        from .collaboration import room
        self.execution_group = room(self.scope['url_route']['kwargs']['file_id']) + '.runs'
        await self.channel_layer.group_add(self.execution_group, self.channel_name)
        # Close the gap between initial authorization and joining notifications.
        if not await self._check_access():
            await self.disconnect(4403)
            await self.close(code=4403)

    async def execution_access_changed(self, event):
        if not self.disconnected and not await self._check_access():
            await self._send({'type': 'error', 'message': 'Your access to this file has changed.'})
            await self.disconnect(4403)
            await self.close(code=4403)

    async def disconnect(self, close_code):
        try:
            group = getattr(self, 'execution_group', None)
            self.execution_group = None
            if group:
                await asyncio.wait_for(self.channel_layer.group_discard(group, self.channel_name), timeout=5)
        except (RedisError, asyncio.TimeoutError) as exc:
            capture_unexpected(exc, 'websocket')
            logger.warning('Terminal membership cleanup could not reach Redis.')
        finally:
            await super().disconnect(close_code)
