from django.db import transaction
from rest_framework.generics import (
    ListCreateAPIView,
    RetrieveUpdateDestroyAPIView,
)
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.shortcuts import get_object_or_404

from .models import Workspace, Folder, File
from .serializers import (
    WorkspaceTreeSerializer,
    FolderSerializer,
    FileSerializer,
    RunFileRequestSerializer,
)
from .execution import SUPPORTED_RUNNERS, detect_language
from .runner import RunnerUnavailable, run_program


class WorkspaceListCreateAPIView(ListCreateAPIView):
    serializer_class = WorkspaceTreeSerializer

    def get_queryset(self):
        return Workspace.objects.filter(owner=self.request.user).order_by('-created_at')

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class WorkspaceDetailAPIView(RetrieveUpdateDestroyAPIView):
    serializer_class = WorkspaceTreeSerializer

    def get_queryset(self):
        return Workspace.objects.filter(owner=self.request.user)


class WorkspaceScopedMixin:
    def get_workspace(self):
        return get_object_or_404(Workspace, pk=self.kwargs["workspace_id"], owner=self.request.user)

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

    @transaction.atomic
    def update(self, request, *args, **kwargs):
        instance = get_object_or_404(self.get_queryset().select_for_update(), pk=kwargs['pk'])
        if hasattr(instance, 'document') and 'content' in request.data and request.data['content'] != instance.content:
            return Response({'code': 'collaboration_required'}, status=409)
        # super obtains the same locked file. Sharing activation/writes/revocation
        # cannot race a legacy save while this transaction owns the row lock.
        return super().update(request, *args, **kwargs)


    def get_queryset(self):
        return File.objects.filter(workspace=self.get_workspace())


class FileRunAPIView(WorkspaceScopedMixin, APIView):
    def post(self, request, workspace_id, pk):
        file = get_object_or_404(
            File,
            workspace=self.get_workspace(),
            pk=pk,
        )
        serializer = RunFileRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        language, detection_error = detect_language(
            file.name,
            serializer.validated_data["content"],
        )
        if detection_error:
            return Response(
                {"detail": detection_error},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if language not in SUPPORTED_RUNNERS:
            return Response(
                {
                    "detail": (
                        f"Detected {language}, but execution is currently supported "
                        "only for Python (.py), C (.c), and C++ (.cpp)."
                    ),
                    "language": language,
                },
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        try:
            result = run_program(language, serializer.validated_data["content"])
        except RunnerUnavailable as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response({"language": language, **result})
