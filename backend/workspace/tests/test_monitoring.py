import asyncio
import json
from unittest.mock import AsyncMock, Mock, patch

from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, override_settings
from django.urls import path
import sentry_sdk
from sentry_sdk.envelope import Envelope, Item, PayloadRef
from sentry_sdk.transport import HttpTransport

from Shared_IDE.monitoring import (
    ApiFailureMonitoringMiddleware, MonitoredWebSocket, capture_unexpected,
    init_sentry, sanitize_envelope, sanitize_event, sentry_options,
)
from workspace.consumers import TerminalConsumer
from workspace.runner import RunnerUnavailable


SECRET = 'PRIVATE-JWT-password-source-stdin-stdout-OAuth-verification-token'
METADATA = {'environment': 'test-monitoring', 'release': 'shared-ide@abc123'}


def crash(request):
    raise RuntimeError(SECRET)


urlpatterns = [path('crash/', crash)]


def dirty_event():
    return {
        'event_id': 'a' * 32, 'timestamp': 1234.5,
        'exception': {'values': [{'type': 'RuntimeError', 'value': SECRET, 'module': SECRET,
            'stacktrace': {'frames': [{
                'filename': 'workspace/consumers.py', 'lineno': 57,
                'function': SECRET, 'vars': {'password': SECRET}, 'context_line': SECRET,
                'pre_context': [SECRET], 'post_context': [SECRET], 'abs_path': SECRET,
            }, {'filename': SECRET, 'lineno': 1}]}}]},
        'request': {'headers': {'Authorization': SECRET}, 'cookies': SECRET, 'data': SECRET, 'url': SECRET},
        'user': {'email': SECRET, 'ip_address': SECRET},
        'breadcrumbs': [{'message': SECRET}], 'extra': {'terminal': SECRET},
        'contexts': {'oauth': SECRET}, 'transaction': SECRET, 'logentry': {'message': SECRET},
        'server_name': SECRET, 'tags': {'component': 'runner', 'filename': SECRET},
        'release': SECRET, 'environment': SECRET,
    }


class MonitoringPrivacyTests(SimpleTestCase):
    def test_error_allowlist_removes_private_values_and_keeps_stack_location(self):
        clean = sanitize_event(dirty_event(), METADATA)
        self.assertNotIn(SECRET, json.dumps(clean))
        self.assertEqual(clean['exception']['values'][0]['stacktrace']['frames'], [
            {'filename': 'workspace/consumers.py', 'lineno': 57, 'in_app': True},
        ])
        self.assertEqual(clean['tags'], {'component': 'runner'})
        self.assertEqual(clean['release'], METADATA['release'])
        self.assertEqual(sanitize_event(clean, METADATA), clean)

    def test_unknown_exception_types_messages_and_filenames_are_not_forwarded(self):
        event = dirty_event()
        event['exception']['values'][0]['type'] = SECRET
        clean = sanitize_event(event, METADATA)
        self.assertEqual(clean['exception']['values'][0]['type'], 'Exception')
        self.assertIsNone(sanitize_event({'message': SECRET}, METADATA))

    def test_transactions_contain_only_root_timing_and_trace_ids(self):
        event = {**dirty_event(), 'type': 'transaction', 'start_timestamp': 1230,
                 'spans': [{'description': SECRET}],
                 'contexts': {'trace': {'trace_id': 'b' * 32, 'span_id': 'c' * 16, 'data': SECRET}}}
        clean = sanitize_event(event, METADATA)
        self.assertNotIn(SECRET, json.dumps(clean))
        self.assertEqual(clean['transaction'], 'HTTP request')
        self.assertEqual(clean['spans'], [])
        self.assertEqual(clean['start_timestamp'], 1230)
        self.assertNotIn('exception', clean)

    def test_final_envelope_drops_headers_attachments_sessions_profiles_and_logs(self):
        envelope = Envelope(headers={'trace': {'transaction': SECRET}, 'sdk': SECRET})
        envelope.add_event(dirty_event())
        for kind in ('attachment', 'session', 'profile', 'log', 'span', 'replay_event', 'client_report'):
            envelope.add_item(Item(payload=PayloadRef(json={'private': SECRET}), type=kind, filename=SECRET))
        clean = sanitize_envelope(envelope, METADATA)
        self.assertNotIn(SECRET.encode(), clean.serialize())
        self.assertEqual(clean.headers, {'event_id': 'a' * 32})
        self.assertEqual([item.type for item in clean.items], ['event'])

    @patch('Shared_IDE.monitoring.sentry_sdk.init')
    def test_disabled_without_dsn_and_in_tests_or_ci_even_with_dsn(self, initialize):
        for env, argv in [({}, ['server']), ({'SENTRY_DSN': 'https://public@example.invalid/1', 'CI': 'true'}, ['server']),
                          ({'SENTRY_DSN': 'https://public@example.invalid/1'}, ['manage.py', 'test']),
                          ({'SENTRY_DSN': 'https://public@example.invalid/1', 'SENTRY_DISABLED': 'true'}, ['server'])]:
            with self.subTest(env=env, argv=argv), patch.dict('os.environ', env, clear=True), patch('sys.argv', argv):
                self.assertFalse(init_sentry())
        initialize.assert_not_called()

    def test_conservative_configuration_and_deployment_labels(self):
        for raw, expected in [('1', .05), ('0.01', .01), ('-1', 0), ('NaN', 0), ('broken', 0)]:
            options = sentry_options({'SENTRY_TRACES_SAMPLE_RATE': raw, 'SENTRY_RELEASE': 'abc123'})
            self.assertEqual(options['traces_sample_rate'], expected)
            self.assertEqual(options['release'], 'abc123')
        self.assertFalse(options['send_default_pii'])
        self.assertFalse(options['include_local_variables'])
        self.assertFalse(options['include_source_context'])
        self.assertFalse(options['default_integrations'])
        self.assertFalse(options['enable_logs'])
        self.assertFalse(options['enable_metrics'])
        self.assertFalse(options['debug'])
        self.assertFalse(options['spotlight'])
        self.assertEqual(sentry_options({})['release'], '')
        self.assertEqual(options['max_request_body_size'], 'never')
        self.assertEqual(options['trace_propagation_targets'], [])
        self.assertIsNone(options['before_breadcrumb']({'message': SECRET}))

    @patch('Shared_IDE.monitoring.sentry_sdk.init', side_effect=ValueError(SECRET))
    def test_invalid_configuration_does_not_break_startup_or_log_secrets(self, initialize):
        with patch.dict('os.environ', {'SENTRY_DSN': 'invalid'}, clear=True), patch('sys.argv', ['server']):
            with self.assertLogs('Shared_IDE.monitoring', 'WARNING') as logs:
                self.assertFalse(init_sentry())
        self.assertNotIn(SECRET, str(logs.output))

    @override_settings(ROOT_URLCONF=__name__, ALLOWED_HOSTS=['testserver'])
    def test_real_django_sdk_and_final_transport_exclude_request_and_exception_secrets(self):
        envelopes = []
        options = sentry_options({'SENTRY_DSN': 'https://public@example.invalid/1', 'SENTRY_ENVIRONMENT': 'test-monitoring'})
        with patch.object(HttpTransport, 'capture_envelope', lambda _, envelope: envelopes.append(envelope)):
            with sentry_sdk.isolation_scope(), sentry_sdk.new_scope() as scope:
                client = sentry_sdk.Client(**options)
                scope.set_client(client)
                try:
                    self.client.raise_request_exception = False
                    response = self.client.post('/crash/?token=' + SECRET, {'content': SECRET, 'password': SECRET},
                                                HTTP_AUTHORIZATION=SECRET, HTTP_COOKIE=SECRET)
                    self.assertEqual(response.status_code, 500)
                    capture_unexpected(RunnerUnavailable(SECRET), 'runner')
                    client.flush()
                finally:
                    client.close()
        self.assertEqual(len(envelopes), 2)
        self.assertNotIn(SECRET.encode(), b''.join(item.serialize() for item in envelopes))
        self.assertEqual(envelopes[1].items[0].payload.json['tags']['component'], 'runner')

    @patch('Shared_IDE.monitoring.capture_unexpected')
    def test_handled_5xx_reported_but_client_errors_and_already_captured_exceptions_are_not(self, capture):
        middleware = ApiFailureMonitoringMiddleware(lambda request: HttpResponse())
        for status in (200, 400, 401, 403, 404, 422, 429):
            middleware.process_response(RequestFactory().get('/'), HttpResponse(status=status))
        capture.assert_not_called()
        response = HttpResponse(SECRET, status=503)
        self.assertIs(middleware.process_response(RequestFactory().get('/'), response), response)
        self.assertEqual(capture.call_args.args[1:], ('api', 503))
        self.assertNotIn(SECRET, str(capture.call_args))
        request = RequestFactory().get('/')
        middleware.process_exception(request, RuntimeError(SECRET))
        middleware.process_response(request, HttpResponse(status=500))
        self.assertEqual(capture.call_count, 1)

    def test_real_sdk_performance_envelopes_remove_child_spans_and_private_names(self):
        envelopes = []
        options = sentry_options({'SENTRY_DSN': 'https://public@example.invalid/1'})
        options.update(integrations=[], traces_sample_rate=1)
        with patch.object(HttpTransport, 'capture_envelope', lambda _, envelope: envelopes.append(envelope)):
            with sentry_sdk.isolation_scope(), sentry_sdk.new_scope() as scope:
                client = sentry_sdk.Client(**options)
                scope.set_client(client)
                try:
                    with sentry_sdk.start_transaction(name=SECRET, op='http.server'):
                        with sentry_sdk.start_span(op='db', description=SECRET) as span:
                            span.set_data('source', SECRET)
                    client.flush()
                finally:
                    client.close()
        self.assertEqual(len(envelopes), 1)
        self.assertEqual(envelopes[0].items[0].type, 'transaction')
        self.assertEqual(envelopes[0].items[0].payload.json['spans'], [])
        self.assertNotIn(SECRET.encode(), envelopes[0].serialize())

    @patch('Shared_IDE.monitoring.capture_unexpected')
    async def test_websocket_wrapper_preserves_messages_and_reraises_unexpected_errors(self, capture):
        async def app(scope, receive, send):
            await send(await receive())
            raise RuntimeError(SECRET)
        receive, send = AsyncMock(return_value={'text': SECRET}), AsyncMock()
        with self.assertRaises(RuntimeError):
            await MonitoredWebSocket(app)({'token': SECRET}, receive, send)
        send.assert_awaited_once_with({'text': SECRET})
        self.assertEqual(capture.call_args.args[1], 'websocket')

    @patch('Shared_IDE.monitoring.capture_unexpected')
    async def test_websocket_cancellation_is_not_an_error(self, capture):
        with self.assertRaises(asyncio.CancelledError):
            await MonitoredWebSocket(AsyncMock(side_effect=asyncio.CancelledError))({}, AsyncMock(), AsyncMock())
        capture.assert_not_called()

    @patch('workspace.consumers.capture_unexpected')
    async def test_user_program_rejections_do_not_report_but_runner_failures_do(self, capture):
        for runner, error, component in [(None, RunnerUnavailable('Unsupported language'), None),
                                         (Mock(stop=AsyncMock()), RunnerUnavailable(SECRET), 'runner'),
                                         (None, RuntimeError(SECRET), 'websocket'),
                                         (None, asyncio.TimeoutError(), None)]:
            consumer = TerminalConsumer()
            consumer.runner = runner
            consumer.disconnected = False
            consumer._execute_saved_file = AsyncMock(side_effect=error)
            consumer._send = AsyncMock()
            consumer.close = AsyncMock()
            capture.reset_mock()
            with patch('workspace.consumers.logger'):
                await consumer._run_session()
            if component:
                capture.assert_called_once_with(error, component)
            else:
                capture.assert_not_called()
            consumer.close.assert_awaited_once()
            if runner:
                runner.stop.assert_awaited_once()

    @patch('workspace.consumers.capture_unexpected')
    async def test_background_runner_cleanup_failures_are_reported_and_reraised(self, capture):
        error = OSError(SECRET)
        consumer = TerminalConsumer()
        consumer.runner = Mock(stop=AsyncMock(side_effect=error))
        consumer.disconnected = False
        consumer._execute_saved_file = AsyncMock()
        consumer.close = AsyncMock()
        with self.assertRaises(OSError):
            await consumer._run_session()
        capture.assert_called_once_with(error, 'runner')
