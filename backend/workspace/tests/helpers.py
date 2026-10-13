from django.urls import reverse
from django.contrib.auth import get_user_model
from workspace.models import Workspace


class ResourceAPIMixin:
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='owner')
        self.client.force_authenticate(self.user)
        self.workspace = Workspace.objects.create(name="Test workspace", owner=self.user)
        self.other_workspace = Workspace.objects.create(name="Other workspace", owner=self.user)


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

