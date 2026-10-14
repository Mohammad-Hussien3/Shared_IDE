from datetime import datetime, timezone as datetime_timezone
from uuid import UUID
import logging
from smtplib import SMTPException

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.db import IntegrityError, transaction
from django.middleware.csrf import get_token, rotate_token
from django.utils import timezone
from rest_framework.authentication import CSRFCheck
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken, UntypedToken
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from .models import AuthSession, EmailVerification
from .serializers import LoginSerializer, RegisterSerializer, UserSerializer, ResendVerificationSerializer, VerifyEmailSerializer
from .verification import CHECK_EMAIL_MESSAGE, consume_verification, send_verification, verification_required

logger = logging.getLogger(__name__)


def token_expiry(token):
    return datetime.fromtimestamp(token['exp'], tz=datetime_timezone.utc)


def session_response(request, user, refresh, status=200, response=None):
    csrf = get_token(request)
    if response is None:
        response = Response({
            'access': str(refresh.access_token),
            'user': UserSerializer(user).data,
            'csrf': csrf,
        }, status=status)
    response.set_cookie(
        settings.AUTH_REFRESH_COOKIE, str(refresh),
        max_age=max(0, int((token_expiry(refresh) - timezone.now()).total_seconds())),
        httponly=True, secure=settings.AUTH_COOKIE_SECURE,
        samesite=settings.AUTH_COOKIE_SAMESITE, path=settings.AUTH_REFRESH_COOKIE_PATH,
    )
    return response


def begin_session(request, user, status=200, response=None):
    with transaction.atomic():
        refresh = RefreshToken.for_user(user)
        session = AuthSession.objects.create(
            user=user, refresh_jti=refresh['jti'], expires_at=token_expiry(refresh),
        )
        refresh['sid'] = str(session.pk)
    rotate_token(request)
    return session_response(request, user, refresh, status, response=response)


class CookieAuthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def initial(self, request, *args, **kwargs):
        # DRF views are CSRF-exempt by default. Cookie-authenticated endpoints
        # must explicitly enforce Django's token and Origin/Referer checks.
        check = CSRFCheck(lambda req: None)
        check.process_request(request)
        reason = check.process_view(request, None, (), {})
        if reason:
            error = {
                'detail': 'CSRF verification failed. Reload and try again.',
                'code': 'csrf_failed',
            }
            if settings.DEBUG:
                error['detail'] = f'CSRF verification failed: {reason}'
            raise PermissionDenied(error)
        super().initial(request, *args, **kwargs)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'no-store'
        return response


class CSRFView(CookieAuthView):
    def get(self, request):
        return Response({'csrf': get_token(request)})


class RegisterView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'auth'

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                user = serializer.save()
                record = EmailVerification.objects.create(user=user, email=user.email)
                send_verification(record)
                return Response({'detail': CHECK_EMAIL_MESSAGE}, status=201)
        except IntegrityError:
            return Response({'detail': 'This username or email is unavailable.'}, status=400)
        except (SMTPException, OSError, ImproperlyConfigured, ValueError) as exc:
            # Exception type helps diagnose SMTP configuration without logging
            # provider responses, credentials, recipients, or verification links.
            logger.error('Registration verification email delivery failed (%s).', type(exc).__name__)
            return Response({'code': 'email_delivery_failed'}, status=503)


class VerifyEmailView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'auth'

    def post(self, request):
        serializer = VerifyEmailSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        code = consume_verification(serializer.validated_data['token'])
        return Response({'code': code}, status=200 if code == 'email_verified' else 400)


class ResendVerificationView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'verification_resend'

    def post(self, request):
        serializer = ResendVerificationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        record = EmailVerification.objects.filter(email=serializer.validated_data['email'].strip().lower()).first()
        if record:
            try:
                send_verification(record)
            except (SMTPException, OSError, ImproperlyConfigured, ValueError) as exc:
                # Same response for unknown, verified, throttled-by-cooldown,
                # and delivery-failed addresses. Never log addresses or tokens.
                logger.error('Resend verification email delivery failed (%s).', type(exc).__name__)
        return Response({'detail': CHECK_EMAIL_MESSAGE}, status=202)


class LoginView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'auth'

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        credentials = dict(serializer.validated_data)
        identifier = credentials['username']
        User = get_user_model()
        # Preserve existing username login, and support an unambiguous email.
        if not User.objects.filter(username=identifier).exists():
            matches = list(User.objects.filter(email__iexact=identifier).values_list('username', flat=True)[:2])
            if len(matches) == 1:
                credentials['username'] = matches[0]
        user = authenticate(request=request, **credentials)
        if user is None:
            return Response({'detail': 'Invalid username or password.'}, status=401)
        if verification_required(user):
            return Response({'code': 'email_unverified', 'detail': 'Please verify your email first.'}, status=403)
        return begin_session(request, user)


class RefreshView(CookieAuthView):
    def post(self, request):
        try:
            refresh = RefreshToken(request.COOKIES.get(settings.AUTH_REFRESH_COOKIE, ''))
            session_id = UUID(str(refresh.get('sid', '')))
            with transaction.atomic():
                session = AuthSession.objects.select_related('user').get(
                    pk=session_id, user_id=refresh['user_id'], user__is_active=True,
                    revoked_at__isnull=True, expires_at__gt=timezone.now(),
                    refresh_jti=refresh['jti'],
                )
                if verification_required(session.user):
                    return Response({'code': 'email_unverified', 'detail': 'Please verify your email first.'}, status=401)
                # Also enforce password-change revocation for refresh tokens.
                from rest_framework_simplejwt.utils import get_md5_hash_password
                if refresh.get('hash_password') != get_md5_hash_password(session.user.password):
                    raise TokenError('Password changed')
                replacement = RefreshToken.for_user(session.user)
                replacement['sid'] = str(session.pk)
                changed = AuthSession.objects.filter(
                    pk=session.pk, refresh_jti=refresh['jti'], revoked_at__isnull=True,
                ).update(refresh_jti=replacement['jti'], expires_at=token_expiry(replacement))
                if not changed:
                    raise TokenError('Refresh already used')
                refresh.blacklist()
                return session_response(request, session.user, replacement)
        except (TokenError, AuthSession.DoesNotExist, ValueError, KeyError):
            return Response({'detail': 'Session expired. Please log in again.'}, status=401)


class LogoutView(CookieAuthView):
    def post(self, request):
        raw = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE)
        if raw:
            try:
                # A concurrent refresh may already have blacklisted this cookie.
                # Verify its signature/expiry, then revoke its session anyway.
                token = UntypedToken(raw)
                if token['token_type'] != 'refresh':
                    raise TokenError('Expected refresh token')
                session_id = UUID(str(token.get('sid', '')))
                AuthSession.objects.filter(pk=session_id, user_id=token['user_id']).update(revoked_at=timezone.now())
                outstanding = OutstandingToken.objects.filter(jti=token['jti']).first()
                if outstanding:
                    BlacklistedToken.objects.get_or_create(token=outstanding)
            except (TokenError, ValueError, KeyError):
                pass
        # A valid access token can also revoke a session if its cookie expired.
        header = request.headers.get('Authorization', '')
        if header.startswith('Bearer '):
            try:
                token = AccessToken(header[7:])
                session_id = UUID(str(token.get('sid', '')))
                AuthSession.objects.filter(pk=session_id, user_id=token['user_id']).update(revoked_at=timezone.now())
            except (TokenError, ValueError, KeyError):
                pass
        response = Response(status=204)
        response.delete_cookie(settings.AUTH_REFRESH_COOKIE, path=settings.AUTH_REFRESH_COOKIE_PATH, samesite=settings.AUTH_COOKIE_SAMESITE)
        return response


class MeView(APIView):
    def get(self, request):
        return Response(UserSerializer(request.user).data, headers={'Cache-Control': 'no-store'})
