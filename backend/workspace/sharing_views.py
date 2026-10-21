from django.contrib.auth import get_user_model
from django.core.cache import cache
from .collaboration import ensure_document, notify, apply_update, decode
from django.db import transaction
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from .models import File, FileCollaborator, FileInvitation
from .sharing import file_data, identity, invitation_data, locked_file, owner_file, permission_for


class InviteSerializer(serializers.Serializer):
    recipient = serializers.IntegerField(min_value=1)
    permission = serializers.ChoiceField(choices=FileInvitation.PERMISSIONS, default='edit')


class PermissionSerializer(serializers.Serializer):
    permission = serializers.ChoiceField(choices=FileInvitation.PERMISSIONS)


class InvitationActionSerializer(serializers.Serializer):
    action = serializers.ChoiceField(choices=['accept', 'decline', 'cancel'])


class UserSearchView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'sharing_search'

    def get(self, request):
        file_id = serializers.UUIDField().run_validation(request.query_params.get('file'))
        file = owner_file(file_id, request.user)
        query = request.query_params.get('q', '').strip()
        if not 3 <= len(query) <= 254:
            return Response([])
        # No email listings or substring email search. Exact email lookup returns
        # only the public username/id needed to address an invitation.
        lookup = Q(email__iexact=query) if '@' in query else Q(username__istartswith=query)
        excluded = FileInvitation.objects.filter(file=file, status__in=['pending', 'accepted']).values('recipient_id')
        users = get_user_model().objects.filter(lookup, is_active=True).exclude(pk=request.user.pk).exclude(
            pk__in=excluded).order_by('username')[:10]
        return Response([identity(user) for user in users])


class FileSharingView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'sharing_manage'

    def get(self, request, file_id):
        file = owner_file(file_id, request.user)
        return Response({
            'file': {'id': str(file.pk), 'name': file.name, 'language': file.language},
            'owner': identity(request.user),
            'collaborators': [
                {'user': identity(m.user), 'permission': m.permission, 'granted_at': m.granted_at,
                 'online': bool(cache.get(f'presence:{file.pk}:{m.user_id}'))}
                for m in file.collaborators.select_related('user').order_by('granted_at')
            ],
            'invitations': [invitation_data(i) for i in file.invitations.filter(status='pending').select_related(
                'file', 'sender', 'recipient').order_by('-created_at')],
        })

    @transaction.atomic
    def post(self, request, file_id):
        file = owner_file(file_id, request.user, lock=True)
        serializer = InviteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        recipient = get_object_or_404(get_user_model(), pk=serializer.validated_data['recipient'], is_active=True)
        if recipient.pk == request.user.pk:
            return Response({'code': 'sharing_self'}, status=400)
        if file.invitations.filter(recipient=recipient, status__in=['pending', 'accepted']).exists() or (
            file.collaborators.filter(user=recipient).exists()
        ):
            return Response({'code': 'sharing_duplicate'}, status=409)
        ensure_document(file)
        invitation = FileInvitation.objects.create(file=file, sender=request.user, recipient=recipient,
                                                  permission=serializer.validated_data['permission'])
        notify(file.pk, access_changed=True)
        return Response(invitation_data(invitation), status=201)


class InvitationListView(APIView):
    def get(self, request):
        outgoing = request.query_params.get('direction') == 'sent'
        query = FileInvitation.objects.filter(**{'sender' if outgoing else 'recipient': request.user})
        if not outgoing:
            query = query.filter(status='pending')
        return Response([invitation_data(i) for i in query.select_related('file', 'sender', 'recipient')
                         .order_by('-created_at')[:200]])


class InvitationRespondView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'sharing_manage'

    @transaction.atomic
    def post(self, request, invitation_id):
        serializer = InvitationActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        action = serializer.validated_data['action']
        scope = {'sender': request.user} if action == 'cancel' else {'recipient': request.user}
        invitation = get_object_or_404(FileInvitation.objects.filter(**scope), pk=invitation_id)
        file = locked_file(invitation.file_id)
        invitation.refresh_from_db()
        if action == 'cancel' and file.workspace.owner_id != request.user.pk:
            raise NotFound()
        if invitation.status != 'pending':
            return Response({'code': 'sharing_transition'}, status=409)
        invitation.status = {'accept': 'accepted', 'decline': 'declined', 'cancel': 'canceled'}[action]
        invitation.save(update_fields=['status', 'updated_at'])
        if action == 'accept':
            FileCollaborator.objects.create(file=file, user=request.user, permission=invitation.permission,
                                            granted_by=invitation.sender)
        notify(file.pk, access_changed=True)
        return Response(invitation_data(invitation))


class CollaboratorView(APIView):
    @transaction.atomic
    def patch(self, request, file_id, user_id):
        file = owner_file(file_id, request.user, lock=True)
        member = get_object_or_404(FileCollaborator, file=file, user_id=user_id)
        serializer = PermissionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        member.permission = serializer.validated_data['permission']
        member.save(update_fields=['permission', 'updated_at'])
        file.invitations.filter(recipient_id=user_id, status='accepted').update(
            permission=member.permission, updated_at=timezone.now())
        notify(file.pk, access_changed=True)
        return Response({'user': identity(member.user), 'permission': member.permission})

    @transaction.atomic
    def delete(self, request, file_id, user_id):
        file = owner_file(file_id, request.user, lock=True)
        member = get_object_or_404(FileCollaborator, file=file, user_id=user_id)
        member.delete()
        file.invitations.filter(recipient_id=user_id, status='accepted').update(
            status='revoked', updated_at=timezone.now())
        notify(file.pk, access_changed=True)
        return Response(status=204)


class SharedFileListView(APIView):
    def get(self, request):
        if request.query_params.get('direction') == 'owned':
            files = File.objects.filter(workspace__owner=request.user).annotate(
                collaborator_count=Count('collaborators'),
            ).filter(collaborator_count__gt=0).select_related('workspace__owner', 'document')
            return Response([
                {**{k: v for k, v in file_data(file, 'owner').items() if k != 'content'},
                 'collaborator_count': file.collaborator_count}
                for file in files.order_by('-updated_at')
            ])
        members = FileCollaborator.objects.filter(user=request.user).select_related('file__workspace__owner', 'file__document')
        return Response([{k: v for k, v in file_data(m.file, m.permission).items() if k != 'content'}
                         for m in members.order_by('-file__updated_at')])


class SharedFileView(APIView):
    def get(self, request, file_id):
        file = get_object_or_404(File.objects.select_related('workspace__owner'), pk=file_id)
        permission = permission_for(file, request.user)
        if not permission:
            raise NotFound()
        return Response(file_data(file, permission))


    def patch(self, request, file_id):
        # Shared writers submit CRDT updates only, never names/ownership/folders
        # or whole-file content that could overwrite concurrent edits.
        file = get_object_or_404(File.objects.select_related('workspace'), pk=file_id)
        if permission_for(file, request.user) is None:
            raise NotFound()
        if permission_for(file, request.user) not in ('owner', 'edit'):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied()
        if not isinstance(request.data, dict) or set(request.data) != {'update'}:
            return Response({'code': 'collaboration_required'}, status=400)
        return Response(apply_update(file_id, request.user, decode(request.data['update'])))
