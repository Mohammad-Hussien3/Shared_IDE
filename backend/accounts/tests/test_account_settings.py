import re
from datetime import timedelta
from smtplib import SMTPException
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.db import IntegrityError
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.google import resolve_user
from accounts.models import AccountVerification, AuthSession, EmailVerification, GoogleIdentity
from workspace.models import Workspace


@override_settings(AUTH_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False,
                   EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class AccountSettingsTests(APITestCase):
    password = 'Original-secret!7524'
    replacement = 'A-different-secret!9274'

    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user('owner', email='owner@example.com', password=self.password)
        self.other = get_user_model().objects.create_user('other', email='other@example.com', password=self.password)
        self.workspace = Workspace.objects.create(owner=self.user, name='Private code')
        self.sign_in()

    def sign_in(self, user=None):
        user = user or self.user
        self.client = APIClient(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']
        refresh = RefreshToken.for_user(user)
        session = AuthSession.objects.create(user=user, refresh_jti=refresh['jti'],
                                            expires_at=timezone.now() + timedelta(days=1))
        refresh['sid'] = str(session.pk)
        self.session = session
        self.refresh = str(refresh)
        self.access = str(refresh.access_token)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = self.refresh
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {self.access}')

    def post(self, action, data=None):
        return self.client.post(f'/api/auth/{action}/', data or {}, format='json', HTTP_X_CSRFTOKEN=self.csrf)

    def google_only(self):
        self.user.set_unusable_password()
        self.user.save()
        GoogleIdentity.objects.create(user=self.user, subject='stable-google-subject')
        self.sign_in()

    def request_code(self):
        response = self.post('account/verification')
        self.assertEqual(response.status_code, 202, response.data)
        code = re.search(r'code is: ([0-9]{8})', mail.outbox[-1].body)[1]
        self.assertNotIn(code, str(response.data))
        self.assertEqual(mail.outbox[-1].to, [self.user.email])
        self.assertTrue(mail.outbox[-1].alternatives)
        self.assertNotEqual(AccountVerification.objects.get(user=self.user).code_hash, code)
        return code

    def password_data(self, **extra):
        return {'password': self.replacement, 'confirm_password': self.replacement, **extra}

    def test_get_account_information_and_authentication_required(self):
        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {'id': self.user.pk, 'username': 'owner', 'email': self.user.email,
                                        'google_connected': False, 'has_password': True})
        self.client.credentials()
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
        for endpoint in ['username', 'password', 'verification']:
            self.assertEqual(self.post(f'account/{endpoint}').status_code, 401)

    def test_username_change_preserves_id_ownership_and_ignores_other_accounts(self):
        response = self.post('account/username', {'username': 'renamed', 'current_password': self.password,
                                                'id': self.other.pk, 'email': 'attacker@example.com'})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['user']['id'], self.user.pk)
        self.assertEqual(response.data['user']['username'], 'renamed')
        self.user.refresh_from_db()
        self.other.refresh_from_db()
        self.assertEqual(self.user.email, 'owner@example.com')
        self.assertEqual(self.other.username, 'other')
        self.workspace.refresh_from_db()
        self.assertEqual(self.workspace.owner_id, self.user.pk)

    def test_invalid_duplicate_and_concurrently_taken_usernames(self):
        for name in ['other', 'bad/name', '', 'x' * 151]:
            with self.subTest(name=name):
                response = self.post('account/username', {'username': name, 'current_password': self.password})
                self.assertEqual(response.status_code, 400)
        with patch('django.contrib.auth.models.User.save', side_effect=IntegrityError):
            response = self.post('account/username', {'username': 'available', 'current_password': self.password})
        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, 'owner')

    def test_username_requires_current_password_or_single_use_email_proof(self):
        self.assertEqual(self.post('account/username', {'username': 'changed'}).status_code, 400)
        self.google_only()
        self.assertEqual(self.post('account/username', {'username': 'changed'}).status_code, 400)
        code = self.request_code()
        self.assertEqual(self.post('account/username', {'username': 'changed', 'verification_code': code}).status_code, 200)
        self.assertEqual(self.post('account/password', self.password_data(verification_code=code)).status_code, 400)

    def test_google_first_password_preserves_identity_workspace_and_allows_email_login(self):
        self.google_only()
        code = self.request_code()
        response = self.post('account/password', self.password_data(verification_code=code, id=self.other.pk))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data['user']['has_password'])
        self.assertTrue(response.cookies[settings.AUTH_REFRESH_COOKIE]['httponly'])
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.replacement))
        self.assertEqual(resolve_user('stable-google-subject', self.user.email).pk, self.user.pk)
        self.workspace.refresh_from_db()
        self.assertEqual(self.workspace.owner_id, self.user.pk)
        self.assertEqual(get_user_model().objects.count(), 2)
        self.csrf = response.data['csrf']
        login = self.post('login', {'username': self.user.email, 'password': self.replacement})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.data['user']['id'], self.user.pk)
        self.other.refresh_from_db()
        self.assertTrue(self.other.check_password(self.password))

    def test_password_change_revokes_old_tokens_and_returns_fresh_session(self):
        other_session = AuthSession.objects.create(user=self.user, refresh_jti='other', expires_at=timezone.now() + timedelta(days=1))
        response = self.post('account/password', self.password_data(current_password=self.password))
        self.assertEqual(response.status_code, 200)
        for session in [self.session, other_session]:
            session.refresh_from_db()
            self.assertIsNotNone(session.revoked_at)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
        self.csrf = response.data['csrf']
        replacement_cookie = response.cookies[settings.AUTH_REFRESH_COOKIE].value
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = self.refresh
        self.assertEqual(self.post('refresh').status_code, 401)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = replacement_cookie
        self.assertEqual(self.post('refresh').status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)

    def test_google_linked_password_user_still_requires_current_password(self):
        GoogleIdentity.objects.create(user=self.user, subject='linked-subject')
        for data in [self.password_data(), self.password_data(current_password='wrong'),
                     self.password_data(verification_code='12345678')]:
            self.assertEqual(self.post('account/password', data).status_code, 400)
        self.assertEqual(self.post('account/verification').status_code, 400)
        response = self.post('account/password', self.password_data(current_password=self.password))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['user']['google_connected'])
        self.assertEqual(resolve_user('linked-subject', self.user.email).pk, self.user.pk)

    def test_rejects_weak_mismatched_passwords_and_preserves_credentials(self):
        for data in [self.password_data(password='password', confirm_password='password'),
                     self.password_data(confirm_password='different')]:
            self.assertEqual(self.post('account/password', {**data, 'current_password': self.password}).status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.password))

    def test_codes_expire_are_session_bound_and_lock_after_five_attempts(self):
        self.google_only()
        code = self.request_code()
        original_session = self.session
        self.sign_in()
        self.assertEqual(self.post('account/password', self.password_data(verification_code=code)).status_code, 400)
        AccountVerification.objects.filter(user=self.user).update(session=self.session, expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.post('account/password', self.password_data(verification_code=code)).status_code, 400)
        AccountVerification.objects.filter(user=self.user).update(expires_at=timezone.now() + timedelta(minutes=5))
        for _ in range(5):
            wrong = '00000000' if code != '00000000' else '11111111'
            self.assertEqual(self.post('account/password', self.password_data(verification_code=wrong)).status_code, 400)
        self.assertEqual(self.post('account/password', self.password_data(verification_code=code)).status_code, 400)
        self.user.refresh_from_db()
        self.assertFalse(self.user.has_usable_password())
        self.assertNotEqual(original_session.pk, self.session.pk)

    def test_resend_cooldown_replaces_code_and_email_failures_roll_back(self):
        self.google_only()
        code = self.request_code()
        self.assertEqual(self.post('account/verification').status_code, 429)
        AccountVerification.objects.filter(user=self.user).update(sent_at=timezone.now() - timedelta(seconds=61))
        with patch('accounts.account_views.deliver_message', side_effect=SMTPException):
            self.assertEqual(self.post('account/verification').status_code, 503)
        with patch('accounts.account_views.secrets.randbelow', return_value=12345678 if code != '12345678' else 87654321):
            new_code = self.request_code()
        self.assertNotEqual(code, new_code)
        self.assertEqual(self.post('account/password', self.password_data(verification_code=code)).status_code, 400)
        self.assertEqual(self.post('account/password', self.password_data(verification_code=new_code)).status_code, 200)

    def test_endpoints_enforce_csrf_and_reject_foreign_origins(self):
        for action in ['username', 'password', 'verification']:
            path = f'/api/auth/account/{action}/'
            self.assertEqual(self.client.post(path, {}, format='json').status_code, 403)
            self.assertEqual(self.client.post(path, {}, format='json', HTTP_X_CSRFTOKEN=self.csrf,
                                             HTTP_ORIGIN='https://untrusted.example').status_code, 403)

    def test_unverified_password_account_cannot_use_settings(self):
        EmailVerification.objects.create(user=self.user, email=self.user.email)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
        self.assertEqual(self.post('account/password', self.password_data(current_password=self.password)).status_code, 401)

    def test_account_mutations_are_rate_limited(self):
        for _ in range(10):
            self.assertEqual(self.post('account/password', self.password_data(current_password='wrong')).status_code, 400)
        self.assertEqual(self.post('account/password', self.password_data(current_password=self.password)).status_code, 429)
