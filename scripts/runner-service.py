#!/usr/bin/env python3
"""Install/manage the unprivileged worker; never read or print application secrets."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / '.runtime' / 'runner'
UNIT = 'shared-ide-runner-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12] + '.service'
sys.path.insert(0, str(ROOT / 'backend'))


def run(*args):
    subprocess.run(args, check=True, cwd=ROOT)


def prepare():
    if os.geteuid() == 0:
        raise SystemExit('Run worker setup as an unprivileged Linux user, not sudo/root.')
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    DIRECTORY.chmod(0o750)
    token = DIRECTORY / 'token'
    if not token.exists():
        fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        with os.fdopen(fd, 'w') as stream:
            stream.write(secrets.token_urlsafe(48))
    token.chmod(0o640)


def setup():
    prepare()
    if any(char in str(ROOT) for char in '\n\r%"\\'):
        raise SystemExit('Use a checkout path without systemd escape characters.')
    unit_dir = Path.home() / '.config/systemd/user'
    unit_dir.mkdir(parents=True, exist_ok=True)
    (unit_dir / UNIT).write_text(f'''[Unit]
Description=Shared IDE restricted rootless execution worker
StartLimitIntervalSec=120
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory={ROOT}/backend
ExecStart="{sys.executable}" -m workspace.execution_worker --directory "{DIRECTORY}"
Environment=CODE_EXECUTION_ENABLED=true CODE_RUNNER_TRANSPORT=local CODE_RUNNER_ENGINE=podman CODE_RUNNER_PULL_POLICY=never
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
UMask=0027
Delegate=yes
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=25

[Install]
WantedBy=default.target
''')
    run('systemctl', '--user', 'daemon-reload')
    print(f'Installed {UNIT}. Set RUNNER_GID={os.getgid()} in root .env.')
    print('Run make runner-images, make runner-check, then enable CODE_EXECUTION_ENABLED=true in root .env.')


def health():
    os.environ.update(CODE_EXECUTION_ENABLED='true', CODE_WORKER_DIRECTORY=str(DIRECTORY))
    from workspace.worker_client import request
    result = asyncio.run(request({'type': 'health'}))
    if result.get('type') != 'healthy':
        raise RuntimeError('Worker health check failed')
    return result


def start():
    # An inactive unit may already have been unloaded; only restart is required
    # to succeed. Reset a previous preflight/start-limit failure when present.
    subprocess.run(['systemctl', '--user', 'reset-failed', UNIT],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    run('systemctl', '--user', 'restart', UNIT)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            print('Worker healthy:', health())
            return
        except Exception:
            time.sleep(0.25)
    raise SystemExit('Worker not ready. Run make runner-check and make runner-status. Execution remains unavailable.')


def main():
    command = sys.argv[1] if len(sys.argv) == 2 else ''
    if command == 'setup':
        setup()
    elif command == 'start-if-enabled':
        # Parse in memory; never echo Compose configuration (it includes secrets).
        config = json.loads(subprocess.check_output(['docker', 'compose', 'config', '--format', 'json'], cwd=ROOT))
        backend = config['services']['backend']
        enabled = str(backend['environment']['CODE_EXECUTION_ENABLED']).lower() in {'1', 'true', 'yes', 'on'}
        if enabled:
            prepare()
            if str(os.getgid()) not in [str(group) for group in backend.get('group_add', [])]:
                raise SystemExit(f'Set RUNNER_GID={os.getgid()} in root .env, then run make runner-setup.')
            start()
        else:
            DIRECTORY.mkdir(parents=True, exist_ok=True)
    elif command == 'start':
        start()
    elif command == 'stop':
        if (Path.home() / '.config/systemd/user' / UNIT).exists():
            run('systemctl', '--user', 'stop', UNIT)
    elif command == 'enable':
        run('systemctl', '--user', 'enable', UNIT)
    elif command == 'status':
        run('systemctl', '--user', '--no-pager', 'status', UNIT)
        print(health())
    elif command == 'check':
        os.environ.update(CODE_EXECUTION_ENABLED='true', CODE_RUNNER_TRANSPORT='local')
        from workspace.execution_worker import preflight
        preflight()
        print('Rootless sandbox checks passed for Python, C and C++.')
    else:
        raise SystemExit('Usage: runner-service.py setup|start-if-enabled|start|stop|enable|status|check')


if __name__ == '__main__':
    main()
