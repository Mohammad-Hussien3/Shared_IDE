from uuid import UUID

from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication

from .models import AuthSession


class SessionJWTAuthentication(JWTAuthentication):
    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        try:
            session_id = UUID(str(validated_token.get('sid', '')))
        except ValueError:
            raise AuthenticationFailed('Session is invalid or expired.')
        if not AuthSession.objects.filter(
            pk=session_id, user=user, revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
        ).exists():
            raise AuthenticationFailed('Session is invalid or expired.')
        return user


def authenticate_access_token(raw_token):
    auth = SessionJWTAuthentication()
    token = auth.get_validated_token(raw_token)
    return auth.get_user(token), token
