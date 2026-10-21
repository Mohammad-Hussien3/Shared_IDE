"""File-scoped authorization. Workspace APIs remain owner-only; shared runs use a separate private socket."""
from django.shortcuts import get_object_or_404
from .models import File, FileCollaborator


def locked_file(file_id):
    # Every membership mutation and collaborative write uses this same lock.
    return get_object_or_404(File.objects.select_for_update(of=('self',)).select_related('workspace__owner'), pk=file_id)


def permission_for(file, user):
    if not user or not user.is_authenticated or not user.is_active:
        return None
    if file.workspace.owner_id == user.pk:
        return 'owner'
    return FileCollaborator.objects.filter(file=file, user=user).values_list('permission', flat=True).first()


def owner_file(file_id, user, lock=False):
    query = File.objects.select_related('workspace__owner').filter(workspace__owner=user)
    if lock:
        query = query.select_for_update(of=('self',))
    return get_object_or_404(query, pk=file_id)


def identity(user):
    return {'id': user.pk, 'username': user.username}


def file_data(file, permission):
    return {
        'id': str(file.pk), 'name': file.name, 'language': file.language,
        'content': file.content, 'updated_at': file.updated_at,
        'owner': identity(file.workspace.owner), 'permission': permission,
        'collaborative': hasattr(file, 'document'),
    }


def invitation_data(invitation):
    return {
        'id': str(invitation.pk), 'file': {'id': str(invitation.file_id), 'name': invitation.file.name,
                                         'language': invitation.file.language},
        'sender': identity(invitation.sender), 'recipient': identity(invitation.recipient),
        'permission': invitation.permission, 'status': invitation.status,
        'created_at': invitation.created_at, 'updated_at': invitation.updated_at,
    }
