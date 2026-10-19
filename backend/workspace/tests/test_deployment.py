from unittest.mock import AsyncMock, patch

from django.db import OperationalError
from django.test import SimpleTestCase, TestCase

from workspace.interactive_runner import InteractiveRunner
from workspace.runner import RunnerUnavailable, run_program


class HealthTests(TestCase):
    def test_health_checks_the_database_without_authentication(self):
        response = self.client.get('/healthz/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})
        self.assertEqual(self.client.post('/healthz/').status_code, 405)

    def test_database_failure_does_not_expose_connection_details(self):
        with patch('Shared_IDE.health.connection.cursor', side_effect=OperationalError('private password and hostname')):
            response = self.client.get('/healthz/')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'status': 'unavailable'})


class DisabledExecutionTests(SimpleTestCase):
    @patch.dict('os.environ', {'CODE_EXECUTION_ENABLED': 'false'})
    @patch('workspace.runner.subprocess.Popen')
    @patch('workspace.runner.subprocess.run')
    def test_disabled_execution_never_launches_a_process(self, run, popen):
        with self.assertRaisesRegex(RunnerUnavailable, 'not configured for this deployment'):
            run_program('python', 'print(1)')
        run.assert_not_called()
        popen.assert_not_called()

    @patch.dict('os.environ', {'CODE_EXECUTION_ENABLED': 'false'})
    async def test_disabled_terminal_never_opens_a_pty_or_process(self):
        with patch('workspace.interactive_runner.pty.openpty') as pty, patch(
            'workspace.interactive_runner.asyncio.create_subprocess_exec', new_callable=AsyncMock
        ) as spawn:
            with self.assertRaisesRegex(RunnerUnavailable, 'not configured for this deployment'):
                await InteractiveRunner('python', 'print(1)').start()
        pty.assert_not_called()
        spawn.assert_not_called()
