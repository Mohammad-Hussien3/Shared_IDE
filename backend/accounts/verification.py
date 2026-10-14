"""Password signup verification, independent of Google OAuth."""
import hashlib
import logging
import re
import secrets
import time
from datetime import timedelta
from smtplib import SMTPException
from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.db.models import Q
from django.template.loader import render_to_string
from django.utils import timezone

from .models import EmailVerification

logger = logging.getLogger(__name__)
EXPIRATION_MINUTES = 30
RESEND_COOLDOWN_SECONDS = 60
CHECK_EMAIL_MESSAGE = 'If this address needs verification, a verification email will be sent. Check your inbox and spam folder.'


def log_delivery_failure(phase, exc, started, *, cleanup=False):
    """Log metadata only: SMTP exception text can contain addresses and secrets."""
    context = exc.__cause__ or exc.__context__
    code = getattr(exc, 'smtp_code', None)
    log = logger.warning if cleanup else logger.error
    log('Email transport failure phase=%s error=%s context=%s smtp_code=%s elapsed_seconds=%.1f',
        phase, type(exc).__name__, type(context).__name__ if context else 'none',
        code if isinstance(code, int) else 'none', time.monotonic() - started)


def deliver_message(message):
    # Own this message's connection explicitly. Django's SMTP open() may raise
    # during STARTTLS/login before send_messages() enters its cleanup block.
    connection = message.get_connection(fail_silently=False)
    started = time.monotonic()
    phase = 'connect_tls_auth'
    try:
        connection.open()
        phase = 'message_submission'
        if message.send(fail_silently=False) != 1:
            raise OSError('Verification email was not accepted for delivery.')
    except (SMTPException, OSError, ImproperlyConfigured, ValueError) as exc:
        log_delivery_failure(phase, exc, started)
        raise
    finally:
        transport = getattr(connection, 'connection', None)
        try:
            connection.close()
        except (SMTPException, OSError) as exc:
            # Preserve the original error, or a successfully accepted message.
            # A QUIT failure must not roll back an already mailed signup token.
            log_delivery_failure('connection_cleanup', exc, started, cleanup=True)
            if transport is not None:
                try:
                    transport.close()
                except OSError:
                    pass


def verification_required(user):
    # Legacy accounts and Google-created users have no password-signup record.
    record = EmailVerification.objects.filter(user=user).first()
    return record is not None and (record.verified_at is None or record.email != user.email.lower())


def token_digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def frontend_url():
    url = urlsplit(settings.FRONTEND_URL)
    if (url.username or url.password or url.query or url.fragment or url.path
            or not url.hostname or settings.FRONTEND_URL not in settings.CORS_ALLOWED_ORIGINS
            or (url.scheme != 'https' and not (
                settings.DEBUG and url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1')
            ))):
        raise ImproperlyConfigured('Configure a trusted FRONTEND_URL for verification emails.')
    return settings.FRONTEND_URL


def send_verification(record):
    """Atomically replace a link subject to a database-enforced cooldown.

    Sending inside the transaction preserves the previous link if delivery fails.
    SMTP acceptance does not guarantee inbox delivery; users can request a resend.
    """
    user = record.user
    if not user.is_active or user.email != record.email:
        return False
    token = secrets.token_urlsafe(32)
    now = timezone.now()
    with transaction.atomic():
        changed = EmailVerification.objects.filter(
            pk=record.pk, verified_at__isnull=True,
        ).filter(Q(sent_at__isnull=True) | Q(sent_at__lte=now - timedelta(seconds=RESEND_COOLDOWN_SECONDS))).update(
            token_hash=token_digest(token), expires_at=now + timedelta(minutes=EXPIRATION_MINUTES), sent_at=now,
        )
        if not changed:
            return False
        # Fragments are not sent to web servers or in HTTP Referer headers.
        context = {'verification_url': frontend_url() + '/verify-email#token=' + token,
                   'expiration_minutes': EXPIRATION_MINUTES}
        message = EmailMultiAlternatives(
            subject='Verify your Shared IDE email address',
            body=render_to_string('accounts/email/verify_email.txt', context),
            from_email=settings.DEFAULT_FROM_EMAIL, to=[record.email],
        )
        message.attach_alternative(render_to_string('accounts/email/verify_email.html', context), 'text/html')
        deliver_message(message)
    return True


def consume_verification(token):
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        return 'verification_invalid'
    now = timezone.now()
    digest = token_digest(token)
    record = EmailVerification.objects.select_related('user').filter(token_hash=digest).first()
    if record is None or not record.user.is_active or record.user.email != record.email:
        return 'verification_invalid'
    # One conditional UPDATE, including the token digest, serializes consumption
    # against both another verification request and a simultaneous resend.
    changed = EmailVerification.objects.filter(
        token_hash=digest, verified_at__isnull=True, expires_at__gt=now,
    ).update(verified_at=now)
    if changed:
        return 'email_verified'
    record = EmailVerification.objects.filter(token_hash=digest).first()
    if record is None:
        return 'verification_invalid'
    if record.verified_at is not None:
        return 'verification_used'
    return 'verification_expired'
