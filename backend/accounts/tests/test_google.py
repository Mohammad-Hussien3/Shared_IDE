import base64
import hashlib
import time
from datetime import timedelta
from unittest.mock import patch, Mock
from urllib.parse import parse_qs, urlsplit

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone
from joserfc import jwt
from joserfc.jwk import RSAKey
from requests.exceptions import Timeout
from rest_framework.test import APIClient, APITestCase

from accounts import google
from accounts.models import AuthSession, GoogleAuthAttempt, GoogleIdentity
from workspace.models import Workspace


class GoogleUsernameTests(TestCase):
    def create_user(self, name):
        number = GoogleIdentity.objects.count() + 1
        user = google.resolve_user(f'subject-{number}', f'user{number}@example.com', name=name)
        field = user._meta.get_field('username')
        field.run_validators(user.username)
        self.assertFalse(user.has_usable_password())
        return user

    def test_duplicate_names_get_numbered_suffixes(self):
        existing = get_user_model().objects.create_user('mohammad_hussein', password='Existing-password!42')
        self.assertEqual(self.create_user('Mohammad Hussein').username, 'mohammad_hussein2')
        self.assertEqual(self.create_user('Mohammad Hussein').username, 'mohammad_hussein3')
        existing.refresh_from_db()
        self.assertTrue(existing.check_password('Existing-password!42'))

    def test_existing_name_with_different_case_is_avoided(self):
        get_user_model().objects.create_user('Mohammad_Hussein')
        self.assertEqual(self.create_user('Mohammad Hussein').username, 'mohammad_hussein2')

    def test_missing_empty_and_unusable_names_get_unique_fallbacks(self):
        for index, name in enumerate([None, '', '   ', '✨!!!', 123, {}], start=1):
            with self.subTest(name=name):
                suffix = str(index) if index > 1 else ''
                self.assertEqual(self.create_user(name).username, f'google_user{suffix}')

    def test_special_characters_whitespace_and_unicode(self):
        for name, expected in [
            ('  Mohammad\t Hussein\n', 'mohammad_hussein'),
            ("Renée O’Connor! ✨", 'renée_oconnor'),
            ('Jean-Luc / Smith', 'jean-luc__smith'),
            ('محمد حسين', 'محمد_حسين'),
            ('Ｍｏｈａｍｍａｄ', 'mohammad'),
        ]:
            with self.subTest(name=name):
                self.assertEqual(self.create_user(name).username, expected)

    def test_long_names_reserve_room_for_unique_suffix(self):
        limit = get_user_model()._meta.get_field('username').max_length
        self.assertEqual(self.create_user('A' * (limit + 20)).username, 'a' * limit)
        self.assertEqual(self.create_user('A' * (limit + 20)).username, 'a' * (limit - 1) + '2')


@override_settings(
    DEBUG=True, AUTH_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False,
    GOOGLE_CLIENT_ID='google-test-client', GOOGLE_CLIENT_SECRET='test-only-secret',
    GOOGLE_FRONTEND_ORIGIN='http://localhost:5173',
    GOOGLE_REDIRECT_URI='http://localhost:5173/api/auth/google/callback/',
    CORS_ALLOWED_ORIGINS=['http://localhost:5173'],
    CSRF_TRUSTED_ORIGINS=['http://localhost:5173'],
)
class GoogleAuthenticationTests(APITestCase):
    password = 'Password-confirmation!473'

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.key = RSAKey.generate_key(2048, parameters={'kid': 'google-test'})

    def setUp(self):
        cache.clear()
        self.client = APIClient(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']
        self.token_patch = patch('accounts.google.OAuth2Session.fetch_token')
        self.fetch_token = self.token_patch.start()
        self.addCleanup(self.token_patch.stop)
        self.keys_patch = patch('accounts.google.requests.get')
        self.get_keys = self.keys_patch.start()
        self.addCleanup(self.keys_patch.stop)
        self.get_keys.return_value = Mock(json=lambda: {'keys': [self.key.as_dict(private=False)]})

    def post(self, path, data=None):
        result = self.client.post('/api/auth/' + path + '/', data or {}, format='json',
                                  HTTP_X_CSRFTOKEN=self.csrf, HTTP_ORIGIN='http://localhost:5173')
        if isinstance(result.data, dict) and result.data.get('csrf'):
            self.csrf = result.data['csrf']
        return result

    def start(self, path='google/start', data=None):
        result = self.post(path, data)
        self.assertEqual(result.status_code, 200, result.data)
        self.params = {key: values[0] for key, values in parse_qs(urlsplit(result.data['authorization_url']).query).items()}
        self.attempt = GoogleAuthAttempt.objects.get(state_hash=google.digest(self.params['state']))
        return result

    def sign(self, overrides=None, key=None, remove=()):
        claims = {
            'iss': 'https://accounts.google.com', 'aud': settings.GOOGLE_CLIENT_ID,
            'sub': 'google-stable-subject', 'email': 'new@example.com', 'email_verified': True,
            'nonce': self.attempt.nonce, 'iat': int(time.time()), 'exp': int(time.time()) + 300,
        }
        claims.update(overrides or {})
        for field in remove:
            claims.pop(field, None)
        return jwt.encode({'alg': 'RS256', 'kid': 'google-test'}, claims, key or self.key)

    def callback(self, overrides=None, remove=(), error=None, key=None):
        self.fetch_token.return_value = {'id_token': self.sign(overrides, key, remove), 'access_token': 'google-private-access'}
        query = {'state': self.params['state'], 'code': 'google-one-time-code'}
        if error:
            query = {'state': self.params['state'], 'error': error}
        return self.client.get('/api/auth/google/callback/', query)

    def assert_result(self, response, result):
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], f'http://localhost:5173/auth/google/callback?result={result}')
        self.assertNotIn('access', response['Location'])
        self.assertNotIn('refresh', response['Location'])
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(response['Referrer-Policy'], 'no-referrer')

    def login_password(self, user):
        result = self.post('login', {'username': user.username, 'password': self.password})
        self.assertEqual(result.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {result.data['access']}")
        return result

    def test_start_csrf_pkce_nonce_and_browser_cookie(self):
        self.assertEqual(self.client.get('/api/auth/google/start/').status_code, 405)
        self.assertEqual(self.client.post('/api/auth/google/start/', {}).status_code, 403)
        result = self.start()
        self.assertEqual(self.params['scope'], 'openid email profile')
        self.assertEqual(self.params['response_type'], 'code')
        self.assertEqual(self.params['redirect_uri'], settings.GOOGLE_REDIRECT_URI)
        self.assertEqual(self.params['code_challenge_method'], 'S256')
        expected = base64.urlsafe_b64encode(hashlib.sha256(self.attempt.code_verifier.encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(self.params['code_challenge'], expected)
        self.assertEqual(self.params['nonce'], self.attempt.nonce)
        self.assertNotIn(self.attempt.code_verifier, result.data['authorization_url'])
        self.assertNotIn(settings.GOOGLE_CLIENT_SECRET, result.data['authorization_url'])
        cookie = result.cookies[google.FLOW_COOKIE]
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Lax')
        self.assertEqual(cookie['path'], google.FLOW_COOKIE_PATH)
        self.fetch_token.assert_not_called()
        self.get_keys.assert_not_called()

    def test_first_login_creates_user_cookie_session_and_owned_workspace(self):
        self.start()
        response = self.callback({'name': 'Mohammad Hussein'})
        self.assert_result(response, 'google_success')
        user = get_user_model().objects.get()
        self.assertFalse(user.has_usable_password())
        self.assertEqual(user.username, 'mohammad_hussein')
        self.assertEqual(user.email, 'new@example.com')
        self.assertEqual(GoogleIdentity.objects.get().user, user)
        self.assertEqual(GoogleIdentity.objects.get().subject, 'google-stable-subject')
        self.assertTrue(response.cookies[settings.AUTH_REFRESH_COOKIE]['httponly'])
        self.assertFalse(GoogleAuthAttempt.objects.exists())
        self.assertEqual(response.content, b'')
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']
        restored = self.post('refresh')
        self.assertEqual(restored.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {restored.data['access']}")
        created = self.client.post('/api/workspaces/', {'name': 'Google project'}, format='json')
        self.assertEqual(created.status_code, 201)
        self.assertEqual(Workspace.objects.get().owner, user)
        self.fetch_token.assert_called_once_with(google.TOKEN_URL, grant_type='authorization_code',
            code='google-one-time-code', code_verifier=self.attempt.code_verifier, timeout=10, allow_redirects=False)
        self.get_keys.assert_called_once_with(google.JWKS_URL, timeout=10, allow_redirects=False)

    def test_returning_subject_keeps_workspaces_even_when_email_changes(self):
        user = get_user_model().objects.create_user('owner', email='old@example.com')
        GoogleIdentity.objects.create(user=user, subject='google-stable-subject')
        workspace = Workspace.objects.create(owner=user, name='Existing project')
        stranger = get_user_model().objects.create_user('stranger', email='new@example.com')
        private = Workspace.objects.create(owner=stranger, name='Other project')
        self.start()
        self.assert_result(self.callback({'name': 'Changed Profile Name'}), 'google_success')
        user.refresh_from_db()
        self.assertEqual(user.username, 'owner')
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']
        restored = self.post('refresh')
        self.assertEqual(restored.data['user']['id'], user.pk)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {restored.data['access']}")
        self.assertEqual([item['id'] for item in self.client.get('/api/workspaces/').data], [str(workspace.pk)])
        self.assertEqual(self.client.get(f'/api/workspaces/{private.pk}/').status_code, 404)
        self.assertEqual(get_user_model().objects.count(), 2)

    def test_missing_profile_name_still_signs_in(self):
        self.start()
        self.assert_result(self.callback(), 'google_success')
        user = get_user_model().objects.get()
        self.assertEqual(user.username, 'google_user')
        self.assertFalse(user.has_usable_password())

    def test_invalid_signed_claims_never_create_a_session(self):
        cases = [
            {'iss': 'https://evil.example'}, {'aud': 'another-client'}, {'exp': 1},
            {'iat': int(time.time()) + 3600}, {'nonce': 'wrong'}, {'sub': ''}, {'sub': 12},
            {'email_verified': False}, {'email_verified': 'true'}, {'email': 'invalid'},
            {'azp': 'another-client'}, {'aud': ['google-test-client', 'other-client']},
        ]
        for claims in cases:
            with self.subTest(claims=claims):
                self.start()
                self.assert_result(self.callback(claims), 'google_failed')
                self.assertEqual(AuthSession.objects.count(), 0)
        for field in ['exp', 'iat', 'sub', 'nonce', 'aud', 'iss', 'email']:
            with self.subTest(missing=field):
                self.start()
                self.assert_result(self.callback(remove=[field]), 'google_failed')
        self.assertFalse(get_user_model().objects.exists())

    def test_invalid_signature_and_unsigned_tokens_are_rejected(self):
        self.start()
        other = RSAKey.generate_key(2048, parameters={'kid': 'google-test'})
        self.assert_result(self.callback(key=other), 'google_failed')
        self.start()
        self.fetch_token.return_value = {'id_token': 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.'}
        response = self.client.get('/api/auth/google/callback/', {'state': self.params['state'], 'code': 'code'})
        self.assert_result(response, 'google_failed')
        self.assertFalse(AuthSession.objects.exists())

    def test_key_rotation_refetches_jwks_without_accepting_untrusted_keys(self):
        self.start()
        rotated = RSAKey.generate_key(2048, parameters={'kid': 'rotated'})
        cache.set('google-oidc-jwks', {'keys': [self.key.as_dict(private=False)]})
        self.get_keys.return_value = Mock(json=lambda: {'keys': [rotated.as_dict(private=False)]})
        claims = jwt.decode(self.sign(), self.key, algorithms=['RS256']).claims
        self.fetch_token.return_value = {'id_token': jwt.encode({'alg': 'RS256', 'kid': 'rotated'}, claims, rotated)}
        result = self.client.get('/api/auth/google/callback/', {'state': self.params['state'], 'code': 'code'})
        self.assert_result(result, 'google_success')
        self.get_keys.assert_called_once_with(google.JWKS_URL, timeout=10, allow_redirects=False)

    def test_inactive_linked_user_cannot_sign_in(self):
        user = get_user_model().objects.create_user('disabled', is_active=False)
        GoogleIdentity.objects.create(user=user, subject='google-stable-subject')
        self.start()
        self.assert_result(self.callback(), 'google_failed')
        self.assertFalse(AuthSession.objects.exists())

    def test_parallel_consumption_and_duplicate_callback_parameters_are_rejected(self):
        self.start()
        google.consume_attempt(self.params['state'], self.client.cookies[google.FLOW_COOKIE].value)
        self.assert_result(self.callback(), 'google_invalid_state')
        self.start()
        result = self.client.get('/api/auth/google/callback/', {'state': [self.params['state'], self.params['state']], 'code': 'code'})
        self.assert_result(result, 'google_invalid_state')
        self.fetch_token.assert_not_called()

    def test_invalid_missing_expired_and_replayed_state_are_rejected(self):
        for kind in ['missing', 'wrong', 'missing-cookie', 'wrong-cookie', 'expired']:
            with self.subTest(kind=kind):
                self.start()
                state = self.params['state']
                if kind == 'missing': state = ''
                if kind == 'wrong': state = 'x' * 64
                if kind == 'missing-cookie': del self.client.cookies[google.FLOW_COOKIE]
                if kind == 'wrong-cookie': self.client.cookies[google.FLOW_COOKIE] = 'x' * 64
                if kind == 'expired': GoogleAuthAttempt.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
                response = self.client.get('/api/auth/google/callback/', {'state': state, 'code': 'code'})
                self.assert_result(response, 'google_invalid_state')
        self.fetch_token.assert_not_called()
        self.start()
        cookie = self.client.cookies[google.FLOW_COOKIE].value
        self.assert_result(self.callback(), 'google_success')
        self.client.cookies[google.FLOW_COOKIE] = cookie
        self.assert_result(self.callback(), 'google_invalid_state')
        self.assertEqual(self.fetch_token.call_count, 1)

    def test_denied_consent_is_single_use_and_no_provider_request(self):
        self.start()
        self.assert_result(self.callback(error='access_denied'), 'google_cancelled')
        self.fetch_token.assert_not_called()
        self.assertFalse(AuthSession.objects.exists())

    def test_expired_code_provider_failure_and_missing_code_are_safe(self):
        from authlib.oauth2.rfc6749.errors import InvalidGrantError
        for failure in [Timeout('secret'), InvalidGrantError(description='secret'), ValueError('secret')]:
            self.start()
            self.fetch_token.side_effect = failure
            self.assert_result(self.callback(), 'google_failed')
        self.fetch_token.side_effect = None
        self.start()
        response = self.client.get('/api/auth/google/callback/', {'state': self.params['state']})
        self.assert_result(response, 'google_failed')
        self.assertFalse(AuthSession.objects.exists())

    def test_matching_email_never_links_password_account(self):
        owner = get_user_model().objects.create_user('owner', email='NEW@example.com', password=self.password)
        self.start()
        self.assert_result(self.callback(), 'google_account_exists')
        self.assertEqual(get_user_model().objects.count(), 1)
        self.assertFalse(GoogleIdentity.objects.exists())
        self.assertFalse(AuthSession.objects.exists())
        self.login_password(owner)

    def test_link_requires_authentication_csrf_and_current_password(self):
        self.assertEqual(self.post('google/link', {'password': self.password}).status_code, 401)
        owner = get_user_model().objects.create_user('owner', password=self.password)
        self.login_password(owner)
        self.assertEqual(self.client.post('/api/auth/google/link/', {'password': self.password}).status_code, 403)
        for password in ['', 'wrong', None, ['bad']]:
            self.assertEqual(self.post('google/link', {'password': password}).status_code, 400)
        self.assertFalse(GoogleAuthAttempt.objects.exists())

    def test_verified_link_keeps_existing_user_workspaces_and_password(self):
        owner = get_user_model().objects.create_user('owner', email='new@example.com', password=self.password)
        project = Workspace.objects.create(owner=owner, name='Keep this')
        self.login_password(owner)
        self.start('google/link', {'password': self.password})
        self.assert_result(self.callback({'name': 'Different Google Name'}), 'google_linked')
        owner.refresh_from_db()
        self.assertEqual(owner.username, 'owner')
        self.assertEqual(GoogleIdentity.objects.get().user, owner)
        self.assertEqual(get_user_model().objects.count(), 1)
        project.refresh_from_db()
        self.assertEqual(project.owner, owner)
        self.assertTrue(owner.check_password(self.password))
        self.assertEqual(AuthSession.objects.count(), 1)

    def test_link_cannot_move_existing_google_identity(self):
        owner = get_user_model().objects.create_user('owner', password=self.password)
        other = get_user_model().objects.create_user('other')
        GoogleIdentity.objects.create(subject='google-stable-subject', user=other)
        self.login_password(owner)
        self.start('google/link', {'password': self.password})
        self.assert_result(self.callback(), 'google_link_conflict')
        self.assertEqual(GoogleIdentity.objects.get().user, other)

    def test_link_is_rechecked_after_provider_exchange(self):
        owner = get_user_model().objects.create_user('owner', password=self.password)
        self.login_password(owner)
        self.start('google/link', {'password': self.password})

        def revoke_during_exchange(*args, **kwargs):
            AuthSession.objects.filter(pk=self.attempt.link_session_id).update(revoked_at=timezone.now())
            return {'id_token': self.sign()}

        self.fetch_token.side_effect = revoke_during_exchange
        self.assert_result(self.callback(), 'google_verification_required')
        self.assertFalse(GoogleIdentity.objects.exists())

    def test_concurrent_identity_conflict_rolls_back_new_user(self):
        self.start()
        with patch('accounts.google.GoogleIdentity.objects.create', side_effect=IntegrityError):
            self.assert_result(self.callback(), 'google_link_conflict')
        self.assertFalse(get_user_model().objects.exists())
        self.assertFalse(AuthSession.objects.exists())

    def test_logout_password_change_and_browser_cookie_loss_revoke_linking(self):
        owner = get_user_model().objects.create_user('owner', password=self.password)
        for kind in ['logout', 'missing-cookie', 'password-change']:
            with self.subTest(kind=kind):
                self.login_password(owner)
                self.start('google/link', {'password': self.password})
                if kind == 'logout': self.post('logout')
                if kind == 'missing-cookie': del self.client.cookies[settings.AUTH_REFRESH_COOKIE]
                if kind == 'password-change':
                    owner.set_password('Changed-password-779!')
                    owner.save()
                response = self.callback()
                self.assertIn(parse_qs(urlsplit(response['Location']).query)['result'][0], ['google_verification_required', 'google_failed'])
                self.assertFalse(GoogleIdentity.objects.exists())

    @override_settings(GOOGLE_CLIENT_SECRET='')
    def test_missing_configuration_fails_without_network(self):
        self.assertEqual(self.post('google/start').status_code, 503)
        self.get_keys.assert_not_called()
        self.fetch_token.assert_not_called()

    @override_settings(DEBUG=False, GOOGLE_FRONTEND_ORIGIN='https://ide.example.com',
        GOOGLE_REDIRECT_URI='https://ide.example.com/api/auth/google/callback/',
        CORS_ALLOWED_ORIGINS=['https://ide.example.com'], CSRF_TRUSTED_ORIGINS=['https://ide.example.com'], AUTH_COOKIE_SECURE=True)
    def test_production_flow_uses_secure_cookie(self):
        response = self.client.post('/api/auth/google/start/', {}, format='json', HTTP_X_CSRFTOKEN=self.csrf, HTTP_ORIGIN='https://ide.example.com')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.cookies[google.FLOW_COOKIE]['secure'])

    def test_untrusted_origin_and_arbitrary_redirect_are_rejected_or_ignored(self):
        response = self.client.post('/api/auth/google/start/', {}, format='json', HTTP_X_CSRFTOKEN=self.csrf, HTTP_ORIGIN='https://evil.example')
        self.assertEqual(response.status_code, 403)
        self.start(data={'redirect_uri': 'https://evil.example', 'sub': 'fake', 'email': 'victim@example.com'})
        self.assertEqual(self.params['redirect_uri'], settings.GOOGLE_REDIRECT_URI)
        self.assert_result(self.callback(), 'google_success')
        self.assertEqual(get_user_model().objects.get().email, 'new@example.com')
