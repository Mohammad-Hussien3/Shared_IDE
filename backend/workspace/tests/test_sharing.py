from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase
from workspace.models import File, FileCollaborator, FileInvitation, Workspace
from workspace.sharing import permission_for


class SharingTests(APITestCase):
    def setUp(self):
        cache.clear()
        User = get_user_model()
        self.owner = User.objects.create_user('owner')
        self.editor = User.objects.create_user('editor', email='private@example.com')
        self.other = User.objects.create_user('other')
        self.workspace = Workspace.objects.create(owner=self.owner)
        self.file = File.objects.create(workspace=self.workspace, name='main.py', language='python', content='print(1)')
        self.sibling = File.objects.create(workspace=self.workspace, name='private.py')
        self.base = f'/api/sharing/files/{self.file.pk}/'
        self.manage = self.base + 'manage/'
        self.client.force_authenticate(self.owner)

    def invite(self, permission='edit'):
        self.client.force_authenticate(self.owner)
        response = self.client.post(self.manage, {'recipient': self.editor.pk, 'permission': permission})
        self.assertEqual(response.status_code, 201, response.data)
        return response.data['id']

    def respond(self, invitation, action='accept', user=None):
        self.client.force_authenticate(user or self.editor)
        return self.client.post(f'/api/sharing/invitations/{invitation}/', {'action': action})

    def test_accept_is_recipient_only_single_use_and_file_scoped(self):
        invitation = self.invite()
        self.client.force_authenticate(self.editor)
        self.assertEqual(self.client.get(self.base).status_code, 404)
        self.assertIsNone(permission_for(self.file, self.editor))
        self.assertEqual(self.respond(invitation, user=self.other).status_code, 404)
        self.assertEqual(self.respond(invitation).status_code, 200)
        self.assertEqual(self.respond(invitation).status_code, 409)
        self.assertEqual(self.client.get(self.base).data['content'], 'print(1)')
        data = self.client.get(self.base).data
        self.assertNotIn('workspace', data)
        self.assertNotIn('folder', data)
        self.assertEqual(permission_for(self.file, self.editor), 'edit')
        self.assertEqual(len(self.client.get('/api/sharing/files/').data), 1)
        self.assertEqual(self.client.get(f'/api/sharing/files/{self.sibling.pk}/').status_code, 404)
        self.assertEqual(self.client.get(f'/api/workspaces/{self.workspace.pk}/').status_code, 404)
        original = f'/api/workspaces/{self.workspace.pk}/files/{self.file.pk}/'
        for method, body in [('get', {}), ('patch', {'content': 'attack'}), ('delete', {})]:
            self.assertEqual(getattr(self.client, method)(original, body).status_code, 404)
        self.assertEqual(self.client.post(original + 'run/', {'content': 'attack'}).status_code, 404)
        self.assertEqual(self.client.patch(self.base, {'name': 'stolen'}).status_code, 400)
        self.file.refresh_from_db()
        self.assertEqual(self.file.content, 'print(1)')

    def test_decline_cancel_and_reinvite(self):
        invitation = self.invite()
        self.assertEqual(self.respond(invitation, 'decline').status_code, 200)
        self.assertFalse(FileCollaborator.objects.exists())
        invitation = self.invite()
        self.assertEqual(self.respond(invitation, 'cancel', self.editor).status_code, 404)
        self.assertEqual(self.respond(invitation, 'cancel', self.owner).status_code, 200)
        self.assertEqual(self.respond(invitation).status_code, 409)
        self.assertEqual(FileInvitation.objects.get(pk=invitation).status, 'canceled')

    def test_duplicate_self_and_invalid_permission_rejected(self):
        self.assertEqual(self.client.post(self.manage, {'recipient': self.owner.pk}).status_code, 400)
        self.assertEqual(self.client.post(self.manage, {'recipient': self.editor.pk, 'permission': 'owner'}).status_code, 400)
        invitation = self.invite()
        self.assertEqual(self.client.post(self.manage, {'recipient': self.editor.pk}).status_code, 409)
        self.respond(invitation)
        self.client.force_authenticate(self.owner)
        self.assertEqual(self.client.post(self.manage, {'recipient': self.editor.pk}).status_code, 409)
        self.assertEqual(FileCollaborator.objects.count(), 1)

    def test_owner_downgrades_and_revokes_access(self):
        invitation = self.invite()
        self.respond(invitation)
        member = self.base + f'members/{self.editor.pk}/'
        self.assertEqual(self.client.patch(member, {'permission': 'view'}).status_code, 404)
        self.assertEqual(self.client.delete(member).status_code, 404)
        self.assertEqual(self.client.post(self.manage, {'recipient': self.other.pk}).status_code, 404)
        self.client.force_authenticate(self.owner)
        self.assertEqual(self.client.patch(member, {'permission': 'view'}).status_code, 200)
        self.assertEqual(permission_for(self.file, self.editor), 'view')
        self.assertEqual(self.client.delete(member).status_code, 204)
        self.assertEqual(FileInvitation.objects.get(pk=invitation).status, 'revoked')
        self.client.force_authenticate(self.editor)
        self.assertEqual(self.client.get(self.base).status_code, 404)
        self.assertEqual(self.client.get('/api/sharing/files/').data, [])
        self.assertEqual(self.respond(invitation).status_code, 409)
        self.assertEqual(self.respond(self.invite()).status_code, 200)

    def test_lists_do_not_leak_other_invitations_or_emails(self):
        invitation = self.invite('view')
        self.assertEqual(len(self.client.get('/api/sharing/invitations/?direction=sent').data), 1)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get('/api/sharing/invitations/').data, [])
        self.assertEqual(self.client.get('/api/sharing/invitations/?direction=sent').data, [])
        self.client.force_authenticate(self.editor)
        data = self.client.get('/api/sharing/invitations/').data
        self.assertEqual(data[0]['id'], invitation)
        self.assertNotIn('email', data[0]['sender'])
        self.assertEqual(self.respond(invitation).status_code, 200)
        self.assertEqual(self.client.get(self.base).data['permission'], 'view')

    def test_search_is_owner_scoped_limited_and_does_not_return_email(self):
        url = f'/api/sharing/users/?file={self.file.pk}&q='
        self.assertEqual(self.client.get(url+'ed').data, [])
        self.assertEqual(self.client.get(url+'private@').data, [])
        result = self.client.get(url+'private@example.com').data
        self.assertEqual(result, [{'id': self.editor.pk, 'username': 'editor'}])
        self.assertEqual(self.client.get('/api/sharing/users/?file=bad&q=editor').status_code, 400)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(url+'editor').status_code, 404)

    def test_search_is_throttled_and_anonymous_access_denied(self):
        for _ in range(20):
            self.client.get(f'/api/sharing/users/?file={self.file.pk}&q=editor')
        self.assertEqual(self.client.get(f'/api/sharing/users/?file={self.file.pk}&q=editor').status_code, 429)
        self.client.force_authenticate(None)
        for path in [self.base, self.manage, '/api/sharing/files/', '/api/sharing/invitations/']:
            self.assertEqual(self.client.get(path).status_code, 401)

    def test_owned_shared_list_has_only_accepted_collaborators_and_no_workspace_data(self):
        invitation = self.invite()
        self.assertEqual(self.client.get('/api/sharing/files/?direction=owned').data, [])
        self.respond(invitation)
        self.client.force_authenticate(self.owner)
        FileCollaborator.objects.create(file=self.file, user=self.other, permission='view', granted_by=self.owner)
        result = self.client.get('/api/sharing/files/?direction=owned')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(result.data), 1)
        self.assertEqual(result.data[0]['id'], str(self.file.pk))
        self.assertEqual(result.data[0]['permission'], 'owner')
        self.assertEqual(result.data[0]['collaborator_count'], 2)
        for field in ('workspace', 'folder', 'content', 'email'):
            self.assertNotIn(field, result.data[0])
        self.client.force_authenticate(self.editor)
        self.assertEqual(self.client.get('/api/sharing/files/?direction=owned').data, [])
        self.assertEqual(len(self.client.get('/api/sharing/files/').data), 1)
        FileCollaborator.objects.filter(file=self.file).delete()
        self.client.force_authenticate(self.owner)
        self.assertEqual(self.client.get('/api/sharing/files/?direction=owned').data, [])
