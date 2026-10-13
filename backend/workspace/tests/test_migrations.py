from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class LegacyWorkspaceMigrationTests(TransactionTestCase):
    def test_owner_migration_preserves_existing_tree_without_assigning_user(self):
        before = [('workspace', '0002_folder_file')]
        after = [('workspace', '0003_workspace_owner')]
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        try:
            apps = executor.loader.project_state(before).apps
            workspace = apps.get_model('workspace', 'Workspace').objects.create(name='legacy')
            folder = apps.get_model('workspace', 'Folder').objects.create(workspace=workspace, name='src')
            file = apps.get_model('workspace', 'File').objects.create(workspace=workspace, folder=folder, name='old.py', content='print(123)', language='python')
            executor = MigrationExecutor(connection)
            executor.migrate(after)
            apps = executor.loader.project_state(after).apps
            migrated = apps.get_model('workspace', 'Workspace').objects.get(pk=workspace.pk)
            saved = apps.get_model('workspace', 'File').objects.get(pk=file.pk)
            self.assertIsNone(migrated.owner_id)
            self.assertEqual(saved.content, 'print(123)')
            self.assertEqual(saved.folder_id, folder.pk)
            self.assertEqual(saved.workspace_id, workspace.pk)
        finally:
            MigrationExecutor(connection).migrate(after)
