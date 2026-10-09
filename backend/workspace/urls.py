from django.urls import path

from .views import (
    WorkspaceListCreateAPIView,
    WorkspaceDetailAPIView,
    FolderListCreateAPIView,
    FolderDetailAPIView,
    FileListCreateAPIView,
    FileDetailAPIView,
    FileRunAPIView,
)


urlpatterns = [
    path(
        "",
        WorkspaceListCreateAPIView.as_view(),
        name="workspace-list-create"
    ),

    path(
        "<uuid:workspace_id>/folders/",
        FolderListCreateAPIView.as_view(),
        name="workspace-folder-list-create",
    ),
    path(
        "<uuid:workspace_id>/folders/<uuid:pk>/",
        FolderDetailAPIView.as_view(),
        name="workspace-folder-detail",
    ),
    path(
        "<uuid:workspace_id>/files/",
        FileListCreateAPIView.as_view(),
        name="workspace-file-list-create",
    ),
    path(
        "<uuid:workspace_id>/files/<uuid:pk>/run/",
        FileRunAPIView.as_view(),
        name="workspace-file-run",
    ),
    path(
        "<uuid:workspace_id>/files/<uuid:pk>/",
        FileDetailAPIView.as_view(),
        name="workspace-file-detail",
    ),
    path(
        "<uuid:pk>/",
        WorkspaceDetailAPIView.as_view(),
        name="workspace-detail"
    ),
]
