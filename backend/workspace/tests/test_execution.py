from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase
from workspace.models import File, Workspace

class FileRunAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='runner')
        self.client.force_authenticate(self.user)
        self.workspace = Workspace.objects.create(name="Run workspace", owner=self.user)
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


    @patch("workspace.views.run_program")
    def test_unavailable_runner_returns_actionable_503(self, run_program):
        from workspace.runner import RunnerUnavailable
        run_program.side_effect = RunnerUnavailable('Podman image missing; podman pull image')
        result = self.client.post(self.run_url, {'content': 'print(1)'}, format='json')
        self.assertEqual(result.status_code, 503)
        self.assertIn('podman pull', result.data['detail'])

    @patch("workspace.views.run_program")
    def test_invalid_payload_or_unknown_workspace_never_starts_runner(self, run_program):
        import uuid
        for payload in [{}, {'content': None}, {'content': 'x' * 65537}]:
            self.assertEqual(self.client.post(self.run_url, payload, format='json').status_code, 400)
        for workspace_id, file_id in [(uuid.uuid4(), self.file.pk), (self.workspace.pk, uuid.uuid4())]:
            url = reverse('workspace-file-run', kwargs={'workspace_id': workspace_id, 'pk': file_id})
            self.assertEqual(self.client.post(url, {'content': 'print(1)'}, format='json').status_code, 404)
        self.assertEqual(self.client.get(self.run_url).status_code, 405)
        run_program.assert_not_called()

    @patch("workspace.views.run_program")
    def test_runtime_error_timeout_and_output_limit_are_reported(self, run_program):
        for flag in ['timed_out', 'output_limited', 'runtime']:
            result = {'stdout': 'partial', 'stderr': 'error', 'exit_code': 1, 'timed_out': flag == 'timed_out', 'output_limited': flag == 'output_limited'}
            run_program.return_value = result
            response = self.client.post(self.run_url, {'content': 'print(1)'}, format='json')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, {'language': 'python', **result})
        self.file.refresh_from_db()
        self.assertEqual(self.file.content, 'saved content')

    @patch('workspace.views.run_program')
    def test_execution_receives_exact_source_whitespace(self, run_program):
        run_program.return_value = {'stdout': '', 'stderr': '', 'exit_code': 0}
        source = '\n  print("do not silently fix indentation")\n\n'
        response = self.client.post(self.run_url, {'content': source}, format='json')
        self.assertEqual(response.status_code, 200)
        run_program.assert_called_once_with('python', source)
