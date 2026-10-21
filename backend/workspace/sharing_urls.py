from django.urls import path
from .sharing_views import (
    CollaboratorView, FileSharingView, InvitationListView, InvitationRespondView,
    SharedFileListView, SharedFileView, UserSearchView,
)

urlpatterns = [
    path('users/', UserSearchView.as_view()),
    path('invitations/', InvitationListView.as_view()),
    path('invitations/<uuid:invitation_id>/', InvitationRespondView.as_view()),
    path('files/', SharedFileListView.as_view()),
    path('files/<uuid:file_id>/', SharedFileView.as_view()),
    path('files/<uuid:file_id>/manage/', FileSharingView.as_view()),
    path('files/<uuid:file_id>/members/<int:user_id>/', CollaboratorView.as_view()),
]
