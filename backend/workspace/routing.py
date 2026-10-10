from django.urls import re_path

from .consumers import TerminalConsumer


websocket_urlpatterns = [
    re_path(
        r"^api/workspaces/(?P<workspace_id>[0-9a-fA-F-]{36})/files/(?P<file_id>[0-9a-fA-F-]{36})/run/$",
        TerminalConsumer.as_asgi(),
    ),
]
