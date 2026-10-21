"""Durable Yjs v1 updates. PostgreSQL is authoritative, Redis only signals changes."""
import base64
import binascii
import logging
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from django.utils import timezone
from pycrdt import Doc, Text, merge_updates
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from .models import CollaborativeDocument, File
from .sharing import locked_file, permission_for

MAX_SOURCE = 65536
MAX_STATE = 1024 * 1024
logger = logging.getLogger(__name__)


def room(file_id):
    return 'file.' + str(file_id).replace('-', '')


def notify(file_id, access_changed=False):
    def publish():
        try:
            async_to_sync(get_channel_layer().group_send)(room(file_id), {'type': 'collaboration.changed'})
            if access_changed:
                async_to_sync(get_channel_layer().group_send)(room(file_id) + '.runs', {'type': 'execution.access_changed'})
        except Exception:
            # No code, token, or Redis credentials. Watchers recover missed signals.
            logger.warning('Collaboration notification unavailable; polling will recover.')
    transaction.on_commit(publish)


def encode(value):
    return base64.b64encode(value).decode('ascii')


def decode(value, limit=MAX_STATE):
    if not isinstance(value, str) or len(value) > ((limit + 2) // 3) * 4:
        raise ValidationError({'code': 'collaboration_limit'})
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValidationError({'code': 'collaboration_invalid'}) from None
    if len(raw) > limit:
        raise ValidationError({'code': 'collaboration_limit'})
    return raw


def read_doc(state):
    doc = Doc({'content': Text()})
    doc.apply_update(bytes(state))
    return doc


def ensure_document(file):
    """Caller holds the file row lock; seed once, never once per browser."""
    document = CollaborativeDocument.objects.filter(file=file).first()
    if document is None:
        if len(file.content.encode('utf-8')) > MAX_SOURCE:
            raise ValidationError({'code': 'collaboration_limit'})
        doc = Doc({'content': Text(file.content)})
        document = CollaborativeDocument.objects.create(file=file, state=doc.get_update())
    return document


@transaction.atomic
def snapshot(file_id, user, vector=None):
    file = locked_file(file_id)
    permission = permission_for(file, user)
    if permission is None:
        raise NotFound()
    # Collaboration begins only when the owner enables sharing. A private file
    # cannot be switched into collaboration by a guessed UUID.
    document = get_document(file)
    doc = read_doc(document.state)
    return {
        'type': 'sync', 'update': encode(doc.get_update(vector)), 'vector': encode(doc.get_state()),
        'revision': document.revision, 'permission': permission,
    }


def get_document(file):
    try:
        return file.document
    except CollaborativeDocument.DoesNotExist:
        raise NotFound() from None


@transaction.atomic
def apply_update(file_id, user, update):
    file = locked_file(file_id)
    permission = permission_for(file, user)
    if permission is None:
        raise NotFound()
    if permission not in ('owner', 'edit'):
        raise PermissionDenied()
    document = get_document(file)
    try:
        # Keep even out-of-order structs with unmet dependencies. Serializing only
        # a materialized Doc would lose pending updates across service restarts.
        state = merge_updates(bytes(document.state), update)
        if len(state) > MAX_STATE:
            raise ValueError()
        doc = read_doc(state)
        content = str(doc['content'])
        if set(doc.keys()) != {'content'} or '\x00' in content or len(content.encode('utf-8')) > MAX_SOURCE:
            raise ValueError()
        # Embedded objects/formatting are not part of a source-code document.
        if any(not isinstance(part, str) or attrs for part, attrs in doc['content'].diff()):
            raise ValueError()
    except (ValueError, TypeError, RuntimeError):
        raise ValidationError({'code': 'collaboration_invalid'}) from None
    if state != bytes(document.state):
        document.state = state
        document.revision += 1
        document.save(update_fields=['state', 'revision', 'updated_at'])
        File.objects.filter(pk=file.pk).update(content=content, updated_at=timezone.now())
        notify(file.pk)
    return {'revision': document.revision, 'vector': encode(doc.get_state())}
