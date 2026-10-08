from rest_framework.generics import (
    ListCreateAPIView,
    RetrieveAPIView,
)

from .models import Workspace
from .serializers import WorkspaceTreeSerializer


class WorkspaceListCreateAPIView(ListCreateAPIView):
    queryset = Workspace.objects.all()
    serializer_class = WorkspaceTreeSerializer


class WorkspaceDetailAPIView(RetrieveAPIView):
    queryset = Workspace.objects.all()
    serializer_class = WorkspaceTreeSerializer