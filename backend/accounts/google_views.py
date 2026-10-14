from urllib.parse import urlencode

from authlib.common.errors import AuthlibBaseError
from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.http import HttpResponseRedirect
from joserfc.errors import JoseError
from requests.exceptions import RequestException
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework_simplejwt.exceptions import TokenError

from . import google
from .authentication import SessionJWTAuthentication
from .models import AuthSession
from .views import CookieAuthView, begin_session


class GoogleStartView(CookieAuthView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'auth'

    def post(self, request):
        if not google.configured():
            return Response({'code': 'google_unavailable'}, status=503)
        if request.headers.get('Origin', settings.GOOGLE_FRONTEND_ORIGIN) != settings.GOOGLE_FRONTEND_ORIGIN:
            return Response({'code': 'google_origin'}, status=400)
        session, proof = None, ''
        if isinstance(self, GoogleLinkView):
            password = request.data.get('password')
            if not isinstance(password, str) or len(password) > 128 or not request.user.check_password(password):
                return Response({'code': 'google_verification_required'}, status=400)
            session = AuthSession.objects.get(pk=request.auth['sid'], user=request.user)
            proof = request.user.get_session_auth_hash()
        url, browser = google.start_attempt(session, proof)
        response = Response({'authorization_url': url})
        response.set_cookie(
            google.FLOW_COOKIE, browser, max_age=google.FLOW_SECONDS,
            httponly=True, secure=settings.AUTH_COOKIE_SECURE,
            samesite='Lax', path=google.FLOW_COOKIE_PATH,
        )
        return response


class GoogleLinkView(GoogleStartView):
    authentication_classes = [SessionJWTAuthentication]
    permission_classes = [IsAuthenticated]


class GoogleCallbackView(CookieAuthView):
    def get(self, request):
        if not google.configured():
            return Response({'code': 'google_unavailable'}, status=503)
        attempt = None
        user = None
        result = 'google_failed'
        try:
            if any(len(request.query_params.getlist(key)) > 1 for key in ('state', 'code', 'error')):
                raise google.GoogleAuthError('google_invalid_state')
            attempt = google.consume_attempt(request.query_params.get('state'), request.COOKIES.get(google.FLOW_COOKIE))
            if request.query_params.get('error'):
                raise google.GoogleAuthError('google_cancelled' if request.query_params['error'] == 'access_denied' else 'google_failed')
            code = request.query_params.get('code')
            if not code or len(code) > 4096:
                raise google.GoogleAuthError('google_failed')
            linking_user = google.link_user(request, attempt) if attempt.link_session_id else None
            subject, email = google.exchange_identity(code, attempt)
            # Recheck after the network exchange: logout/password changes revoke linking.
            if linking_user:
                attempt.refresh_from_db()
                linking_user = google.link_user(request, attempt)
            user = google.resolve_user(subject, email, linking_user)
            result = 'google_linked' if linking_user else 'google_success'
        except google.GoogleAuthError as exc:
            result = exc.code
        except (AuthlibBaseError, JoseError, RequestException, TokenError, ObjectDoesNotExist, ValueError, TypeError, KeyError):
            # Provider responses can include credentials, tokens and internal URLs.
            # Never echo or log their raw exception strings.
            result = 'google_failed'
        finally:
            if attempt:
                attempt.delete()
        response = HttpResponseRedirect(
            settings.GOOGLE_FRONTEND_ORIGIN + '/auth/google/callback?' + urlencode({'result': result})
        )
        response['Referrer-Policy'] = 'no-referrer'
        if result == 'google_success':
            response = begin_session(request, user, response=response)
        response.delete_cookie(google.FLOW_COOKIE, path=google.FLOW_COOKIE_PATH, samesite='Lax')
        return response
