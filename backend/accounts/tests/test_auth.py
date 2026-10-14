import re
from django.core import mail
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import AuthSession


@override_settings(AUTH_COOKIE_SECURE=False, FRONTEND_URL='https://localhost:5173',
    CORS_ALLOWED_ORIGINS=['https://localhost:5173', 'http://localhost:5173', 'http://127.0.0.1:5173'])
class AuthenticationTests(APITestCase):
    password = 'Safer-code!7249'

    def setUp(self):
        cache.clear()
        self.client = APIClient(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']

    def post(self, endpoint, data=None, **extra):
        result = self.client.post(f'/api/auth/{endpoint}/', data or {}, format='json', HTTP_X_CSRFTOKEN=self.csrf, **extra)
        if isinstance(result.data, dict) and 'csrf' in result.data:
            self.csrf = result.data['csrf']
        return result

    def register_and_login(self, username='alice'):
        result = self.post('register', {'username': username, 'email': f'{username}@example.com', 'password': self.password, 'confirm_password': self.password})
        if result.status_code != 201:
            return result
        token = re.search(r'#token=([A-Za-z0-9_-]+)', mail.outbox[-1].body)[1]
        self.assertEqual(self.post('verify-email', {'token': token}).status_code, 200)
        return self.post('login', {'username': username, 'password': self.password})

    def test_registration_hashing_cookie_and_profile(self):
        result = self.register_and_login()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(set(result.data), {'access', 'user', 'csrf'})
        user = get_user_model().objects.get(username='alice')
        self.assertTrue(user.check_password(self.password))
        self.assertNotEqual(user.password, self.password)
        self.assertEqual(result.data['user'], {'id': user.id, 'username': 'alice', 'google_connected': False, 'has_password': True})
        cookie = result.cookies[settings.AUTH_REFRESH_COOKIE]
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Lax')
        self.assertEqual(cookie['path'], '/api/auth/')
        self.assertEqual(result['Cache-Control'], 'no-store')
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {result.data['access']}")
        self.assertEqual(self.client.get('/api/auth/me/').data['username'], 'alice')

    def test_password_validation_and_duplicate_registration(self):
        for payload in [
            {'username': 'alice', 'password': 'password', 'confirm_password': 'password'},
            {'username': 'alice', 'password': self.password, 'confirm_password': 'different'},
            {'username': 'alice', 'password': '12345678', 'confirm_password': '12345678'},
            {'username': '', 'password': self.password, 'confirm_password': self.password},
        ]:
            self.assertEqual(self.post('register', {**payload, 'email': 'alice@example.com'}).status_code, 400)
        self.assertEqual(get_user_model().objects.count(), 0)
        self.register_and_login()
        self.assertEqual(self.register_and_login().status_code, 400)
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_login_invalid_credentials_and_inactive_user(self):
        user = get_user_model().objects.create_user(username='alice', password=self.password)
        for username, password in [('alice', 'wrong'), ('unknown', self.password)]:
            result = self.post('login', {'username': username, 'password': password})
            self.assertEqual(result.status_code, 401)
            self.assertEqual(result.data, {'detail': 'Invalid username or password.'})
        self.assertEqual(self.post('login', {'username': 'alice', 'password': self.password}).status_code, 200)
        user.is_active = False
        user.save()
        self.assertEqual(self.post('login', {'username': 'alice', 'password': self.password}).status_code, 401)

    def test_rotation_replay_logout_and_access_revocation(self):
        login = self.register_and_login()
        original = self.client.cookies[settings.AUTH_REFRESH_COOKIE].value
        refreshed = self.post('refresh')
        self.assertEqual(refreshed.status_code, 200)
        rotated = self.client.cookies[settings.AUTH_REFRESH_COOKIE].value
        self.assertNotEqual(rotated, original)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = original
        self.assertEqual(self.post('refresh').status_code, 401)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = rotated
        self.assertEqual(self.post('logout').status_code, 204)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = rotated
        self.assertEqual(self.post('refresh').status_code, 401)
        for access in [login.data['access'], refreshed.data['access']]:
            self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
            self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
        self.assertIsNotNone(AuthSession.objects.get().revoked_at)

    def test_password_change_revokes_access_and_refresh(self):
        login = self.register_and_login()
        user = get_user_model().objects.get()
        user.set_password('Replacement-password-87!')
        user.save()
        self.assertEqual(self.post('refresh').status_code, 401)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)

    def test_csrf_enforced_for_all_cookie_mutations_and_foreign_origin(self):
        self.register_and_login()
        for action in ['register', 'login', 'refresh', 'logout', 'verify-email', 'resend-verification']:
            with self.subTest(action=action):
                self.assertEqual(self.client.post(f'/api/auth/{action}/', {}, format='json').status_code, 403)
                self.assertEqual(self.post(action, HTTP_ORIGIN='https://untrusted.example').status_code, 403)
        self.assertEqual(self.post('refresh', HTTP_ORIGIN='http://localhost:5173').status_code, 200)

    def test_refresh_missing_invalid_and_expired_and_anonymous_me(self):
        self.assertEqual(self.post('refresh').status_code, 401)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = 'not-a-token'
        self.assertEqual(self.post('refresh').status_code, 401)
        result = self.register_and_login()
        refresh = RefreshToken(self.client.cookies[settings.AUTH_REFRESH_COOKIE].value)
        refresh['exp'] = 1
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = str(refresh)
        self.assertEqual(self.post('refresh').status_code, 401)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
        self.assertEqual(result.status_code, 200)

    @override_settings(AUTH_COOKIE_SECURE=True)
    def test_production_cookie_is_secure(self):
        self.assertTrue(self.register_and_login().cookies[settings.AUTH_REFRESH_COOKIE]['secure'])

    def test_bearer_requests_do_not_require_csrf_or_accept_cookie_alone(self):
        result = self.register_and_login()
        self.assertEqual(self.client.get('/api/workspaces/').status_code, 401)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {result.data['access']}")
        response = self.client.post('/api/workspaces/', {'name': 'private'}, format='json')
        self.assertEqual(response.status_code, 201)

    def test_logout_only_revokes_its_session(self):
        first = self.register_and_login()
        second = self.post('login', {'username': 'alice', 'password': self.password})
        self.post('logout')
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {first.data['access']}")
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {second.data['access']}")
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)

    def test_logout_with_rotated_cookie_still_revokes_the_session(self):
        self.register_and_login()
        original = self.client.cookies[settings.AUTH_REFRESH_COOKIE].value
        self.assertEqual(self.post('refresh').status_code, 200)
        rotated = self.client.cookies[settings.AUTH_REFRESH_COOKIE].value
        # Simulate logout arriving with the old cookie while another tab refreshes.
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = original
        self.assertEqual(self.post('logout').status_code, 204)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE] = rotated
        self.assertEqual(self.post('refresh').status_code, 401)

    @override_settings(CSRF_COOKIE_SECURE=False)
    def test_development_origins_support_the_complete_cookie_auth_flow(self):
        for hostname in ['localhost', '127.0.0.1']:
            with self.subTest(hostname=hostname):
                self.client = APIClient(enforce_csrf_checks=True)
                headers = {
                    'HTTP_HOST': f'{hostname}:8000',
                    'HTTP_ORIGIN': f'http://{hostname}:5173',
                }
                bootstrap = self.client.get('/api/auth/csrf/', **headers)
                self.assertEqual(bootstrap.status_code, 200)
                self.assertEqual(bootstrap['Cache-Control'], 'no-store')
                self.assertEqual(bootstrap['Access-Control-Allow-Origin'], headers['HTTP_ORIGIN'])
                self.assertEqual(bootstrap['Access-Control-Allow-Credentials'], 'true')
                cookie = bootstrap.cookies[settings.CSRF_COOKIE_NAME]
                self.assertTrue(cookie['httponly'])
                self.assertFalse(cookie['secure'])
                self.assertEqual(cookie['samesite'], 'Lax')
                self.assertEqual(cookie['domain'], '')
                self.csrf = bootstrap.data['csrf']
                credentials = {'username': f'user_{hostname.replace(".", "_")}', 'password': self.password}
                for action, payload, status in [
                    ('register', {**credentials, 'email': f'{credentials["username"]}@example.com', 'confirm_password': self.password}, 201),
                    ('verify-email', {}, 200),
                    ('login', credentials, 200),
                    ('refresh', {}, 200),
                    ('logout', {}, 204),
                    ('login', credentials, 200),
                    ('refresh', {}, 200),
                    ('logout', {}, 204),
                ]:
                    with self.subTest(action=action):
                        if action == 'verify-email':
                            payload = {'token': re.search(r'#token=([A-Za-z0-9_-]+)', mail.outbox[-1].body)[1]}
                        result = self.post(action, payload, **headers)
                        self.assertEqual(result.status_code, status, result.data)
                        self.assertEqual(result['Access-Control-Allow-Origin'], headers['HTTP_ORIGIN'])
                        self.assertEqual(result['Access-Control-Allow-Credentials'], 'true')
                        if action in ['login', 'refresh']:
                            self.assertTrue(result.cookies[settings.AUTH_REFRESH_COOKIE]['httponly'])

    @override_settings(DEBUG=True)
    def test_registration_header_without_cookie_is_rejected_then_bootstrap_recovers(self):
        # Reproduce a browser withholding a SameSite cookie across loopback hosts.
        del self.client.cookies[settings.CSRF_COOKIE_NAME]
        result = self.register_and_login()
        self.assertEqual(result.status_code, 403)
        self.assertEqual(result.data['code'], 'csrf_failed')
        self.assertIn('CSRF cookie not set', result.data['detail'])
        self.assertFalse(get_user_model().objects.exists())
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']
        self.assertEqual(self.register_and_login().status_code, 200)

    @override_settings(DEBUG=False)
    def test_missing_cookie_and_incorrect_tokens_reject_every_cookie_mutation(self):
        self.register_and_login()
        cookie = self.client.cookies[settings.CSRF_COOKIE_NAME].value
        for action in ['register', 'login', 'refresh', 'logout', 'verify-email', 'resend-verification']:
            for invalid in ['missing-cookie', 'malformed-header', 'wrong-token']:
                with self.subTest(action=action, invalid=invalid):
                    self.client.cookies[settings.CSRF_COOKIE_NAME] = cookie
                    header = self.csrf
                    if invalid == 'missing-cookie':
                        del self.client.cookies[settings.CSRF_COOKIE_NAME]
                    else:
                        header = 'malformed' if invalid == 'malformed-header' else 'a' * 64
                    result = self.client.post(
                        f'/api/auth/{action}/', {}, format='json',
                        HTTP_X_CSRFTOKEN=header, HTTP_ORIGIN='http://localhost:5173',
                    )
                    self.assertEqual(result.status_code, 403)
                    self.assertEqual(result.data, {
                        'detail': 'CSRF verification failed. Reload and try again.',
                        'code': 'csrf_failed',
                    })
        self.assertEqual(get_user_model().objects.count(), 1)
        self.assertEqual(AuthSession.objects.count(), 1)
        self.assertIsNone(AuthSession.objects.get().revoked_at)

    def test_rotated_cookie_rejects_stale_header_until_csrf_is_refetched(self):
        old_csrf = self.csrf
        self.register_and_login()
        jti = AuthSession.objects.get().refresh_jti
        result = self.client.post('/api/auth/refresh/', {}, format='json', HTTP_X_CSRFTOKEN=old_csrf)
        self.assertEqual(result.status_code, 403)
        self.assertEqual(result.data['code'], 'csrf_failed')
        self.assertEqual(AuthSession.objects.get().refresh_jti, jti)
        self.csrf = self.client.get('/api/auth/csrf/').data['csrf']
        self.assertEqual(self.post('refresh').status_code, 200)
        self.assertNotEqual(AuthSession.objects.get().refresh_jti, jti)

    def test_cors_preflight_allows_csrf_header_only_for_trusted_origins(self):
        for origin, allowed in [('http://localhost:5173', True), ('https://untrusted.example', False)]:
            with self.subTest(origin=origin):
                result = self.client.options(
                    '/api/auth/register/', HTTP_ORIGIN=origin,
                    HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST',
                    HTTP_ACCESS_CONTROL_REQUEST_HEADERS='content-type,x-csrftoken',
                )
                self.assertEqual(result.status_code, 200)
                if allowed:
                    self.assertEqual(result['Access-Control-Allow-Origin'], origin)
                    self.assertIn('x-csrftoken', result['Access-Control-Allow-Headers'])
                    self.assertEqual(result['Access-Control-Allow-Credentials'], 'true')
                else:
                    self.assertNotIn('Access-Control-Allow-Origin', result)
