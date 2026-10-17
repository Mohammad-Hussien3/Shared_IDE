"""Opt-in monitoring. Only allowlisted diagnostics may cross the transport boundary."""

import logging
import math
import os
from pathlib import Path
import re
import sys
from datetime import datetime

import sentry_sdk
from sentry_sdk.envelope import Envelope
from sentry_sdk.integrations.django import DjangoIntegration
from sentry_sdk.transport import HttpTransport
from django.utils.deprecation import MiddlewareMixin


_BASE = Path(__file__).resolve().parent.parent
_FILES = {
    str(path.relative_to(_BASE))
    for package in ('Shared_IDE', 'accounts', 'workspace')
    for path in (_BASE / package).rglob('*.py')
}
_TYPES = {
    'Exception', 'RuntimeError', 'ValueError', 'TypeError', 'AttributeError',
    'KeyError', 'IndexError', 'OSError', 'PermissionError', 'TimeoutError',
    'ConnectionError', 'OperationalError', 'IntegrityError', 'RunnerUnavailable',
}
_COMPONENTS = {'backend', 'api', 'websocket', 'runner'}


def _timestamp(value):
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat()
        except ValueError:
            pass
    return None


def sanitize_event(event, metadata):
    """Rebuild instead of redacting: new SDK fields are excluded by default.

    Exception text can contain passwords, compiler commands, and user code.
    Even stack locals, function names, HTTP paths, and source context are dropped.
    """
    if not isinstance(event, dict):
        return None
    result = {'platform': 'python', **metadata}
    event_id = event.get('event_id', '')
    if isinstance(event_id, str) and re.fullmatch(r'[a-f0-9]{32}', event_id):
        result['event_id'] = event_id
    timestamp = _timestamp(event.get('timestamp'))
    if timestamp is not None:
        result['timestamp'] = timestamp
    if event.get('type') == 'transaction':
        trace = event.get('contexts', {}).get('trace', {})
        if not all(isinstance(trace.get(key), str) and re.fullmatch(pattern, trace[key])
                   for key, pattern in (('trace_id', r'[a-f0-9]{32}'), ('span_id', r'[a-f0-9]{16}'))):
            return None
        start = _timestamp(event.get('start_timestamp'))
        if start is None or timestamp is None:
            return None
        result.update(type='transaction', transaction='HTTP request',
                      start_timestamp=start, spans=[], contexts={'trace': {
                          'trace_id': trace['trace_id'], 'span_id': trace['span_id'],
                          'op': 'http.server',
                      }})
        return result
    values = []
    for exception in event.get('exception', {}).get('values', [])[-10:]:
        frames = []
        for frame in exception.get('stacktrace', {}).get('frames', [])[-50:]:
            filename = frame.get('filename', '')
            if isinstance(filename, str):
                filename = filename.removeprefix(str(_BASE) + '/')
            if filename in _FILES:
                safe = {'filename': filename, 'in_app': True}
                if type(frame.get('lineno')) is int and frame['lineno'] > 0:
                    safe['lineno'] = frame['lineno']
                frames.append(safe)
        kind = exception.get('type')
        values.append({
            'type': kind if kind in _TYPES else 'Exception',
            'value': 'Unexpected application error (details withheld).',
            'stacktrace': {'frames': frames},
        })
    if not values:
        return None  # Never forward arbitrary log messages.
    component = event.get('tags', {}).get('component')
    result.update(level='error', exception={'values': values},
                  tags={'component': component if component in _COMPONENTS else 'backend'})
    status = event.get('tags', {}).get('http_status')
    if type(status) is int and 500 <= status <= 599:
        result['tags']['http_status'] = status
    return result


def sanitize_envelope(envelope, metadata):
    """Also cover SDK envelope headers and non-event items (attachments, logs, etc.)."""
    safe = Envelope()
    for item in envelope.items:
        if item.type not in ('event', 'transaction'):
            continue
        event = sanitize_event(item.payload.json, metadata)
        if event is None:
            continue
        if 'event_id' in event:
            safe.headers['event_id'] = event['event_id']
        if event.get('type') == 'transaction':
            safe.add_transaction(event)
        else:
            safe.add_event(event)
    return safe


class PrivateHttpTransport(HttpTransport):
    def capture_envelope(self, envelope):
        metadata = {key: self.options[key] for key in ('environment', 'release')
                    if self.options.get(key)}
        safe = sanitize_envelope(envelope, metadata)
        if safe.items:
            super().capture_envelope(safe)


def _label(value, fallback):
    return value if isinstance(value, str) and re.fullmatch(r'[\w.@+/-]{1,100}', value) else fallback


def sentry_options(env):
    metadata = {'environment': _label(env.get('SENTRY_ENVIRONMENT'), 'development')}
    release = _label(env.get('SENTRY_RELEASE'), None)
    if release:
        metadata['release'] = release
    try:
        rate = float(env.get('SENTRY_TRACES_SAMPLE_RATE', '0'))
        rate = min(max(rate, 0), 0.05) if math.isfinite(rate) else 0
    except ValueError:
        rate = 0
    return {
        'dsn': env.get('SENTRY_DSN'), **metadata,
        # Do not auto-discover deployment metadata or enable side-channel output
        # from SDK-specific environment variables.
        'release': metadata.get('release', ''), 'debug': False,
        'spotlight': False, 'server_name': '',
        'default_integrations': False, 'auto_enabling_integrations': False,
        'integrations': [DjangoIntegration(transaction_style='function_name',
                                          middleware_spans=False, signals_spans=False)],
        'send_default_pii': False, 'max_request_body_size': 'never',
        'include_local_variables': False, 'include_source_context': False,
        'max_breadcrumbs': 0, 'before_breadcrumb': lambda *args: None,
        'before_send': lambda event, hint: sanitize_event(event, metadata),
        'before_send_transaction': lambda event, hint: sanitize_event(event, metadata),
        'transport': PrivateHttpTransport,
        'auto_session_tracking': False, 'send_client_reports': False,
        'enable_logs': False, 'enable_metrics': False,
        'profiles_sample_rate': 0, 'profile_session_sample_rate': 0,
        'traces_sample_rate': rate, 'trace_lifecycle': 'static',
        'trace_propagation_targets': [], 'propagate_traces': False,
    }


def init_sentry():
    # Tests must remain offline even if a developer's .env contains a real DSN.
    if (not os.getenv('SENTRY_DSN', '').strip()
            or os.getenv('SENTRY_DISABLED', '').lower() in {'1', 'true', 'yes'}
            or os.getenv('CI', '').lower() in {'1', 'true', 'yes'}
            or 'test' in sys.argv or 'pytest' in sys.modules):
        return False
    try:
        sentry_sdk.init(**sentry_options(os.environ))
        return True
    except Exception:
        logging.getLogger(__name__).warning('Sentry initialization failed; monitoring is disabled.')
        return False


def capture_unexpected(error, component, status=None):
    if not sentry_sdk.get_client().is_active():
        return
    try:
        with sentry_sdk.new_scope() as scope:
            scope.set_tag('component', component if component in _COMPONENTS else 'backend')
            if type(status) is int and 500 <= status <= 599:
                scope.set_tag('http_status', status)
            sentry_sdk.capture_exception(error)
    except Exception:
        # Observability must never interrupt authentication or runner cleanup.
        pass


class ApiFailureMonitoringMiddleware(MiddlewareMixin):
    """Report explicit service-error responses as well as uncaught exceptions.

    DjangoIntegration reports uncaught exceptions. For handled 5xx responses,
    report only a fixed error category and status, never the response body.
    """

    def process_exception(self, request, exception):
        request._sentry_exception_seen = True

    def process_response(self, request, response):
        if 500 <= response.status_code <= 599 and not getattr(request, '_sentry_exception_seen', False):
            capture_unexpected(RuntimeError('API service failure'), 'api', response.status_code)
        return response


class MonitoredWebSocket:
    """Catch uncaught consumer errors without inspecting scopes or socket messages."""

    def __init__(self, application):
        self.application = application

    async def __call__(self, scope, receive, send):
        with sentry_sdk.isolation_scope():
            try:
                return await self.application(scope, receive, send)
            except Exception as error:
                capture_unexpected(error, 'websocket')
                raise
