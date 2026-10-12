import uuid
from django.test import TestCase, SimpleTestCase
from workspace.models import Workspace, Folder, File
from workspace.serializers import FileSerializer, FolderSerializer, WorkspaceTreeSerializer, RunFileRequestSerializer


class SerializerTests(TestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name='one')
        self.other = Workspace.objects.create(name='two')
        self.folder = Folder.objects.create(workspace=self.workspace, name='src')
        self.foreign = Folder.objects.create(workspace=self.other, name='private')

    def serializer(self, cls, data, instance=None):
        return cls(instance=instance, data=data, partial=instance is not None, context={'workspace': self.workspace})

    def test_optional_parent_and_folder_allow_root(self):
        for cls, field in [(FolderSerializer, 'parent'), (FileSerializer, 'folder')]:
            for payload in [{'name': 'root'}, {'name': 'root', field: None}]:
                with self.subTest(cls=cls, payload=payload):
                    serializer = self.serializer(cls, payload)
                    self.assertTrue(serializer.is_valid(), serializer.errors)
                    self.assertIsNone(serializer.validated_data.get(field))

    def test_relationship_uuid_validation(self):
        for cls, field in [(FolderSerializer, 'parent'), (FileSerializer, 'folder')]:
            for value in ['bad-uuid', str(uuid.uuid4()), str(self.foreign.id)]:
                with self.subTest(cls=cls, value=value):
                    serializer = self.serializer(cls, {'name': 'item', field: value})
                    self.assertFalse(serializer.is_valid())
                    self.assertIn(field, serializer.errors)
            serializer = self.serializer(cls, {'name': 'item', field: str(self.folder.id)})
            self.assertTrue(serializer.is_valid(), serializer.errors)
            self.assertEqual(serializer.validated_data[field], self.folder)

    def test_names_required_nonempty_and_bounded(self):
        for cls in [FolderSerializer, FileSerializer]:
            for payload in [{}, {'name': ''}, {'name': '   '}, {'name': 'x' * 256}]:
                with self.subTest(cls=cls, payload=payload):
                    serializer = self.serializer(cls, payload)
                    self.assertFalse(serializer.is_valid())
                    self.assertIn('name', serializer.errors)

    def test_read_only_identity_and_workspace_are_not_writable(self):
        serializer = self.serializer(FileSerializer, {'id': str(uuid.uuid4()), 'workspace': str(self.other.id), 'name': 'file', 'created_at': '2000-01-01T00:00:00Z'})
        self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertEqual(serializer.validated_data, {'name': 'file'})

    def test_aliases_case_and_mismatched_languages(self):
        for name, language in [('main.PY', ' Python '), ('main.cpp', 'c++'), ('main.cs', 'c#'), ('main.sh', 'shell')]:
            serializer = self.serializer(FileSerializer, {'name': name, 'language': language})
            self.assertTrue(serializer.is_valid(), serializer.errors)
        serializer = self.serializer(FileSerializer, {'name': 'main.py', 'language': 'cpp'})
        self.assertFalse(serializer.is_valid())
        self.assertIn('language', serializer.errors)

    def test_partial_rename_validates_existing_language(self):
        file = File.objects.create(workspace=self.workspace, name='main.py', language='python')
        serializer = self.serializer(FileSerializer, {'name': 'main.js'}, file)
        self.assertFalse(serializer.is_valid())
        serializer = self.serializer(FileSerializer, {'content': 'changed'}, file)
        self.assertTrue(serializer.is_valid())

    def test_source_whitespace_is_preserved_exactly(self):
        source = '\n  # indentation and trailing newlines matter\n\n'
        serializer = self.serializer(FileSerializer, {'name': 'file', 'content': source})
        self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertEqual(serializer.validated_data['content'], source)

    def test_folders_reject_self_and_descendant_parent_cycles(self):
        child = Folder.objects.create(workspace=self.workspace, parent=self.folder, name='child')
        grandchild = Folder.objects.create(workspace=self.workspace, parent=child, name='deep')
        for parent in [self.folder, child, grandchild]:
            serializer = self.serializer(FolderSerializer, {'parent': str(parent.id)}, self.folder)
            self.assertFalse(serializer.is_valid())
            self.assertIn('parent', serializer.errors)

    def test_tree_serialization_contains_each_node_once(self):
        nested = Folder.objects.create(workspace=self.workspace, parent=self.folder, name='nested')
        file = File.objects.create(workspace=self.workspace, folder=nested, name='main', language='python', content='print(1)')
        File.objects.create(workspace=self.other, name='hidden')
        result = WorkspaceTreeSerializer(self.workspace).data
        self.assertEqual(len(result['children']), 1)
        node = result['children'][0]['children'][0]['children'][0]
        self.assertEqual(node, {'id': str(file.id), 'name': 'main', 'type': 'file', 'language': 'python', 'content': 'print(1)'})


class RunRequestTests(SimpleTestCase):
    def test_source_required_and_size_limited_but_can_be_empty(self):
        for payload in [{}, {'content': None}, {'content': 'x' * 65537}]:
            self.assertFalse(RunFileRequestSerializer(data=payload).is_valid())
        for source in ['', 'x' * 65536]:
            self.assertTrue(RunFileRequestSerializer(data={'content': source}).is_valid())
