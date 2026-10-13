from io import StringIO
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command, CommandError
from rest_framework.test import APITestCase

from workspace.models import Workspace, Folder, File


class WorkspaceOwnershipTests(APITestCase):
    def setUp(self):
        self.alice = get_user_model().objects.create_user(username='alice')
        self.bob = get_user_model().objects.create_user(username='bob')
        self.one = Workspace.objects.create(owner=self.alice, name='one')
        self.two = Workspace.objects.create(owner=self.alice, name='two')
        self.private = Workspace.objects.create(owner=self.bob, name='private')
        self.folder = Folder.objects.create(workspace=self.private, name='secret')
        self.file = File.objects.create(workspace=self.private, folder=self.folder, name='private.py', language='python', content='print("private")')
        self.client.force_authenticate(self.alice)

    def test_owner_is_assigned_and_cannot_be_overridden(self):
        result = self.client.post('/api/workspaces/', {'name': 'new', 'owner': self.bob.pk}, format='json')
        self.assertEqual(result.status_code, 201)
        new = Workspace.objects.get(pk=result.data['id'])
        self.assertEqual(new.owner, self.alice)
        result = self.client.patch(f'/api/workspaces/{new.pk}/', {'owner': self.bob.pk, 'name': 'renamed'}, format='json')
        self.assertEqual(result.status_code, 200)
        new.refresh_from_db()
        self.assertEqual((new.owner, new.name), (self.alice, 'renamed'))
        listed = self.client.get('/api/workspaces/').data
        self.assertEqual({w['id'] for w in listed}, {str(w.pk) for w in [self.one, self.two, new]})

    @patch('workspace.views.run_program')
    def test_all_private_routes_reject_other_users_without_disclosing_data(self, run):
        base = f'/api/workspaces/{self.private.pk}/'
        routes = [base, base+'folders/', base+'files/', base+f'folders/{self.folder.pk}/', base+f'files/{self.file.pk}/']
        for url in routes:
            for method in ['get', 'patch', 'delete'] if url.endswith(f'{self.private.pk}/') or url.endswith(f'{self.folder.pk}/') or url.endswith(f'{self.file.pk}/') else ['get', 'post']:
                result = getattr(self.client, method)(url, {'name': 'stolen'}, format='json')
                self.assertEqual(result.status_code, 404, (method, url, result.data))
        result = self.client.post(base+f'files/{self.file.pk}/run/', {'content': 'print(1)'}, format='json')
        self.assertEqual(result.status_code, 404)
        run.assert_not_called()
        self.assertTrue(File.objects.filter(pk=self.file.pk).exists())

    def test_anonymous_requests_are_rejected(self):
        self.client.force_authenticate(None)
        base = f'/api/workspaces/{self.one.pk}/'
        for url in ['/api/workspaces/', base, base+'files/', base+'folders/']:
            self.assertEqual(self.client.get(url).status_code, 401)
            self.assertEqual(self.client.post(url, {'name': 'anonymous'}).status_code, 401)
        self.assertEqual(self.client.post(f'/api/workspaces/{self.private.pk}/files/{self.file.pk}/run/', {'content': 'print(1)'}).status_code, 401)

    def test_same_owner_trees_and_relationships_stay_separate_on_create_and_update(self):
        a = Folder.objects.create(workspace=self.one, name='a')
        b = Folder.objects.create(workspace=self.two, name='b')
        deep = Folder.objects.create(workspace=self.one, name='deep', parent=a)
        own_file = File.objects.create(workspace=self.one, folder=deep, name='own')
        File.objects.create(workspace=self.two, folder=b, name='hidden')
        for folder in [b, self.folder]:
            for endpoint, field, record in [('folders', 'parent', deep), ('files', 'folder', own_file)]:
                base = f'/api/workspaces/{self.one.pk}/{endpoint}/'
                self.assertEqual(self.client.post(base, {'name': 'bad', field: str(folder.pk)}, format='json').status_code, 400)
                self.assertEqual(self.client.patch(base+f'{record.pk}/', {field: str(folder.pk)}, format='json').status_code, 400)
        tree = self.client.get(f'/api/workspaces/{self.one.pk}/').data
        self.assertNotIn('hidden', str(tree))
        self.assertNotIn('private', str(tree))
        self.assertEqual(tree['children'][0]['children'][0]['children'][0]['id'], str(own_file.pk))
        self.assertEqual(self.client.get(f'/api/workspaces/{self.two.pk}/files/{own_file.pk}/').status_code, 404)
        self.assertEqual(self.client.delete(f'/api/workspaces/{self.one.pk}/').status_code, 204)
        self.assertTrue(Workspace.objects.filter(pk=self.two.pk).exists())

    def test_legacy_workspace_is_hidden_until_explicitly_claimed(self):
        legacy = Workspace.objects.create(name='legacy')
        file = File.objects.create(workspace=legacy, name='kept', content='unchanged')
        self.assertEqual(self.client.get(f'/api/workspaces/{legacy.pk}/').status_code, 404)
        self.assertNotIn(str(legacy.pk), str(self.client.get('/api/workspaces/').data))
        output = StringIO()
        call_command('claim_workspace', list_unclaimed=True, stdout=output)
        self.assertIn(str(legacy.pk), output.getvalue())
        call_command('claim_workspace', str(legacy.pk), 'alice', stdout=StringIO())
        self.assertEqual(self.client.get(f'/api/workspaces/{legacy.pk}/').status_code, 200)
        file.refresh_from_db()
        self.assertEqual(file.content, 'unchanged')
        with self.assertRaises(CommandError):
            call_command('claim_workspace', str(legacy.pk), 'bob')
        legacy.refresh_from_db()
        self.assertEqual(legacy.owner, self.alice)
