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


class GoogleIdentity(models.Model):
    """Google's verified stable subject, never an email-based account link."""

    subject = models.CharField(max_length=255, unique=True)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='google_identity')
    created_at = models.DateTimeField(auto_now_add=True)


class GoogleAuthAttempt(models.Model):
    """Short-lived, single-use server-side PKCE and browser binding."""

    state_hash = models.CharField(max_length=64, primary_key=True)
    browser_hash = models.CharField(max_length=64)
    nonce = models.CharField(max_length=128)
    code_verifier = models.CharField(max_length=128)
    expires_at = models.DateTimeField(db_index=True)
    consumed_at = models.DateTimeField(null=True)
    link_session = models.ForeignKey(AuthSession, null=True, on_delete=models.CASCADE)
    link_proof = models.CharField(max_length=64, blank=True)
