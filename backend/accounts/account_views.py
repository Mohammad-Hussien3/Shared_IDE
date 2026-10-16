"""Own-account settings with fresh password or single-use email confirmation."""
from datetime import timedelta
import secrets
from smtplib import SMTPException

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.core.mail import EmailMultiAlternatives
from django.db import IntegrityError, transaction
from django.db.models import F
from django.template.loader import render_to_string
from django.utils import timezone
from django.utils.crypto import salted_hmac
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from .authentication import SessionJWTAuthentication
from .models import AccountVerification, AuthSession
from .serializers import PasswordSerializer, UsernameSerializer, UserSerializer
from .verification import deliver_message
from .views import CookieAuthView, begin_session


def code_digest(session_id, code):
    # A keyed digest protects short codes even if the database is disclosed.
    return salted_hmac('account-verification', f'{session_id}:{code}', algorithm='sha256').hexdigest()


class AccountMutationView(CookieAuthView):
    authentication_classes = [SessionJWTAuthentication]
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'account_changes'

    def locked_user(self, request):
        user = get_user_model().objects.select_for_update().get(pk=request.user.pk)
        # Recheck after taking the lock: another credential change/logout may
        # have invalidated this request while it waited.
        if user.password != request.user.password or not user.is_active or not AuthSession.objects.filter(
            pk=request.auth['sid'], user=user, revoked_at__isnull=True, expires_at__gt=timezone.now(),
        ).exists():
            return None
        return user

    def confirm(self, request, user, data):
        if user.has_usable_password():
            if not user.check_password(data.get('current_password', '')):
                return Response({'code': 'current_password_invalid'}, status=400)
            return None
        now = timezone.now()
        records = AccountVerification.objects.filter(
            user=user, session_id=request.auth['sid'], email=user.email,
            expires_at__gt=now, attempts__lt=5,
        )
        # Count every attempt, and consume only a matching, unused proof.
        if records.update(attempts=F('attempts') + 1):
            consumed = AccountVerification.objects.filter(
                user=user, session_id=request.auth['sid'], email=user.email,
                expires_at__gt=now, attempts__lte=5,
                code_hash=code_digest(request.auth['sid'], data.get('verification_code', '')),
            ).update(code_hash='', attempts=5)
            if consumed:
                return None
        return Response({'code': 'account_verification_required'}, status=400)


class AccountVerificationView(AccountMutationView):
    throttle_scope = 'account_email'

    def post(self, request):
        try:
            with transaction.atomic():
                user = self.locked_user(request)
                if user is None:
                    return Response(status=401)
                if user.has_usable_password() or not hasattr(user, 'google_identity') or not user.email:
                    return Response({'code': 'current_password_required'}, status=400)
                now = timezone.now()
                if AccountVerification.objects.filter(user=user, sent_at__gt=now - timedelta(seconds=60)).exists():
                    return Response({'code': 'account_code_cooldown'}, status=429)
                code = f'{secrets.randbelow(100_000_000):08d}'
                AccountVerification.objects.update_or_create(user=user, defaults={
                    'session_id': request.auth['sid'], 'email': user.email,
                    'code_hash': code_digest(request.auth['sid'], code),
                    'expires_at': now + timedelta(minutes=10), 'sent_at': now, 'attempts': 0,
                })
                context = {'code': code}
                message = EmailMultiAlternatives(
                    subject='Confirm your Shared IDE account change',
                    body=render_to_string('accounts/email/account_code.txt', context),
                    from_email=settings.DEFAULT_FROM_EMAIL, to=[user.email],
                )
                message.attach_alternative(render_to_string('accounts/email/account_code.html', context), 'text/html')
                deliver_message(message)
        except (SMTPException, OSError, ImproperlyConfigured, ValueError):
            # deliver_message logs safe transport metadata, never codes or addresses.
            return Response({'code': 'account_email_failed'}, status=503)
        return Response({'detail': 'Check your email for an account confirmation code.', 'retry_after': 60}, status=202)


class UsernameView(AccountMutationView):
    def post(self, request):
        try:
            with transaction.atomic():
                user = self.locked_user(request)
                if user is None:
                    return Response(status=401)
                serializer = UsernameSerializer(user, data=request.data)
                serializer.is_valid(raise_exception=True)
                error = self.confirm(request, user, serializer.validated_data)
                if error is not None:
                    return error
                # Save only the username, never client-supplied IDs/email/ownership.
                user.username = serializer.validated_data['username']
                user.save(update_fields=['username'])
                return Response({'user': UserSerializer(user).data})
        except IntegrityError:
            # The database unique constraint also protects concurrent updates.
            return Response({'username': ['This username is unavailable.']}, status=400)


class PasswordView(AccountMutationView):
    def post(self, request):
        with transaction.atomic():
            user = self.locked_user(request)
            if user is None:
                return Response(status=401)
            serializer = PasswordSerializer(data=request.data, context={'user': user})
            serializer.is_valid(raise_exception=True)
            error = self.confirm(request, user, serializer.validated_data)
            if error is not None:
                return error
            user.set_password(serializer.validated_data['password'])
            user.save(update_fields=['password'])
            AuthSession.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())
            AccountVerification.objects.filter(user=user).delete()
            # Preserve this browser with a new JWT session; all old sessions die.
            return begin_session(request, user)
