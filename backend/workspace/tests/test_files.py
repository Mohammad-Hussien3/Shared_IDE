from django.urls import reverse
from rest_framework.test import APITestCase
from workspace.models import File, Folder, Workspace
from .helpers import ResourceAPIMixin

class ResourceAPITests(ResourceAPIMixin, APITestCase):
    def test_file_crud_and_saved_content_survives_workspace_refresh(self):
        folder = Folder.objects.create(workspace=self.workspace, name="src")
        response = self.client.post(
            self.file_list_url(),
            {"name": "main.py", "language": "python", "content": "print('hi')", "folder": str(folder.id)},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        file_id = response.data["id"]
        file = File.objects.get(pk=file_id)
        self.assertEqual(file.workspace, self.workspace)
        self.assertEqual(file.folder, folder)

        detail_url = reverse(
            "workspace-file-detail",
            kwargs={"workspace_id": self.workspace.id, "pk": file_id},
        )
        update_response = self.client.patch(
            detail_url,
            {"name": "renamed_main.js", "language": "javascript", "content": "console.log('updated')"},
            format="json",
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.data["name"], "renamed_main.js")
        self.assertEqual(update_response.data["language"], "javascript")
        self.assertEqual(update_response.data["content"], "console.log('updated')")

        tree_response = self.client.get(
            reverse("workspace-detail", kwargs={"pk": self.workspace.id})
        )
        src_folder = next(
            item for item in tree_response.data["children"] if item.get("id") == str(folder.id)
        )
        self.assertEqual(src_folder["children"][0]["content"], "console.log('updated')")
        self.assertEqual(self.client.delete(detail_url).status_code, 204)
        self.assertFalse(File.objects.filter(pk=file_id).exists())


    def test_file_extension_and_language_must_match_on_rename(self):
        file = File.objects.create(
            workspace=self.workspace,
            name="main",
            language="",
            content="preserve me",
        )
        detail_url = reverse(
            "workspace-file-detail",
            kwargs={"workspace_id": self.workspace.id, "pk": file.id},
        )
        response = self.client.patch(
            detail_url,
            {"name": "main.py", "language": "cpp"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        file.refresh_from_db()
        self.assertEqual(file.name, "main")
        self.assertEqual(file.language, "")
        self.assertEqual(file.content, "preserve me")


    def test_extensionless_file_can_be_renamed_without_changing_identity_or_content(self):
        folder = Folder.objects.create(workspace=self.workspace, name="src")
        file = File.objects.create(
            workspace=self.workspace,
            folder=folder,
            name="main",
            language="",
            content="print('still here')",
        )
        detail_url = reverse(
            "workspace-file-detail",
            kwargs={"workspace_id": self.workspace.id, "pk": file.id},
        )
        response = self.client.patch(
            detail_url,
            {"name": "main.py", "language": "python"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        file.refresh_from_db()
        self.assertEqual(str(file.id), response.data["id"])
        self.assertEqual(file.name, "main.py")
        self.assertEqual(file.language, "python")
        self.assertEqual(file.workspace, self.workspace)
        self.assertEqual(file.folder, folder)
        self.assertEqual(file.content, "print('still here')")
        tree = self.client.get(
            reverse("workspace-detail", kwargs={"pk": self.workspace.id})
        ).data["children"]
        src = next(item for item in tree if item["id"] == str(folder.id))
        self.assertEqual(src["children"][0]["name"], "main.py")
        self.assertEqual(src["children"][0]["language"], "python")



class FileEdgeTests(ResourceAPIMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.file = File.objects.create(workspace=self.workspace, name='main.py', language='python', content='original')
        self.url = reverse('workspace-file-detail', kwargs={'workspace_id': self.workspace.pk, 'pk': self.file.pk})

    def test_list_and_detail_scoped_to_workspace(self):
        foreign = File.objects.create(workspace=self.other_workspace, name='secret')
        self.assertEqual([item['id'] for item in self.client.get(self.file_list_url()).data], [str(self.file.pk)])
        url = reverse('workspace-file-detail', kwargs={'workspace_id': self.workspace.pk, 'pk': foreign.pk})
        for method in [self.client.get, self.client.patch, self.client.delete]:
            self.assertEqual(method(url).status_code, 404)

    def test_root_creation_ignores_body_workspace_and_client_id(self):
        import uuid
        supplied = uuid.uuid4()
        result = self.client.post(self.file_list_url(), {'name': 'README', 'workspace': str(self.other_workspace.pk), 'id': str(supplied)}, format='json')
        self.assertEqual(result.status_code, 201)
        file = File.objects.get(pk=result.data['id'])
        self.assertEqual(file.workspace, self.workspace)
        self.assertNotEqual(file.pk, supplied)
        self.assertIsNone(file.folder)

    def test_content_only_save_preserves_whitespace_identity_and_metadata(self):
        for content in ['  print("hello")\n\n', '', '\n']:
            with self.subTest(content=content):
                response = self.client.patch(self.url, {'content': content}, format='json')
                self.assertEqual(response.status_code, 200)
                self.file.refresh_from_db()
                self.assertEqual(self.file.content, content)
                self.assertEqual(self.file.name, 'main.py')
                self.assertEqual(self.file.language, 'python')

    def test_put_and_moving_between_folder_and_root(self):
        folder = Folder.objects.create(workspace=self.workspace, name='src')
        response = self.client.put(self.url, {'name': 'main.cpp', 'language': 'cpp', 'content': 'code', 'folder': str(folder.pk)}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['folder'], folder.pk)
        self.assertEqual(self.client.patch(self.url, {'folder': None}, format='json').status_code, 200)
        self.file.refresh_from_db()
        self.assertIsNone(self.file.folder)

    def test_invalid_names_languages_and_foreign_folder_do_not_mutate(self):
        foreign = Folder.objects.create(workspace=self.other_workspace, name='foreign')
        for payload in [{'name': ''}, {'name': 'x' * 256}, {'name': 'main.js'}, {'language': 'cpp'}, {'folder': str(foreign.pk)}, {'folder': 'bad'}]:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.patch(self.url, payload, format='json').status_code, 400)
                self.file.refresh_from_db()
                self.assertEqual(self.file.content, 'original')
                self.assertEqual(self.file.name, 'main.py')

    def test_missing_resource_and_delete_twice(self):
        import uuid
        self.assertEqual(self.client.get(reverse('workspace-file-list-create', kwargs={'workspace_id': uuid.uuid4()})).status_code, 404)
        self.assertEqual(self.client.delete(self.url).status_code, 204)
        self.assertEqual(self.client.delete(self.url).status_code, 404)
