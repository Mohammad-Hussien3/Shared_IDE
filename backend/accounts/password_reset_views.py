from django.conf import settings
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from .password_reset import RESET_MESSAGE, enqueue_reset, reset_password
from .serializers import ResendVerificationSerializer
from .views import CookieAuthView


class PasswordResetRequestView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'password_reset_request'

    def post(self, request):
        serializer = ResendVerificationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # No user lookup or SMTP work in this public request path.
        enqueue_reset(serializer.validated_data['email'].strip().lower())
        return Response({'detail': RESET_MESSAGE}, status=202)


class PasswordResetConfirmView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'password_reset_confirm'

    def post(self, request):
        code = reset_password(request.data)
        response = Response({'code': code}, status=200 if code == 'password_reset' else 400)
        if code == 'password_reset':
            response.delete_cookie(settings.AUTH_REFRESH_COOKIE, path=settings.AUTH_REFRESH_COOKIE_PATH,
                                   samesite=settings.AUTH_COOKIE_SAMESITE)
        return response
