from django.urls import reverse
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from workspace.models import File, Folder, Workspace
from .helpers import ResourceAPIMixin

class ResourceAPITests(ResourceAPIMixin, APITestCase):
    def test_recursive_tree_supports_root_and_deep_resources(self):
        root = self.client.post(self.folder_list_url(), {"name": "root"}, format="json")
        self.assertEqual(root.status_code, 201)
        nested = self.client.post(
            self.folder_list_url(),
            {"name": "nested", "parent": root.data["id"]},
            format="json",
        )
        self.assertEqual(nested.status_code, 201)
        deep = self.client.post(
            self.folder_list_url(),
            {"name": "deep", "parent": nested.data["id"]},
            format="json",
        )
        self.assertEqual(deep.status_code, 201)
        self.assertEqual(
            self.client.post(self.file_list_url(), {"name": "README"}, format="json").status_code,
            201,
        )
        self.assertEqual(
            self.client.post(
                self.file_list_url(), {"name": "nested_file", "folder": root.data["id"]}, format="json"
            ).status_code,
            201,
        )
        self.assertEqual(
            self.client.post(
                self.file_list_url(), {"name": "deep_file", "folder": deep.data["id"]}, format="json"
            ).status_code,
            201,
        )

        response = self.client.get(
            reverse("workspace-detail", kwargs={"pk": self.workspace.id})
        )
        tree = response.data["children"]
        self.assertTrue(any(item.get("name") == "README" for item in tree))
        root_node = next(item for item in tree if item.get("id") == root.data["id"])
        nested_node = next(item for item in root_node["children"] if item.get("id") == nested.data["id"])
        deep_node = next(item for item in nested_node["children"] if item.get("id") == deep.data["id"])
        self.assertTrue(any(item.get("name") == "nested_file" for item in root_node["children"]))
        self.assertTrue(any(item.get("name") == "deep_file" for item in deep_node["children"]))



class WorkspaceAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='owner')
        self.client.force_authenticate(self.user)

    def test_create_list_and_retrieve_workspace(self):
        url = reverse('workspace-list-create')
        response = self.client.post(url, {'name': 'project'}, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['children'], [])
        detail = reverse('workspace-detail', kwargs={'pk': response.data['id']})
        self.assertEqual(detail, f"/api/workspaces/{response.data['id']}/")
        self.assertEqual(self.client.get(detail).data, response.data)
        self.assertEqual(self.client.get(url).data, [response.data])

    def test_default_name_and_invalid_names(self):
        url = reverse('workspace-list-create')
        self.assertEqual(self.client.post(url, {}, format='json').data['name'], 'Untitled Workspace')
        for name in ['', '  ', 'x' * 101]:
            self.assertEqual(self.client.post(url, {'name': name}, format='json').status_code, 400)

    def test_unknown_workspace_and_detail_operations(self):
        import uuid
        missing = reverse('workspace-detail', kwargs={'pk': uuid.uuid4()})
        self.assertEqual(self.client.get(missing).status_code, 404)
        workspace = Workspace.objects.create(owner=self.user)
        url = reverse('workspace-detail', kwargs={'pk': workspace.pk})
        self.assertEqual(self.client.patch(url, {'name': 'renamed'}, format='json').status_code, 200)
        self.assertEqual(self.client.put(url, {'name': 'replaced'}, format='json').status_code, 200)
        self.assertEqual(self.client.delete(url).status_code, 204)
