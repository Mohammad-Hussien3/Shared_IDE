import uuid
from django.conf import settings
from django.db import models


class Workspace(models.Model):
    # NULL is reserved for quarantined pre-authentication records. The API
    # always assigns an owner; only the explicit admin command claims legacy data.
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="workspaces", null=True, blank=True,
    )
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False
    )

    name = models.CharField(
        max_length=100,
        default="Untitled Workspace"
    )

    created_at = models.DateTimeField(
        auto_now_add=True
    )

    updated_at = models.DateTimeField(
        auto_now=True
    )

    def __str__(self):
        return self.name
    

class Folder(models.Model):
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False
    )

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="folders"
    )

    name = models.CharField(max_length=255)

    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="children"
    )

    created_at = models.DateTimeField(
        auto_now_add=True
    )

    def __str__(self):
        return self.name


class File(models.Model):
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False
    )

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="files"
    )

    folder = models.ForeignKey(
        Folder,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="files"
    )

    name = models.CharField(max_length=255)

    content = models.TextField(blank=True)

    language = models.CharField(
        max_length=50,
        blank=True    )

    created_at = models.DateTimeField(
        auto_now_add=True
    )

    updated_at = models.DateTimeField(
        auto_now=True
    )

    def __str__(self):
        return self.name


class FileInvitation(models.Model):
    PERMISSIONS = [('view', 'Can view'), ('edit', 'Can edit')]
    STATUSES = [(s, s.title()) for s in ('pending', 'accepted', 'declined', 'canceled', 'revoked')]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file = models.ForeignKey(File, on_delete=models.CASCADE, related_name='invitations')
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='file_invitations_sent')
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='file_invitations_received')
    permission = models.CharField(max_length=4, choices=PERMISSIONS, default='edit')
    status = models.CharField(max_length=8, choices=STATUSES, default='pending')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['file', 'recipient'], condition=models.Q(status__in=['pending', 'accepted']),
                                    name='unique_active_file_invitation'),
            models.CheckConstraint(condition=~models.Q(sender=models.F('recipient')), name='no_self_file_invitation'),
            models.CheckConstraint(condition=models.Q(permission__in=['view', 'edit']), name='valid_invitation_permission'),
            models.CheckConstraint(condition=models.Q(status__in=['pending', 'accepted', 'declined', 'canceled', 'revoked']),
                                   name='valid_invitation_status'),
        ]


class FileCollaborator(models.Model):
    file = models.ForeignKey(File, on_delete=models.CASCADE, related_name='collaborators')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='shared_files')
    permission = models.CharField(max_length=4, choices=FileInvitation.PERMISSIONS)
    granted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    granted_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['file', 'user'], name='unique_file_collaborator'),
            models.CheckConstraint(condition=models.Q(permission__in=['view', 'edit']), name='valid_collaborator_permission'),
        ]


class CollaborativeDocument(models.Model):
    file = models.OneToOneField(File, on_delete=models.CASCADE, related_name='document', primary_key=True)
    state = models.BinaryField()
    revision = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)
