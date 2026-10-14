"""Google authorization code flow. All OAuth tokens stay on the backend."""
import hashlib
import secrets
from datetime import timedelta
from urllib.parse import urlsplit

import requests
from authlib.integrations.requests_client import OAuth2Session
from authlib.oidc.core import CodeIDToken
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.crypto import constant_time_compare
from joserfc import jwt
from joserfc.jwk import KeySet
from rest_framework_simplejwt.tokens import RefreshToken

from .models import GoogleAuthAttempt, GoogleIdentity

AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
FLOW_COOKIE = 'ide_google_flow'
FLOW_COOKIE_PATH = '/api/auth/google/'
FLOW_SECONDS = 600


class GoogleAuthError(Exception):
    def __init__(self, code):
        self.code = code


def configured():
    if not settings.DEBUG and not settings.AUTH_COOKIE_SECURE:
        return False
    frontend = urlsplit(settings.GOOGLE_FRONTEND_ORIGIN)
    callback = urlsplit(settings.GOOGLE_REDIRECT_URI)
    for url in (frontend, callback):
        if url.username or url.password or url.query or url.fragment or not url.hostname:
            return False
        if url.scheme != 'https' and not (
            settings.DEBUG and url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1')
        ):
            return False
    return bool(
        settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET
        and settings.GOOGLE_FRONTEND_ORIGIN in settings.CORS_ALLOWED_ORIGINS
        and not frontend.path
        and callback.path == FLOW_COOKIE_PATH + 'callback/'
        # Cookie-backed sessions need a consistent browser hostname.
        and frontend.hostname == callback.hostname
        and frontend.scheme == callback.scheme
        and settings.AUTH_COOKIE_SAMESITE == 'Lax'
    )


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def oauth_client():
    return OAuth2Session(
        settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET,
        scope='openid email', redirect_uri=settings.GOOGLE_REDIRECT_URI,
        code_challenge_method='S256', token_endpoint_auth_method='client_secret_post',
    )


def start_attempt(link_session=None, link_proof=''):
    state, browser, nonce, verifier = [secrets.token_urlsafe(48) for _ in range(4)]
    GoogleAuthAttempt.objects.filter(expires_at__lte=timezone.now()).delete()
    GoogleAuthAttempt.objects.create(
        state_hash=digest(state), browser_hash=digest(browser), nonce=nonce,
        code_verifier=verifier, expires_at=timezone.now() + timedelta(seconds=FLOW_SECONDS),
        link_session=link_session, link_proof=link_proof,
    )
    with oauth_client() as client:
        url, _ = client.create_authorization_url(
            AUTHORIZE_URL, state=state, nonce=nonce, code_verifier=verifier,
            prompt='select_account',
        )
    return url, browser


def consume_attempt(state, browser):
    if not isinstance(state, str) or not isinstance(browser, str) or not (20 <= len(state) <= 128 and 20 <= len(browser) <= 128):
        raise GoogleAuthError('google_invalid_state')
    query = GoogleAuthAttempt.objects.filter(
        state_hash=digest(state), browser_hash=digest(browser),
        expires_at__gt=timezone.now(), consumed_at__isnull=True,
    )
    attempt = query.first()
    # Conditional UPDATE is atomic across workers; a replay cannot exchange code.
    if attempt is None or query.update(consumed_at=timezone.now()) != 1:
        raise GoogleAuthError('google_invalid_state')
    return attempt


def google_keys(force=False):
    keys = None if force else cache.get('google-oidc-jwks')
    if keys is None:
        response = requests.get(JWKS_URL, timeout=10, allow_redirects=False)
        response.raise_for_status()
        keys = response.json()
        KeySet.import_key_set(keys)  # Reject malformed provider responses.
        cache.set('google-oidc-jwks', keys, timeout=3600)
    return KeySet.import_key_set(keys)


def exchange_identity(code, attempt):
    with oauth_client() as client:
        tokens = client.fetch_token(
            TOKEN_URL, grant_type='authorization_code', code=code,
            code_verifier=attempt.code_verifier, timeout=10, allow_redirects=False,
        )
    if not isinstance(tokens, dict):
        raise GoogleAuthError('google_failed')
    raw = tokens.get('id_token')
    if not isinstance(raw, str):
        raise GoogleAuthError('google_failed')
    # Only Google's fixed HTTPS JWKS endpoint supplies keys, never token jku/x5u.
    from joserfc.errors import InvalidKeyIdError, MissingKeyError
    try:
        decoded = jwt.decode(raw, google_keys(), algorithms=['RS256'])
    except (InvalidKeyIdError, MissingKeyError):
        decoded = jwt.decode(raw, google_keys(force=True), algorithms=['RS256'])
    claims = CodeIDToken(decoded.claims, decoded.header, options={
        'iss': {'essential': True, 'values': ['https://accounts.google.com', 'accounts.google.com']},
        'aud': {'essential': True, 'value': settings.GOOGLE_CLIENT_ID},
        'sub': {'essential': True}, 'exp': {'essential': True}, 'iat': {'essential': True},
    }, params={
        'nonce': attempt.nonce, 'client_id': settings.GOOGLE_CLIENT_ID,
        'access_token': tokens.get('access_token'),
    })
    claims.validate(leeway=30)
    subject = claims.get('sub')
    email = claims.get('email')
    if not isinstance(subject, str) or not subject or len(subject) > 255:
        raise GoogleAuthError('google_failed')
    if claims.get('email_verified') is not True or not isinstance(email, str) or len(email) > 254:
        raise GoogleAuthError('google_failed')
    try:
        validate_email(email)
    except ValidationError:
        raise GoogleAuthError('google_failed') from None
    return subject, email


def link_user(request, attempt):
    session = attempt.link_session
    if (session is None or session.revoked_at is not None or session.expires_at <= timezone.now()
            or not session.user.is_active
            or not constant_time_compare(session.user.get_session_auth_hash(), attempt.link_proof)):
        raise GoogleAuthError('google_verification_required')
    token = RefreshToken(request.COOKIES.get(settings.AUTH_REFRESH_COOKIE, ''))
    if str(token.get('sid')) != str(session.pk) or token.get('jti') != session.refresh_jti:
        raise GoogleAuthError('google_verification_required')
    return session.user


def resolve_user(subject, email, user_to_link=None):
    User = get_user_model()
    try:
        with transaction.atomic():
            identity = GoogleIdentity.objects.select_related('user').filter(subject=subject).first()
            if user_to_link:
                if identity and identity.user_id == user_to_link.pk:
                    return user_to_link
                if identity or GoogleIdentity.objects.filter(user=user_to_link).exists():
                    raise GoogleAuthError('google_link_conflict')
                GoogleIdentity.objects.create(subject=subject, user=user_to_link)
                return user_to_link
            if identity:
                if not identity.user.is_active:
                    raise GoogleAuthError('google_failed')
                return identity.user
            if User.objects.filter(email__iexact=email).exists():
                raise GoogleAuthError('google_account_exists')
            # An opaque unique username avoids treating Google's email as an ID.
            user = User.objects.create_user(username=f'google_{secrets.token_hex(12)}', email=email, password=None)
            GoogleIdentity.objects.create(subject=subject, user=user)
            return user
    except IntegrityError:
        # A concurrent first login/link may win a uniqueness constraint. Never
        # move a mapping to another user or leave an orphan user behind.
        raise GoogleAuthError('google_link_conflict') from None
