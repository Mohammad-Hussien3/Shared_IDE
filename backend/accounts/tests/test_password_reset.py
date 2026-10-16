import re
from datetime import timedelta
from smtplib import SMTPException
from unittest.mock import Mock, patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.db import IntegrityError
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.google import resolve_user
from accounts.models import AccountVerification, AuthSession, EmailVerification, GoogleIdentity, PasswordReset
from accounts.password_reset import RESET_MESSAGE, deliver_reset, enqueue_reset, send_reset
from accounts.verification import token_digest
from workspace.models import Workspace


@override_settings(AUTH_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False,
                   EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend',
                   FRONTEND_URL='https://ide.example.com', CORS_ALLOWED_ORIGINS=['https://ide.example.com'])
class PasswordResetTests(APITestCase):
    password = 'Original-secret!7524'
    replacement = 'Recovery-secret!9841'

    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user('owner', email='owner@example.com', password=self.password)
        EmailVerification.objects.create(user=self.user, email=self.user.email, verified_at=timezone.now())
        self.workspace = Workspace.objects.create(owner=self.user, name='Keep this workspace')
        self.client = APIClient(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']
        # The public request queues mail; tests execute delivery deterministically
        # against Django's in-memory mailbox instead of SMTP or worker threads.
        self.queue_patch = patch('accounts.password_reset_views.enqueue_reset')
        self.queue = self.queue_patch.start()
        self.addCleanup(self.queue_patch.stop)

    def post(self, action, data):
        return self.client.post('/api/auth/' + action + '/', data, format='json', HTTP_X_CSRFTOKEN=self.csrf)

    def issue(self):
        response = self.post('password-reset', {'email': self.user.email})
        self.assertEqual(response.status_code, 202)
        self.queue.assert_called_with(self.user.email)
        send_reset(self.user.email)
        return re.search(r'#token=([A-Za-z0-9_-]{43})', mail.outbox[-1].body)[1]

    def confirm(self, token, **extra):
        return self.post('password-reset/confirm', {
            'token': token, 'password': self.replacement, 'confirm_password': self.replacement, **extra,
        })

    def session(self):
        refresh = RefreshToken.for_user(self.user)
        session = AuthSession.objects.create(user=self.user, refresh_jti=refresh['jti'],
                                            expires_at=timezone.now() + timedelta(days=1))
        refresh['sid'] = str(session.pk)
        return session, refresh

    def test_email_contains_trusted_link_expiration_and_hash_only_storage(self):
        token = self.issue()
        message = mail.outbox[-1]
        self.assertEqual(message.subject, 'Reset your Shared IDE password')
        self.assertEqual(message.to, [self.user.email])
        self.assertIn('https://ide.example.com/reset-password#token=', message.body)
        self.assertIn('30 minutes', message.body)
        self.assertIn("If you didn't request", message.body)
        self.assertTrue(message.alternatives)
        record = PasswordReset.objects.get(user=self.user)
        self.assertEqual(record.token_hash, token_digest(token))
        self.assertEqual(record.expires_at - record.sent_at, timedelta(minutes=30))
        self.assertNotIn(token, str(record.__dict__))
        self.assertNotIn(self.user.password, str(record.__dict__))
        self.assertEqual(self.user.username, 'owner')

    def test_known_unknown_inactive_unverified_and_ambiguous_emails_have_same_response(self):
        inactive = get_user_model().objects.create_user('inactive', email='inactive@example.com', password=self.password, is_active=False)
        unverified = get_user_model().objects.create_user('unverified', email='unverified@example.com', password=self.password)
        EmailVerification.objects.create(user=unverified, email=unverified.email)
        get_user_model().objects.create_user('duplicate1', email='duplicate@example.com', password=self.password)
        get_user_model().objects.create_user('duplicate2', email='DUPLICATE@example.com', password=self.password)
        for email in [self.user.email, 'unknown@example.com', inactive.email, unverified.email, 'duplicate@example.com']:
            response = self.post('password-reset', {'email': email})
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.data, {'detail': RESET_MESSAGE})
            self.assertEqual(response['Cache-Control'], 'no-store')
            self.assertNotIn(settings.AUTH_REFRESH_COOKIE, response.cookies)
            send_reset(email)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(PasswordReset.objects.count(), 1)
        self.assertIsNone(EmailVerification.objects.get(user=unverified).verified_at)

    def test_reset_is_single_use_and_login_requires_new_password(self):
        token = self.issue()
        result = self.confirm(token, user_id=999999, email='attacker@example.com')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.data, {'code': 'password_reset'})
        self.assertEqual(AuthSession.objects.count(), 0)
        self.assertEqual(result.cookies[settings.AUTH_REFRESH_COOKIE]['max-age'], 0)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.replacement))
        self.assertEqual(self.user.email, 'owner@example.com')
        self.assertEqual(self.confirm(token).data['code'], 'reset_used')
        self.assertEqual(self.post('login', {'username': self.user.email, 'password': self.password}).status_code, 401)
        login = self.post('login', {'username': self.user.email, 'password': self.replacement})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.data['user']['id'], self.user.pk)

    def test_invalid_expired_and_malformed_tokens(self):
        token = self.issue()
        PasswordReset.objects.filter(user=self.user).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.confirm(token).data['code'], 'reset_expired')
        for value in ['', 'invalid', 'a' * 43, None, [], 123]:
            with self.subTest(token=value):
                response = self.confirm(value)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data['code'], 'reset_invalid')
        self.assertEqual(self.post('password-reset/confirm', []).status_code, 400)

    def test_weak_and_mismatched_passwords_do_not_consume_the_link(self):
        token = self.issue()
        for data in [{'password': 'password', 'confirm_password': 'password'},
                     {'password': '12345678', 'confirm_password': '12345678'},
                     {'confirm_password': 'mismatch'}]:
            self.assertEqual(self.confirm(token, **data).status_code, 400)
            self.assertIsNone(PasswordReset.objects.get(user=self.user).used_at)
        self.assertEqual(self.confirm(token).status_code, 200)

    def test_all_old_sessions_and_account_confirmation_codes_are_invalidated(self):
        first_session, first_refresh = self.session()
        second_session, second_refresh = self.session()
        AccountVerification.objects.create(user=self.user, session=first_session, code_hash='a' * 64,
                                           email=self.user.email, sent_at=timezone.now(), expires_at=timezone.now() + timedelta(minutes=10))
        token = self.issue()
        self.assertEqual(self.confirm(token).status_code, 200)
        for session, refresh in [(first_session, first_refresh), (second_session, second_refresh)]:
            session.refresh_from_db()
            self.assertIsNotNone(session.revoked_at)
            self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {refresh.access_token}')
            self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
            self.assertEqual(self.client.get(f'/api/workspaces/{self.workspace.pk}/').status_code, 401)
            self.client.cookies[settings.AUTH_REFRESH_COOKIE] = str(refresh)
            self.assertEqual(self.post('refresh', {}).status_code, 401)
        self.assertFalse(AccountVerification.objects.filter(user=self.user).exists())
        self.workspace.refresh_from_db()
        self.assertEqual(self.workspace.owner_id, self.user.pk)

    def test_google_only_user_sets_password_without_changing_identity_or_ownership(self):
        EmailVerification.objects.filter(user=self.user).delete()
        self.user.set_unusable_password()
        self.user.save()
        GoogleIdentity.objects.create(user=self.user, subject='stable-google-subject')
        token = self.issue()
        self.assertEqual(self.confirm(token).status_code, 200)
        self.assertEqual(resolve_user('stable-google-subject', self.user.email).pk, self.user.pk)
        self.assertEqual(GoogleIdentity.objects.get().user_id, self.user.pk)
        self.assertEqual(get_user_model().objects.count(), 1)
        self.workspace.refresh_from_db()
        self.assertEqual(self.workspace.owner_id, self.user.pk)
        login = self.post('login', {'username': self.user.email, 'password': self.replacement})
        self.assertEqual(login.status_code, 200)
        self.assertTrue(login.data['user']['google_connected'])

    def test_new_link_replaces_old_link_and_cooldown_prevents_email_flooding(self):
        first = self.issue()
        self.assertEqual(self.issue(), first)
        self.assertEqual(len(mail.outbox), 1)
        PasswordReset.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))
        second = self.issue()
        self.assertNotEqual(first, second)
        self.assertEqual(self.confirm(first).data['code'], 'reset_invalid')
        self.assertEqual(self.confirm(second).status_code, 200)

    def test_other_password_or_email_changes_invalidate_outstanding_link(self):
        token = self.issue()
        self.user.set_password('Changed-elsewhere!3791')
        self.user.save()
        self.assertEqual(self.confirm(token).data['code'], 'reset_invalid')
        PasswordReset.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))
        token = self.issue()
        self.user.email = 'changed@example.com'
        self.user.save()
        self.assertEqual(self.confirm(token).data['code'], 'reset_invalid')

    def test_delivery_failure_rolls_back_new_token_and_never_leaks_details(self):
        token = self.issue()
        PasswordReset.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))
        with patch('accounts.password_reset.deliver_message', side_effect=SMTPException('private-secret')):
            with self.assertRaises(SMTPException):
                send_reset(self.user.email)
        self.assertEqual(PasswordReset.objects.get(user=self.user).token_hash, token_digest(token))
        self.assertEqual(self.post('password-reset', {'email': self.user.email}).data, {'detail': RESET_MESSAGE})

    def test_request_and_confirmation_are_rate_limited_and_csrf_protected(self):
        for endpoint in ['password-reset', 'password-reset/confirm']:
            url = f'/api/auth/{endpoint}/'
            self.assertEqual(self.client.get(url).status_code, 405)
            self.assertEqual(self.client.post(url, {}, format='json').status_code, 403)
            self.assertEqual(self.client.post(url, {}, format='json', HTTP_X_CSRFTOKEN=self.csrf,
                                             HTTP_ORIGIN='https://attacker.example').status_code, 403)
        cache.clear()
        for _ in range(5):
            self.assertEqual(self.post('password-reset', {'email': 'unknown@example.com'}).status_code, 202)
        self.assertEqual(self.post('password-reset', {'email': self.user.email}).status_code, 429)
        cache.clear()
        for _ in range(10):
            self.assertEqual(self.confirm('invalid').status_code, 400)
        self.assertEqual(self.confirm('invalid').status_code, 429)

    @override_settings(FRONTEND_URL='https://untrusted.example')
    def test_untrusted_frontend_configuration_never_sends_a_link(self):
        with self.assertRaises(ImproperlyConfigured):
            send_reset(self.user.email)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(PasswordReset.objects.exists())

    def test_failed_password_save_rolls_back_token_consumption(self):
        token = self.issue()
        with patch('django.contrib.auth.models.User.save', side_effect=IntegrityError):
            with self.assertRaises(IntegrityError):
                self.confirm(token)
        self.assertIsNone(PasswordReset.objects.get(user=self.user).used_at)
        self.assertEqual(self.confirm(token).status_code, 200)


class PasswordResetQueueTests(SimpleTestCase):
    @patch('accounts.password_reset._slots')
    @patch('accounts.password_reset._executor')
    def test_queue_does_not_lookup_users_or_send_smtp_in_the_request(self, executor, slots):
        slots.acquire.return_value = True
        for email in ['registered@example.com', 'unknown@example.com']:
            enqueue_reset(email)
            executor.submit.assert_called_with(deliver_reset, email)
        slots.acquire.assert_called_with(blocking=False)
        slots.release.assert_not_called()

    @patch('accounts.password_reset._slots')
    @patch('accounts.password_reset._executor')
    def test_full_or_stopped_queue_has_no_email_dependent_response(self, executor, slots):
        slots.acquire.return_value = False
        self.assertIsNone(enqueue_reset('owner@example.com'))
        executor.submit.assert_not_called()
        slots.acquire.return_value = True
        executor.submit.side_effect = RuntimeError
        self.assertIsNone(enqueue_reset('owner@example.com'))
        slots.release.assert_called_once()

    @patch('accounts.password_reset.close_old_connections')
    @patch('accounts.password_reset._slots')
    @patch('accounts.password_reset.send_reset')
    def test_worker_errors_are_sanitized_and_capacity_is_released(self, send, slots, close):
        send.side_effect = SMTPException('private-token private-address')
        with self.assertLogs('accounts.password_reset', level='ERROR') as logs:
            deliver_reset('owner@example.com')
        self.assertNotIn('private', str(logs.output))
        self.assertNotIn('owner@example.com', str(logs.output))
        slots.release.assert_called_once()
        self.assertEqual(close.call_count, 2)
