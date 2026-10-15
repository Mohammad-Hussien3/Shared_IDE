import re
from datetime import timedelta
from smtplib import SMTPException, SMTPAuthenticationError, SMTPServerDisconnected
from types import SimpleNamespace
from unittest.mock import ANY, Mock, patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import AuthSession, EmailVerification, GoogleIdentity
from accounts.verification import consume_verification, deliver_message, send_verification, token_digest
from accounts.views import token_expiry
from workspace.models import Workspace


class EmailConnectionTests(SimpleTestCase):
    def test_delivery_uses_django_connection_factory_without_message_get_connection(self):
        message = SimpleNamespace(connection=None, send=Mock(return_value=1))
        with patch('accounts.verification.get_connection') as factory:
            connection = factory.return_value
            deliver_message(message)
        factory.assert_called_once_with(fail_silently=False)
        self.assertIs(message.connection, connection)
        connection.open.assert_called_once_with()
        message.send.assert_called_once_with(fail_silently=False)
        connection.close.assert_called_once_with()

    def test_delivery_reuses_an_explicit_message_connection(self):
        connection = Mock()
        message = SimpleNamespace(connection=connection, send=Mock(return_value=1))
        with patch('accounts.verification.get_connection') as factory:
            deliver_message(message)
        factory.assert_not_called()
        connection.open.assert_called_once_with()
        message.send.assert_called_once_with(fail_silently=False)
        connection.close.assert_called_once_with()


@override_settings(DEBUG=True, AUTH_COOKIE_SECURE=False,
    FRONTEND_URL='http://localhost:5173', CORS_ALLOWED_ORIGINS=['http://localhost:5173'],
    EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class EmailVerificationTests(APITestCase):
    password = 'Verification-password!517'

    def setUp(self):
        cache.clear()
        self.client = APIClient(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']

    def post(self, action, data=None):
        result = self.client.post(f'/api/auth/{action}/', data or {}, format='json', HTTP_X_CSRFTOKEN=self.csrf)
        if result.data.get('csrf'):
            self.csrf = result.data['csrf']
        return result

    def register(self, **overrides):
        payload = {'username': 'alice', 'email': 'Alice@example.com', 'password': self.password, 'confirm_password': self.password}
        return self.post('register', {**payload, **overrides})

    def token(self):
        return re.search(r'#token=([A-Za-z0-9_-]+)', mail.outbox[-1].body)[1]

    def login(self, identifier='alice'):
        return self.post('login', {'username': identifier, 'password': self.password})

    def allow_resend(self):
        EmailVerification.objects.update(sent_at=timezone.now() - timedelta(seconds=61))

    def test_signup_creates_unverified_account_and_no_session(self):
        result = self.register()
        self.assertEqual(result.status_code, 201)
        user = get_user_model().objects.get()
        record = EmailVerification.objects.get(user=user)
        self.assertTrue(user.check_password(self.password))
        self.assertEqual(user.email, 'alice@example.com')
        self.assertIsNone(record.verified_at)
        self.assertNotIn('access', result.data)
        self.assertNotIn(settings.AUTH_REFRESH_COOKIE, result.cookies)
        self.assertFalse(AuthSession.objects.exists())
        self.assertEqual(self.post('refresh').status_code, 401)
        self.assertEqual(self.client.get('/api/workspaces/').status_code, 401)

    def test_email_has_plain_and_html_templates_and_only_digest_is_stored(self):
        before = timezone.now()
        self.register()
        self.assertEqual(len(mail.outbox), 1)
        email = mail.outbox[0]
        self.assertEqual(email.subject, 'Verify your Shared IDE email address')
        self.assertEqual(email.to, ['alice@example.com'])
        self.assertEqual(email.from_email, settings.DEFAULT_FROM_EMAIL)
        self.assertIn('30 minutes', email.body)
        self.assertIn('did not create', email.body)
        self.assertIn('http://localhost:5173/verify-email#token=', email.body)
        self.assertEqual(email.alternatives[0].mimetype, 'text/html')
        self.assertIn('Verify Email', email.alternatives[0].content)
        record = EmailVerification.objects.get()
        token = self.token()
        self.assertEqual(record.token_hash, token_digest(token))
        self.assertNotIn(token, str(record.__dict__))
        self.assertGreaterEqual(record.expires_at, before + timedelta(minutes=30))
        self.assertLessEqual(record.expires_at, timezone.now() + timedelta(minutes=30))

    def test_valid_token_verifies_once_without_issuing_tokens(self):
        self.register()
        token = self.token()
        result = self.post('verify-email', {'token': token})
        self.assertEqual(result.data, {'code': 'email_verified'})
        self.assertIsNotNone(EmailVerification.objects.get().verified_at)
        self.assertFalse(AuthSession.objects.exists())
        self.assertNotIn(settings.AUTH_REFRESH_COOKIE, result.cookies)
        result = self.post('verify-email', {'token': token})
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.data['code'], 'verification_used')

    def test_expired_missing_and_invalid_links_are_rejected(self):
        self.register()
        EmailVerification.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.post('verify-email', {'token': self.token()}).data['code'], 'verification_expired')
        for token in ['wrong', 'a' * 43, '', None, ['bad'], 'a' * 129]:
            with self.subTest(token=token):
                self.assertEqual(self.post('verify-email', {'token': token}).status_code, 400)
        self.assertIsNone(EmailVerification.objects.get().verified_at)

    def test_stale_reads_cannot_consume_a_link_twice_or_bypass_resend_cooldown(self):
        self.register()
        token = self.token()
        stale = EmailVerification.objects.get()
        stale.sent_at = None
        self.assertFalse(send_verification(stale))
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(consume_verification(token), 'email_verified')
        verified = EmailVerification.objects.get()
        # Simulate a second request that read the row before the first finished.
        with patch('django.db.models.query.QuerySet.first', side_effect=[stale, verified]):
            self.assertEqual(consume_verification(token), 'verification_used')
        self.assertEqual(EmailVerification.objects.get().verified_at, verified.verified_at)
        self.assertFalse(send_verification(stale))
        self.assertEqual(len(mail.outbox), 1)

    def test_unverified_login_rejected_but_incorrect_password_does_not_reveal_status(self):
        self.register()
        for identifier in ['alice', 'ALICE@EXAMPLE.COM']:
            result = self.login(identifier)
            self.assertEqual(result.status_code, 403)
            self.assertEqual(result.data['code'], 'email_unverified')
            self.assertNotIn(settings.AUTH_REFRESH_COOKIE, result.cookies)
        self.assertEqual(self.post('login', {'username': 'alice', 'password': 'wrong'}).status_code, 401)
        self.assertFalse(AuthSession.objects.exists())

    def test_verified_email_login_refresh_and_workspace_ownership(self):
        self.register()
        self.post('verify-email', {'token': self.token()})
        result = self.login('ALICE@example.com')
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.cookies[settings.AUTH_REFRESH_COOKIE]['httponly'])
        self.assertEqual(self.post('refresh').status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {result.data['access']}")
        created = self.client.post('/api/workspaces/', {'name': 'Mine'}, format='json')
        self.assertEqual(created.status_code, 201)
        self.assertEqual(Workspace.objects.get().owner, get_user_model().objects.get(username='alice'))
        other = get_user_model().objects.create_user('other')
        private = Workspace.objects.create(owner=other, name='Private')
        self.assertEqual(self.client.get(f'/api/workspaces/{private.pk}/').status_code, 404)

    def test_preexisting_refresh_and_access_cannot_bypass_verification(self):
        self.register()
        user = get_user_model().objects.get()
        refresh = RefreshToken.for_user(user)
        session = AuthSession.objects.create(user=user, refresh_jti=refresh['jti'], expires_at=token_expiry(refresh))
        refresh['sid'] = str(session.pk)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = str(refresh)
        self.assertEqual(self.post('refresh').data['code'], 'email_unverified')
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {refresh.access_token}')
        self.assertEqual(self.client.get('/api/workspaces/').status_code, 401)

    def test_resend_cooldown_replaces_previous_link_after_one_minute(self):
        self.register()
        first = self.token()
        result = self.post('resend-verification', {'email': 'ALICE@example.com'})
        self.assertEqual(result.status_code, 202)
        self.assertEqual(len(mail.outbox), 1)
        self.allow_resend()
        self.assertEqual(self.post('resend-verification', {'email': 'alice@example.com'}).status_code, 202)
        self.assertEqual(len(mail.outbox), 2)
        self.assertNotEqual(first, self.token())
        self.assertEqual(self.post('verify-email', {'token': first}).data['code'], 'verification_invalid')
        self.assertEqual(self.post('verify-email', {'token': self.token()}).data['code'], 'email_verified')

    def test_resend_does_not_disclose_unknown_verified_google_or_inactive_accounts(self):
        self.register()
        self.post('verify-email', {'token': self.token()})
        google_user = get_user_model().objects.create_user('google', email='google@example.com')
        GoogleIdentity.objects.create(user=google_user, subject='stable-subject')
        results = [self.post('resend-verification', {'email': email}) for email in ['alice@example.com', 'unknown@example.com', 'google@example.com']]
        self.assertTrue(all(result.status_code == 202 for result in results))
        self.assertEqual(results[0].data, results[1].data)
        self.assertEqual(results[1].data, results[2].data)
        self.assertEqual(len(mail.outbox), 1)

    def test_resend_rate_limit_applies_to_unknown_addresses_too(self):
        for index in range(5):
            self.assertEqual(self.post('resend-verification', {'email': f'unknown{index}@example.com'}).status_code, 202)
        result = self.post('resend-verification', {'email': 'new@example.com'})
        self.assertEqual(result.status_code, 429)
        self.assertIn('Retry-After', result)

    def test_signup_validates_email_password_and_case_insensitive_duplicates(self):
        for payload in [{'email': ''}, {'email': 'invalid'}, {'password': 'password', 'confirm_password': 'password'}]:
            self.assertEqual(self.register(**payload).status_code, 400)
        self.assertFalse(get_user_model().objects.exists())
        self.register()
        self.assertEqual(self.register(username='different', email='ALICE@EXAMPLE.COM').status_code, 400)
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_signup_delivery_failure_rolls_back_account_and_token(self):
        with patch('accounts.verification.EmailMultiAlternatives.send', side_effect=SMTPException('private credentials')):
            result = self.register()
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.data, {'code': 'email_delivery_failed'})
        self.assertFalse(get_user_model().objects.exists())
        self.assertFalse(EmailVerification.objects.exists())

    @override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend',
        EMAIL_HOST='smtp.test.invalid', EMAIL_PORT=587, EMAIL_USE_TLS=True, EMAIL_USE_SSL=False,
        EMAIL_HOST_USER='test-smtp-user', EMAIL_HOST_PASSWORD='test-smtp-password',
        DEFAULT_FROM_EMAIL='Shared IDE <sender@example.com>')
    def test_registration_uses_smtp_with_starttls_and_configured_credentials(self):
        with patch('django.core.mail.backends.smtp.smtplib.SMTP') as transport:
            smtp = transport.return_value
            smtp.sendmail.return_value = {}
            result = self.register()
        self.assertEqual(result.status_code, 201)
        transport.assert_called_once_with('smtp.test.invalid', 587, local_hostname=ANY, timeout=settings.EMAIL_TIMEOUT)
        smtp.starttls.assert_called_once()
        smtp.login.assert_called_once_with('test-smtp-user', 'test-smtp-password')
        sender, recipients, message = smtp.sendmail.call_args.args
        self.assertEqual(sender, 'sender@example.com')
        self.assertEqual(recipients, ['alice@example.com'])
        self.assertIn(b'Verify your Shared IDE email address', message)
        self.assertIn(b'text/plain', message)
        self.assertIn(b'text/html', message)
        smtp.quit.assert_called_once()
        self.assertFalse(AuthSession.objects.exists())

    @override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend',
        EMAIL_HOST='smtp.test.invalid', EMAIL_PORT=587, EMAIL_USE_TLS=True, EMAIL_USE_SSL=False,
        EMAIL_HOST_USER='test-smtp-user', EMAIL_HOST_PASSWORD='test-smtp-password')
    def test_smtp_authentication_failure_is_safe_and_rolls_back_registration(self):
        with patch('django.core.mail.backends.smtp.smtplib.SMTP') as transport:
            transport.return_value.login.side_effect = SMTPAuthenticationError(535, b'private provider response')
            with self.assertLogs('accounts.views', level='ERROR') as logs:
                result = self.register()
            transport.return_value.sendmail.assert_not_called()
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.data, {'code': 'email_delivery_failed'})
        self.assertIn('SMTPAuthenticationError', logs.output[0])
        self.assertNotIn('private provider response', logs.output[0])
        self.assertNotIn('test-smtp-password', logs.output[0])
        self.assertFalse(get_user_model().objects.exists())
        self.assertFalse(EmailVerification.objects.exists())

    @override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend',
        EMAIL_HOST='smtp.test.invalid', EMAIL_PORT=587, EMAIL_USE_TLS=True, EMAIL_USE_SSL=False,
        EMAIL_HOST_USER='test-smtp-user', EMAIL_HOST_PASSWORD='test-smtp-password', EMAIL_TIMEOUT=17)
    def test_smtp_disconnects_timeout_and_tls_failure_close_connections_and_log_safe_metadata(self):
        for phase, method, failure in [
            ('connect_tls_auth', 'starttls', SMTPException('private TLS response')),
            ('connect_tls_auth', 'login', SMTPServerDisconnected('private authentication response')),
            ('message_submission', 'sendmail', SMTPServerDisconnected('private recipient and code')),
            ('message_submission', 'sendmail', TimeoutError('private timeout')),
        ]:
            with self.subTest(method=method, error=type(failure).__name__):
                with patch('django.core.mail.backends.smtp.smtplib.SMTP') as transport:
                    smtp = transport.return_value
                    getattr(smtp, method).side_effect = failure
                    with self.assertLogs('accounts.verification', level='ERROR') as logs:
                        result = self.register()
                    smtp.quit.assert_called_once()
                    self.assertEqual(transport.call_args.kwargs['timeout'], 17)
                    if method != 'sendmail':
                        smtp.sendmail.assert_not_called()
                self.assertEqual(result.status_code, 503)
                self.assertIn(f'phase={phase}', logs.output[0])
                self.assertIn(f'error={type(failure).__name__}', logs.output[0])
                self.assertNotIn('private', logs.output[0])
                self.assertFalse(get_user_model().objects.exists())
                self.assertFalse(EmailVerification.objects.exists())

    @override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend',
        EMAIL_HOST='smtp.test.invalid', EMAIL_PORT=587, EMAIL_USE_TLS=True, EMAIL_USE_SSL=False,
        EMAIL_HOST_USER='test-smtp-user', EMAIL_HOST_PASSWORD='test-smtp-password')
    def test_quit_failure_after_smtp_acceptance_does_not_invalidate_emailed_token(self):
        with patch('django.core.mail.backends.smtp.smtplib.SMTP') as transport:
            transport.return_value.sendmail.return_value = {}
            transport.return_value.quit.side_effect = SMTPException('private QUIT response')
            with self.assertLogs('accounts.verification', level='WARNING') as logs:
                result = self.register()
            transport.return_value.close.assert_called_once()
        self.assertEqual(result.status_code, 201)
        self.assertTrue(EmailVerification.objects.exists())
        self.assertIn('phase=connection_cleanup', logs.output[0])
        self.assertNotIn('private', logs.output[0])

    def test_resend_delivery_failure_preserves_old_link_and_generic_response(self):
        self.register()
        original = self.token()
        self.allow_resend()
        with patch('accounts.verification.EmailMultiAlternatives.send', side_effect=SMTPException('private')):
            result = self.post('resend-verification', {'email': 'alice@example.com'})
        self.assertEqual(result.status_code, 202)
        self.assertEqual(self.post('verify-email', {'token': original}).data['code'], 'email_verified')

    def test_disabled_account_or_changed_email_cannot_consume_or_resend_link(self):
        self.register()
        user = get_user_model().objects.get()
        self.allow_resend()
        for changes in [{'is_active': False}, {'is_active': True, 'email': 'changed@example.com'}]:
            get_user_model().objects.filter(pk=user.pk).update(**changes)
            self.assertEqual(self.post('verify-email', {'token': self.token()}).data['code'], 'verification_invalid')
            self.assertEqual(self.post('resend-verification', {'email': 'alice@example.com'}).status_code, 202)
        self.assertEqual(len(mail.outbox), 1)

    def test_verification_post_requires_csrf_and_get_does_not_consume(self):
        self.register()
        for action in ['verify-email', 'resend-verification']:
            self.assertEqual(self.client.post(f'/api/auth/{action}/', {}).status_code, 403)
        self.assertEqual(self.client.get('/api/auth/verify-email/', {'token': self.token()}).status_code, 405)
        self.assertIsNone(EmailVerification.objects.get().verified_at)

    @override_settings(FRONTEND_URL='https://evil.example')
    def test_untrusted_frontend_configuration_cannot_send_verification_link(self):
        self.assertEqual(self.register().status_code, 503)
        self.assertFalse(get_user_model().objects.exists())

    def test_existing_password_accounts_continue_to_work(self):
        get_user_model().objects.create_user('alice', password=self.password)
        self.assertEqual(self.login().status_code, 200)
