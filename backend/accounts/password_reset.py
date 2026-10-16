"""Single-use email recovery, including verified passwordless Google accounts."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import logging
import re
import secrets
from threading import BoundedSemaphore

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.mail import EmailMultiAlternatives
from django.db import close_old_connections, transaction
from django.template.loader import render_to_string
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac

from .models import AccountVerification, AuthSession, PasswordReset
from .serializers import PasswordSerializer
from .verification import deliver_message, frontend_url, token_digest, verification_required

logger = logging.getLogger(__name__)
RESET_MESSAGE = "If an account exists with this email, we've sent a password reset link."
# Bound background work; SMTP must never make an existing address distinguishable
# by its request latency. No external queue/service is required for local use.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='password-reset-mail')
_slots = BoundedSemaphore(20)


def password_fingerprint(user):
    return salted_hmac('password-reset-password', user.password, algorithm='sha256').hexdigest()


def eligible(user):
    return (user.is_active and bool(user.email) and not verification_required(user)
            and (user.has_usable_password() or hasattr(user, 'google_identity')))


def send_reset(email):
    User = get_user_model()
    matches = list(User.objects.filter(email__iexact=email).values_list('pk', flat=True)[:2])
    # Legacy duplicate emails must never select an arbitrary account or merge it.
    if len(matches) != 1:
        return
    with transaction.atomic():
        user = User.objects.select_for_update().get(pk=matches[0])
        if user.email.lower() != email or not eligible(user):
            return
        now = timezone.now()
        if PasswordReset.objects.filter(user=user, sent_at__gt=now - timedelta(seconds=60)).exists():
            return
        token = secrets.token_urlsafe(32)
        PasswordReset.objects.update_or_create(user=user, defaults={
            'token_hash': token_digest(token), 'password_fingerprint': password_fingerprint(user),
            'email': user.email, 'sent_at': now, 'expires_at': now + timedelta(minutes=30), 'used_at': None,
        })
        # Fragments are not transmitted in HTTP requests or Referer headers.
        context = {'reset_url': frontend_url() + '/reset-password#token=' + token}
        message = EmailMultiAlternatives(
            subject='Reset your Shared IDE password',
            body=render_to_string('accounts/email/reset_password.txt', context),
            from_email=settings.DEFAULT_FROM_EMAIL, to=[user.email],
        )
        message.attach_alternative(render_to_string('accounts/email/reset_password.html', context), 'text/html')
        deliver_message(message)


def deliver_reset(email):
    """Worker boundary: contain failures, close DB connections, and release capacity."""
    try:
        close_old_connections()
        send_reset(email)
    except Exception as exc:
        # Never log exception text, recipients, reset URLs, or SMTP responses.
        logger.error('Password reset delivery failed (%s).', type(exc).__name__)
    finally:
        close_old_connections()
        _slots.release()


def enqueue_reset(email):
    if not _slots.acquire(blocking=False):
        logger.warning('Password reset delivery queue is at capacity.')
        return
    try:
        _executor.submit(deliver_reset, email)
    except RuntimeError:
        _slots.release()
        logger.warning('Password reset delivery queue is shutting down.')


def reset_password(data):
    if not isinstance(data, dict):
        return 'reset_invalid'
    token = data.get('token')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        return 'reset_invalid'
    digest = token_digest(token)
    user_id = PasswordReset.objects.filter(token_hash=digest).values_list('user_id', flat=True).first()
    if user_id is None:
        return 'reset_invalid'
    with transaction.atomic():
        # Use the same lock order as account settings and token issuance.
        user = get_user_model().objects.select_for_update().filter(pk=user_id).first()
        record = PasswordReset.objects.filter(user_id=user_id, token_hash=digest).first()
        if user is None or record is None or not eligible(user) or record.email != user.email:
            return 'reset_invalid'
        if record.used_at is not None:
            return 'reset_used'
        if not constant_time_compare(record.password_fingerprint, password_fingerprint(user)):
            return 'reset_invalid'
        if record.expires_at <= timezone.now():
            return 'reset_expired'
        serializer = PasswordSerializer(data=data, context={'user': user})
        serializer.is_valid(raise_exception=True)
        # Conditional consumption protects replay even on databases without row locks.
        changed = PasswordReset.objects.filter(
            pk=record.pk, token_hash=digest, used_at__isnull=True, expires_at__gt=timezone.now(),
        ).update(used_at=timezone.now())
        if not changed:
            return 'reset_invalid'
        user.set_password(serializer.validated_data['password'])
        user.save(update_fields=['password'])
        AuthSession.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())
        AccountVerification.objects.filter(user=user).delete()
    return 'password_reset'
