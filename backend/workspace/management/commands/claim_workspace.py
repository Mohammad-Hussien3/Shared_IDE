from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.core.exceptions import ValidationError

from workspace.models import Workspace


class Command(BaseCommand):
    help = 'Explicitly assign an unclaimed legacy workspace to a verified user.'

    def add_arguments(self, parser):
        parser.add_argument('workspace_id', nargs='?')
        parser.add_argument('username', nargs='?')
        parser.add_argument('--list-unclaimed', action='store_true')

    def handle(self, *args, **options):
        if options['list_unclaimed']:
            for pk, name in Workspace.objects.filter(owner__isnull=True).values_list('pk', 'name'):
                self.stdout.write(f'{pk}  {name}')
            return
        if not options['workspace_id'] or not options['username']:
            raise CommandError('Provide a workspace UUID and the verified owner username.')
        try:
            user = get_user_model().objects.get(username=options['username'], is_active=True)
            changed = Workspace.objects.filter(pk=options['workspace_id'], owner__isnull=True).update(owner=user)
        except (get_user_model().DoesNotExist, ValidationError) as exc:
            raise CommandError('Invalid workspace UUID or active username.') from exc
        if not changed:
            raise CommandError('Workspace does not exist or already has an owner; nothing changed.')
        self.stdout.write(self.style.SUCCESS('Workspace assigned. Existing files and folders were preserved.'))
