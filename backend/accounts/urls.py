from django.urls import path
from .views import CSRFView, RegisterView, LoginView, LogoutView, RefreshView, MeView, VerifyEmailView, ResendVerificationView
from .google_views import GoogleStartView, GoogleLinkView, GoogleCallbackView
from .account_views import AccountVerificationView, UsernameView, PasswordView
from .password_reset_views import PasswordResetRequestView, PasswordResetConfirmView

urlpatterns = [
    path('password-reset/', PasswordResetRequestView.as_view(), name='auth-password-reset'),
    path('password-reset/confirm/', PasswordResetConfirmView.as_view(), name='auth-password-reset-confirm'),
    path('account/verification/', AccountVerificationView.as_view(), name='auth-account-verification'),
    path('account/username/', UsernameView.as_view(), name='auth-account-username'),
    path('account/password/', PasswordView.as_view(), name='auth-account-password'),
    path('google/start/', GoogleStartView.as_view(), name='auth-google-start'),
    path('google/link/', GoogleLinkView.as_view(), name='auth-google-link'),
    path('google/callback/', GoogleCallbackView.as_view(), name='auth-google-callback'),
    path('csrf/', CSRFView.as_view(), name='auth-csrf'),
    path('register/', RegisterView.as_view(), name='auth-register'),
    path('verify-email/', VerifyEmailView.as_view(), name='auth-verify-email'),
    path('resend-verification/', ResendVerificationView.as_view(), name='auth-resend-verification'),
    path('login/', LoginView.as_view(), name='auth-login'),
    path('refresh/', RefreshView.as_view(), name='auth-refresh'),
    path('logout/', LogoutView.as_view(), name='auth-logout'),
    path('me/', MeView.as_view(), name='auth-me'),
]
