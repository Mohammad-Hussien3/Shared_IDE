from rest_framework.generics import (
    ListCreateAPIView,
    RetrieveAPIView,
    RetrieveUpdateDestroyAPIView,
)
from django.shortcuts import get_object_or_404

from .models import Workspace, Folder, File
from .serializers import (
    WorkspaceTreeSerializer,
    FolderSerializer,
    FileSerializer,
)


class WorkspaceListCreateAPIView(ListCreateAPIView):
    queryset = Workspace.objects.all()
    serializer_class = WorkspaceTreeSerializer


class WorkspaceDetailAPIView(RetrieveAPIView):
    queryset = Workspace.objects.all()
    serializer_class = WorkspaceTreeSerializer


class WorkspaceScopedMixin:
    def get_workspace(self):
        return get_object_or_404(Workspace, pk=self.kwargs["workspace_id"])

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["workspace"] = self.get_workspace()
        return context


class FolderListCreateAPIView(WorkspaceScopedMixin, ListCreateAPIView):
    serializer_class = FolderSerializer

    def get_queryset(self):
        return Folder.objects.filter(workspace=self.get_workspace())

    def perform_create(self, serializer):
        serializer.save(workspace=self.get_workspace())


class FolderDetailAPIView(WorkspaceScopedMixin, RetrieveUpdateDestroyAPIView):
    serializer_class = FolderSerializer

    def get_queryset(self):
        return Folder.objects.filter(workspace=self.get_workspace())


class FileListCreateAPIView(WorkspaceScopedMixin, ListCreateAPIView):
    serializer_class = FileSerializer

    def get_queryset(self):
        return File.objects.filter(workspace=self.get_workspace())

    def perform_create(self, serializer):
        serializer.save(workspace=self.get_workspace())


class FileDetailAPIView(WorkspaceScopedMixin, RetrieveUpdateDestroyAPIView):
    serializer_class = FileSerializer

    def get_queryset(self):
        return File.objects.filter(workspace=self.get_workspace())
