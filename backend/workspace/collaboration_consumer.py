import asyncio
import json
import logging
import secrets
import time
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.core.cache import cache
from django.http import Http404
from django.core.exceptions import ValidationError as DjangoValidationError
from Shared_IDE.monitoring import capture_unexpected
from redis.exceptions import RedisError
from rest_framework.exceptions import APIException
from rest_framework_simplejwt.exceptions import TokenError
from accounts.authentication import authenticate_access_token
from .collaboration import MAX_STATE, apply_update, decode, room, snapshot
from .models import File

logger = logging.getLogger(__name__)

AUTH_TIMEOUT_SECONDS = 5
SESSION_CHECK_SECONDS = 1
MAX_MESSAGES_PER_SECOND = 40

PALETTE = ['#b59aff', '#68dcaa', '#74b9ff', '#ffb86c', '#f58fbe', '#e5dd78', '#64dfdf', '#c3b1ff']


def relative_position(value):
    if not isinstance(value, dict) or set(value) - {'type', 'tname', 'item', 'assoc'}:
        raise ValueError()
    result = {}
    for key in ('type', 'item'):
        item = value.get(key)
        if item is not None and (not isinstance(item, dict) or set(item) != {'client', 'clock'} or
            any(type(n) is not int or not 0 <= n < 2**53 for n in item.values())):
            raise ValueError()
        result[key] = item
    if value.get('tname') not in (None, 'content') or value.get('assoc', 0) not in (-1, 0, 1):
        raise ValueError()
    result.update(tname=value.get('tname'), assoc=value.get('assoc', 0))
    return result


class CollaborationConsumer(AsyncWebsocketConsumer):
    """Bounded authenticated transport; no source/JWT in group names or URLs."""
    async def __call__(self, scope, receive, send):
        try:
            return await super().__call__(scope, receive, send)
        finally:
            # Channel-layer failures can end dispatch without a disconnect frame.
            if hasattr(self, 'watcher'):
                await self.disconnect(1006)

    async def connect(self):
        self.file_id = self.scope['url_route']['kwargs']['file_id']
        self.group = room(self.file_id)
        self.token = None
        self.user = None
        self.permission = None
        self.identity = None
        self.selection = None
        self.presence_id = secrets.randbelow(2**48 - 2**40) + 2**40
        self.clock = 0
        self.revision = -1
        self.vector = None
        self.closed = False
        self.joined = False
        self.window = time.monotonic()
        self.count = 0
        await self.accept()
        self.watcher = asyncio.create_task(self.watch())

    async def send_data(self, data):
        if not self.closed:
            await self.send(text_data=json.dumps(data, separators=(',', ':')))

    async def stop(self, code, message):
        if self.closed:
            return
        await self.send_data({'type': 'denied', 'message': message})
        self.closed = True
        await self.leave()
        await self.close(code=code)

    async def leave(self):
        if self.joined:
            self.joined = False
            try:
                async with asyncio.timeout(5):
                    await self.channel_layer.group_discard(self.group, self.channel_name)
                    await self.channel_layer.group_send(self.group, {
                        'type': 'collaboration.presence', 'id': self.presence_id, 'clock': self.clock + 1, 'state': None,
                    })
            except (RedisError, asyncio.TimeoutError) as exc:
                capture_unexpected(exc, 'websocket')
                logger.warning('Collaboration presence cleanup could not reach Redis.')

    async def disconnect(self, code):
        self.closed = True
        self.watcher.cancel()
        await asyncio.gather(self.watcher, return_exceptions=True)
        await self.leave()

    @database_sync_to_async
    def authorize(self):
        user, _ = authenticate_access_token(self.token)
        file = File.objects.select_related('workspace').filter(pk=self.file_id).first()
        if file is None:
            return None
        if file.workspace.owner_id == user.pk:
            permission, index = 'owner', 0
        else:
            member = file.collaborators.filter(user=user).values('pk', 'permission').first()
            if member is None:
                return None
            # A durable membership key keeps colors stable when another member
            # leaves. Deriving the index from list order would recolor everyone.
            permission, index = member['permission'], member['pk']
        color = PALETTE[index] if index < len(PALETTE) else f'hsl({(index * 137.508) % 360:.2f} 70% 70%)'
        cache.set(f'presence:{file.pk}:{user.pk}', True, 15)
        return user, permission, {'id': user.pk, 'username': user.username, 'color': color}

    async def guard(self):
        try:
            allowed = await self.authorize()
        except (APIException, TokenError, ValueError, DjangoValidationError):
            await self.stop(4401, 'session_expired')
            return False
        if allowed is None:
            await self.stop(4403, 'access_revoked')
            return False
        previous_identity = self.identity
        self.user, permission, self.identity = allowed
        if previous_identity is not None and previous_identity != self.identity:
            await self.send_data({'type': 'identity', 'user': self.identity})
        if self.permission and self.permission != permission:
            # A fresh read-only Doc must replace any unacknowledged editor state.
            await self.stop(4409, 'permission_changed')
            return False
        self.permission = permission
        return True

    async def receive(self, text_data=None, bytes_data=None):
        if self.closed:
            return
        if bytes_data is not None or not text_data or len(text_data) > (MAX_STATE * 4 // 3 + 8192):
            await self.stop(4400, 'message_limit')
            return
        now = time.monotonic()
        if now - self.window >= 1:
            self.count = 0; self.window = now
        self.count += 1
        if self.count > MAX_MESSAGES_PER_SECOND:
            await self.stop(4429, 'rate_limit'); return
        try:
            message = json.loads(text_data)
            if not isinstance(message, dict):
                raise ValueError()
            if self.token is None:
                token = message.get('token')
                if message.get('type') != 'authenticate' or not isinstance(token, str) or len(token) > 4096:
                    await self.stop(4401, 'session_expired'); return
                self.token = token
                if not await self.guard(): return
                await self.channel_layer.group_add(self.group, self.channel_name)
                self.joined = True
                await self.send_data({'type': 'ready', 'permission': self.permission, 'user': self.identity,
                                      'presence_id': self.presence_id})
                await self.sync()
                await self.channel_layer.group_send(self.group, {'type': 'collaboration.joined'})
                return
            if not await self.guard(): return
            kind = message.get('type')
            if kind == 'update':
                seq = message.get('seq')
                if type(seq) is not int or not 0 <= seq < 2**53: raise ValueError()
                result = await database_sync_to_async(apply_update)(self.file_id, self.user, decode(message.get('update')))
                await self.send_data({'type': 'ack', 'seq': seq, **result})
                await self.sync()
            elif kind == 'sync':
                await self.sync(decode(message.get('vector'), 65536))
            elif kind == 'awareness':
                selection = message.get('selection')
                if selection is not None:
                    if not isinstance(selection, dict) or set(selection) != {'anchor', 'head'}: raise ValueError()
                    selection = {k: relative_position(v) for k, v in selection.items()}
                self.selection = selection
                await self.publish_presence()
            else:
                raise ValueError()
        except Http404:
            await self.stop(4403, 'access_revoked')
        except APIException as exc:
            if exc.status_code in (403, 404):
                await self.stop(4403, 'access_revoked' if exc.status_code == 404 else 'read_only')
            else:
                await self.stop(4400, 'invalid_update')
        except (ValueError, TypeError, RuntimeError):
            await self.stop(4400, 'invalid_update')

    async def sync(self, vector=None):
        try:
            data = await database_sync_to_async(snapshot)(self.file_id, self.user, vector if vector is not None else self.vector)
        except (APIException, Http404):
            await self.stop(4403, 'access_revoked')
            return
        self.vector = decode(data['vector'], 65536)
        self.revision = data['revision']
        await self.send_data(data)

    async def publish_presence(self):
        self.clock += 1
        await self.channel_layer.group_send(self.group, {'type': 'collaboration.presence',
            'id': self.presence_id, 'clock': self.clock,
            'state': {'user': self.identity, 'selection': self.selection}})

    async def collaboration_joined(self, event):
        if not self.closed and await self.guard(): await self.publish_presence()

    async def collaboration_presence(self, event):
        if not self.closed and event['id'] != self.presence_id and await self.guard():
            await self.send_data({'type': 'awareness', 'id': event['id'], 'clock': event['clock'], 'state': event['state']})

    async def collaboration_changed(self, event):
        if not self.closed and await self.guard(): await self.sync()

    async def watch(self):
        try:
            deadline = time.monotonic() + AUTH_TIMEOUT_SECONDS
            while self.user is None and not self.closed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    await self.stop(4401, 'session_expired'); return
                await asyncio.sleep(min(SESSION_CHECK_SECONDS, remaining))
            tick = 0
            while not self.closed:
                await asyncio.sleep(SESSION_CHECK_SECONDS)
                if not await self.guard(): return
                tick += 1
                if tick % 5 == 0:
                    # Recovers lost Redis notifications / restarts without losing edits.
                    await self.sync()
                    await self.publish_presence()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            capture_unexpected(exc, 'websocket')
            # Never log frames, source, credentials, or provider exception strings.
            await self.stop(1011, 'unavailable')
