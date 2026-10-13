import uuid

from django.conf import settings
from django.db import models


class AuthSession(models.Model):
    """Revocable JWT session, shared by HTTP requests and terminal connections."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    refresh_jti = models.CharField(max_length=255)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
