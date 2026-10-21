from django.urls import re_path

from .consumers import SharedTerminalConsumer, TerminalConsumer
from .collaboration_consumer import CollaborationConsumer


websocket_urlpatterns = [
    re_path(r"^api/sharing/files/(?P<file_id>[0-9a-fA-F-]{36})/run/$", SharedTerminalConsumer.as_asgi()),
    re_path(r"^api/collaboration/files/(?P<file_id>[0-9a-fA-F-]{36})/$", CollaborationConsumer.as_asgi()),
    re_path(
        r"^api/workspaces/(?P<workspace_id>[0-9a-fA-F-]{36})/files/(?P<file_id>[0-9a-fA-F-]{36})/run/$",
        TerminalConsumer.as_asgi(),
    ),
]
