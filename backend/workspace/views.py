from rest_framework.generics import (
    ListCreateAPIView,
    RetrieveAPIView,
)

from .models import Workspace
from .serializers import WorkspaceSerializer


class WorkspaceListCreateAPIView(ListCreateAPIView):
    queryset = Workspace.objects.all()
    serializer_class = WorkspaceSerializer


class WorkspaceDetailAPIView(RetrieveAPIView):
    queryset = Workspace.objects.all()
    serializer_class = WorkspaceSerializer