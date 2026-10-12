import uuid
from django.test import TestCase
from workspace.models import Workspace, Folder, File


class ModelTests(TestCase):
    def test_workspace_defaults_uuid_and_timestamps(self):
        one, two = Workspace.objects.create(), Workspace.objects.create()
        self.assertEqual(one.name, 'Untitled Workspace')
        self.assertIsInstance(one.id, uuid.UUID)
        self.assertNotEqual(one.id, two.id)
        self.assertEqual(str(one), one.name)
        self.assertIsNotNone(one.created_at)
        self.assertIsNotNone(one.updated_at)

    def test_root_and_nested_relationships_and_string_representations(self):
        workspace = Workspace.objects.create(name='Project')
        root = Folder.objects.create(workspace=workspace, name='src')
        nested = Folder.objects.create(workspace=workspace, parent=root, name='nested')
        file = File.objects.create(workspace=workspace, folder=nested, name='main')
        loose = File.objects.create(workspace=workspace, name='README')
        self.assertIsNone(root.parent)
        self.assertIsNone(loose.folder)
        self.assertEqual(file.content, '')
        self.assertEqual(file.language, '')
        self.assertEqual(list(root.children.all()), [nested])
        self.assertEqual(list(nested.files.all()), [file])
        self.assertEqual(str(root), 'src')
        self.assertEqual(str(file), 'main')
        self.assertEqual(workspace.files.count(), 2)

    def test_folder_delete_cascades_only_its_subtree(self):
        workspace = Workspace.objects.create()
        root = Folder.objects.create(workspace=workspace, name='src')
        nested = Folder.objects.create(workspace=workspace, parent=root, name='nested')
        child = File.objects.create(workspace=workspace, folder=nested, name='child')
        loose = File.objects.create(workspace=workspace, name='README')
        root.delete()
        self.assertFalse(Folder.objects.exists())
        self.assertFalse(File.objects.filter(pk=child.pk).exists())
        self.assertTrue(File.objects.filter(pk=loose.pk).exists())
        self.assertTrue(Workspace.objects.filter(pk=workspace.pk).exists())

    def test_workspace_delete_cascades_without_affecting_other_workspace(self):
        one, two = Workspace.objects.create(), Workspace.objects.create()
        folder = Folder.objects.create(workspace=one, name='src')
        File.objects.create(workspace=one, folder=folder, name='main')
        other = File.objects.create(workspace=two, name='other')
        one.delete()
        self.assertFalse(Folder.objects.exists())
        self.assertEqual(list(File.objects.all()), [other])
