from datetime import datetime, timezone as datetime_timezone
from uuid import UUID

from django.conf import settings
from django.contrib.auth import authenticate
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

from .models import AuthSession
from .serializers import LoginSerializer, RegisterSerializer, UserSerializer


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
                return begin_session(request, user, status=201)
        except IntegrityError:
            return Response({'username': ['This username is unavailable.']}, status=400)


class LoginView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'auth'

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate(request=request, **serializer.validated_data)
        if user is None:
            return Response({'detail': 'Invalid username or password.'}, status=401)
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
