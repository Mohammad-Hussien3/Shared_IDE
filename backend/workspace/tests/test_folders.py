from django.urls import reverse
from rest_framework.test import APITestCase
from workspace.models import File, Folder, Workspace
from .helpers import ResourceAPIMixin

class ResourceAPITests(ResourceAPIMixin, APITestCase):
    def test_folder_crud_and_nested_parent(self):
        response = self.client.post(
            self.folder_list_url(), {"name": "src"}, format="json"
        )
        self.assertEqual(response.status_code, 201)
        parent = Folder.objects.get(pk=response.data["id"])
        self.assertEqual(parent.workspace, self.workspace)

        response = self.client.post(
            self.folder_list_url(),
            {"name": "components", "parent": str(parent.id)},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        child_id = response.data["id"]
        detail_url = reverse(
            "workspace-folder-detail",
            kwargs={"workspace_id": self.workspace.id, "pk": child_id},
        )
        self.assertEqual(self.client.get(detail_url).status_code, 200)
        self.assertEqual(
            self.client.patch(detail_url, {"name": "widgets"}, format="json").status_code,
            200,
        )
        self.assertEqual(self.client.get(detail_url).data["name"], "widgets")
        self.assertEqual(self.client.delete(detail_url).status_code, 204)


    def test_cannot_assign_resources_from_another_workspace(self):
        other_folder = Folder.objects.create(
            workspace=self.other_workspace,
            name="private",
        )
        response = self.client.post(
            self.folder_list_url(),
            {"name": "invalid child", "parent": str(other_folder.id)},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        response = self.client.post(
            self.file_list_url(),
            {"name": "invalid.py", "folder": str(other_folder.id)},
            format="json",
        )
        self.assertEqual(response.status_code, 400)



class FolderEdgeTests(ResourceAPIMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.folder = Folder.objects.create(workspace=self.workspace, name='root')
        self.foreign = Folder.objects.create(workspace=self.other_workspace, name='foreign')
        self.url = reverse('workspace-folder-detail', kwargs={'workspace_id': self.workspace.pk, 'pk': self.folder.pk})

    def test_lists_only_workspace_folders(self):
        response = self.client.get(self.folder_list_url())
        self.assertEqual([item['id'] for item in response.data], [str(self.folder.pk)])

    def test_create_uses_url_workspace_and_invalid_uuid_returns_400(self):
        response = self.client.post(self.folder_list_url(), {'name': 'new', 'workspace': str(self.other_workspace.pk)}, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Folder.objects.get(pk=response.data['id']).workspace_id, self.workspace.pk)
        self.assertEqual(self.client.post(self.folder_list_url(), {'name': 'bad', 'parent': 'invalid'}, format='json').status_code, 400)

    def test_put_rename_and_patch_move_to_root(self):
        child = Folder.objects.create(workspace=self.workspace, parent=self.folder, name='child')
        url = reverse('workspace-folder-detail', kwargs={'workspace_id': self.workspace.pk, 'pk': child.pk})
        self.assertEqual(self.client.put(url, {'name': 'renamed', 'parent': str(self.folder.pk)}, format='json').status_code, 200)
        self.assertEqual(self.client.patch(url, {'parent': None}, format='json').status_code, 200)
        child.refresh_from_db()
        self.assertEqual(child.name, 'renamed')
        self.assertIsNone(child.parent)

    def test_cross_workspace_reads_writes_and_moves_rejected(self):
        foreign_url = reverse('workspace-folder-detail', kwargs={'workspace_id': self.workspace.pk, 'pk': self.foreign.pk})
        for method in [self.client.get, self.client.patch, self.client.delete]:
            self.assertEqual(method(foreign_url).status_code, 404)
        self.assertEqual(self.client.patch(self.url, {'parent': str(self.foreign.pk)}, format='json').status_code, 400)
        self.folder.refresh_from_db()
        self.assertIsNone(self.folder.parent)

    def test_invalid_cycle_update_leaves_tree_usable(self):
        child = Folder.objects.create(workspace=self.workspace, parent=self.folder, name='child')
        response = self.client.patch(self.url, {'parent': str(child.pk)}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get(reverse('workspace-detail', kwargs={'pk': self.workspace.pk})).status_code, 200)

    def test_unknown_workspace_or_folder_returns_404(self):
        import uuid
        self.assertEqual(self.client.get(reverse('workspace-folder-list-create', kwargs={'workspace_id': uuid.uuid4()})).status_code, 404)
        self.assertEqual(self.client.delete(reverse('workspace-folder-detail', kwargs={'workspace_id': self.workspace.pk, 'pk': uuid.uuid4()})).status_code, 404)
