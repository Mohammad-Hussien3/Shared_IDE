from django.urls import reverse
from workspace.models import Workspace


class ResourceAPIMixin:
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Test workspace")
        self.other_workspace = Workspace.objects.create(name="Other workspace")


    def folder_list_url(self):
        return reverse(
            "workspace-folder-list-create",
            kwargs={"workspace_id": self.workspace.id},
        )


    def file_list_url(self):
        return reverse(
            "workspace-file-list-create",
            kwargs={"workspace_id": self.workspace.id},
        )


