from unittest.mock import patch

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


class FileRunAPITests(APITestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Run workspace")
        self.file = File.objects.create(
            workspace=self.workspace,
            name="main.py",
            language="python",
            content="saved content",
        )
        self.run_url = reverse(
            "workspace-file-run",
            kwargs={"workspace_id": self.workspace.id, "pk": self.file.id},
        )

    @patch("workspace.views.run_program")
    def test_run_uses_extension_and_current_request_content(self, run_program):
        run_program.return_value = {
            "stdout": "from runner", "stderr": "", "exit_code": 0,
            "timed_out": False, "output_limited": False,
        }
        response = self.client.post(
            self.run_url,
            {"content": "console.log('extension wins')"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["language"], "python")
        run_program.assert_called_once_with("python", "console.log('extension wins')")

    @patch("workspace.views.run_program")
    def test_run_detects_extensionless_python_from_content(self, run_program):
        self.file.name = "main"
        self.file.save(update_fields=["name"])
        run_program.return_value = {
            "stdout": "hello\n", "stderr": "", "exit_code": 0,
            "timed_out": False, "output_limited": False,
        }
        response = self.client.post(
            self.run_url, {"content": "print('hello')"}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["language"], "python")
        run_program.assert_called_once_with("python", "print('hello')")

    @patch("workspace.views.run_program")
    def test_run_detects_extensionless_c_from_content(self, run_program):
        self.file.name = "hello"
        self.file.save(update_fields=["name"])
        run_program.return_value = {
            "stdout": "hello from c\n", "stderr": "", "exit_code": 0,
            "timed_out": False, "output_limited": False,
        }
        source = '#include <stdio.h>\nint main(void) { puts("hello from c"); }'
        response = self.client.post(
            self.run_url, {"content": source}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["language"], "c")
        run_program.assert_called_once_with("c", source)

    @patch("workspace.views.run_program")
    def test_run_detects_and_executes_cpp(self, run_program):
        self.file.name = "main.cpp"
        self.file.save(update_fields=["name"])
        run_program.return_value = {
            "stdout": "hello from cpp\n", "stderr": "", "exit_code": 0,
            "timed_out": False, "output_limited": False,
        }
        source = '#include <iostream>\nint main() { std::cout << "hello from cpp\\n"; }'
        response = self.client.post(
            self.run_url, {"content": source}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["language"], "cpp")
        run_program.assert_called_once_with("cpp", source)

    @patch("workspace.views.run_program")
    def test_run_detects_extensionless_cpp_from_content(self, run_program):
        self.file.name = "program"
        self.file.save(update_fields=["name"])
        run_program.return_value = {
            "stdout": "hello from cpp\n", "stderr": "", "exit_code": 0,
            "timed_out": False, "output_limited": False,
        }
        source = '#include <iostream>\nint main() { std::cout << "hello"; }'
        response = self.client.post(
            self.run_url, {"content": source}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["language"], "cpp")
        run_program.assert_called_once_with("cpp", source)

    @patch("workspace.views.run_program")
    def test_run_rejects_ambiguous_or_unsupported_source(self, run_program):
        self.file.name = "main"
        self.file.save(update_fields=["name"])
        response = self.client.post(
            self.run_url, {"content": "x = transform(data)"}, format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Could not confidently detect", response.data["detail"])

        self.file.name = "main.js"
        self.file.save(update_fields=["name"])
        response = self.client.post(
            self.run_url, {"content": "console.log('hello')"}, format="json"
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("only for Python", response.data["detail"])
        run_program.assert_not_called()
