from django.urls import reverse
from rest_framework.test import APITestCase

from .models import File, Folder, Workspace


class WorkspaceResourceAPITests(APITestCase):
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

    def test_folder_crud_and_nested_parent(self):
        response = self.client.post(self.folder_list_url(), {"name": "src"}, format="json")
        self.assertEqual(response.status_code, 201)
        parent_id = response.data["id"]
        parent = Folder.objects.get(pk=parent_id)
        self.assertEqual(parent.workspace, self.workspace)

        response = self.client.post(
            self.folder_list_url(),
            {"name": "components", "parent": parent_id},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        child_id = response.data["id"]
        self.assertEqual(Folder.objects.get(pk=child_id).parent, parent)

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
        self.assertEqual(self.client.get(self.folder_list_url()).data.__len__(), 2)
        self.assertEqual(self.client.delete(detail_url).status_code, 204)

    def test_file_crud_and_folder_assignment(self):
        folder = Folder.objects.create(workspace=self.workspace, name="src")
        response = self.client.post(
            self.file_list_url(),
            {"name": "main", "language": "python", "content": "print('hi')", "folder": str(folder.id)},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        file_id = response.data["id"]
        saved_file = File.objects.get(pk=file_id)
        self.assertEqual(saved_file.workspace, self.workspace)
        self.assertEqual(saved_file.folder, folder)

        detail_url = reverse(
            "workspace-file-detail",
            kwargs={"workspace_id": self.workspace.id, "pk": file_id},
        )
        self.assertEqual(self.client.get(detail_url).data["content"], "print('hi')")
        update_response = self.client.patch(
            detail_url,
            {"name": "renamed_main", "content": "print('updated')"},
            format="json",
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.data["name"], "renamed_main")
        self.assertEqual(update_response.data["content"], "print('updated')")
        self.assertEqual(self.client.get(self.file_list_url()).data.__len__(), 1)
        self.assertEqual(self.client.delete(detail_url).status_code, 204)
        self.assertFalse(File.objects.filter(pk=file_id).exists())

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

    def test_recursive_tree_supports_root_and_deep_resources(self):
        root_folder_response = self.client.post(
            self.folder_list_url(), {"name": "root"}, format="json"
        )
        self.assertEqual(root_folder_response.status_code, 201)
        root_folder_id = root_folder_response.data["id"]

        nested_folder_response = self.client.post(
            self.folder_list_url(),
            {"name": "nested", "parent": root_folder_id},
            format="json",
        )
        self.assertEqual(nested_folder_response.status_code, 201)
        nested_folder_id = nested_folder_response.data["id"]

        deep_folder_response = self.client.post(
            self.folder_list_url(),
            {"name": "deep", "parent": nested_folder_id},
            format="json",
        )
        self.assertEqual(deep_folder_response.status_code, 201)
        deep_folder_id = deep_folder_response.data["id"]

        root_file_response = self.client.post(
            self.file_list_url(),
            {"name": "README", "content": "root file"},
            format="json",
        )
        self.assertEqual(root_file_response.status_code, 201)

        folder_file_response = self.client.post(
            self.file_list_url(),
            {"name": "nested_file", "folder": root_folder_id},
            format="json",
        )
        self.assertEqual(folder_file_response.status_code, 201)

        deep_file_response = self.client.post(
            self.file_list_url(),
            {"name": "deep_file", "folder": deep_folder_id},
            format="json",
        )
        self.assertEqual(deep_file_response.status_code, 201)

        response = self.client.get(
            reverse("workspace-detail", kwargs={"pk": self.workspace.id})
        )
        self.assertEqual(response.status_code, 200)
        tree = response.data["children"]
        self.assertTrue(any(item.get("name") == "README" for item in tree))
        root_folder = next(item for item in tree if item.get("id") == root_folder_id)
        nested_folder = next(
            item for item in root_folder["children"] if item.get("id") == nested_folder_id
        )
        deep_folder = next(
            item for item in nested_folder["children"] if item.get("id") == deep_folder_id
        )
        self.assertTrue(
            any(item.get("name") == "nested_file" for item in root_folder["children"])
        )
        self.assertTrue(
            any(item.get("name") == "deep_file" for item in deep_folder["children"])
        )
