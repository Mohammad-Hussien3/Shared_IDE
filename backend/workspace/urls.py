from django.urls import path

from .views import (
    WorkspaceListCreateAPIView,
    WorkspaceDetailAPIView,
)


urlpatterns = [
    path(
        "",
        WorkspaceListCreateAPIView.as_view(),
        name="workspace-list-create"
    ),

    path(
        "<uuid:pk>/",
        WorkspaceDetailAPIView.as_view(),
        name="workspace-detail"
    ),
]