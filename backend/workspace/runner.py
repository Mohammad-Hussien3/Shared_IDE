import os
import base64
import shutil
import selectors
import subprocess
import time
import uuid


RUNNER_ENGINE = os.getenv("CODE_RUNNER_ENGINE", "podman")
PYTHON_RUNNER_IMAGE = os.getenv(
    "PYTHON_RUNNER_IMAGE",
    "docker.io/library/python:3.12-alpine",
)
CPP_RUNNER_IMAGE = os.getenv(
    "CPP_RUNNER_IMAGE",
    "docker.io/library/gcc:14",
)
RUNNER_PULL_POLICY = os.getenv("CODE_RUNNER_PULL_POLICY", "never")
MAX_OUTPUT_BYTES = 32 * 1024
RUN_TIMEOUT_SECONDS = 8


class RunnerUnavailable(Exception):
    pass


def run_program(language, source):
    """Execute supported code in a disposable, networkless container."""
    name = f"workspace-run-{uuid.uuid4().hex}"
    if language == "python":
        image = PYTHON_RUNNER_IMAGE
        program = ["python", "-c", source]
        memory = "128m"
    elif language == "cpp":
        image = CPP_RUNNER_IMAGE
        encoded_source = base64.b64encode(source.encode("utf-8")).decode("ascii")
        program = [
            "/bin/sh",
            "-c",
            "printf '%s' " + encoded_source
            + " | base64 -d > /work/main.cpp"
            + " && g++ -std=c++17 -O2 -pipe /work/main.cpp -o /work/main"
            + " && /work/main",
        ]
        memory = "256m"
    else:
        raise RunnerUnavailable(f"No isolated runner is configured for {language}.")

    _ensure_image_available(image)

    command = [
        RUNNER_ENGINE,
        "run",
        "--rm",
        f"--pull={RUNNER_PULL_POLICY}",
        f"--name={name}",
        "--network=none",
        "--read-only",
        "--cap-drop=all",
        "--security-opt=no-new-privileges",
        "--user=65534:65534",
        f"--memory={memory}",
        f"--memory-swap={memory}",
        "--cpus=0.5",
        "--pids-limit=32",
        "--ulimit=cpu=5:5",
        "--ulimit=fsize=1048576:1048576",
        "--ulimit=nofile=64:64",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--tmpfs=/work:rw,nosuid,nodev,size=16m,exec",
        "--workdir=/tmp",
        "--env=HOME=/tmp",
        "--env=PYTHONDONTWRITEBYTECODE=1",
        image,
        *program,
    ]

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as exc:
        raise RunnerUnavailable(f"Could not start the isolated runner: {exc}") from exc

    output = {"stdout": bytearray(), "stderr": bytearray()}
    output_bytes = 0
    output_limited = False
    timed_out = False
    deadline = time.monotonic() + RUN_TIMEOUT_SECONDS

    with selectors.DefaultSelector() as selector:
        for label, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, label)

        while selector.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = process.poll() is None
                break

            ready = selector.select(min(remaining, 0.1)) if selector.get_map() else []
            for key, _ in ready:
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue

                available = MAX_OUTPUT_BYTES - output_bytes
                if available > 0:
                    output[key.data].extend(chunk[:available])
                    output_bytes += min(len(chunk), available)
                if len(chunk) > available:
                    output_limited = True
                    break

            if output_limited:
                break

    if timed_out or output_limited:
        try:
            subprocess.run(
                [RUNNER_ENGINE, "kill", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()

    result = {
        "stdout": output["stdout"].decode("utf-8", errors="replace"),
        "stderr": output["stderr"].decode("utf-8", errors="replace"),
        "exit_code": process.returncode,
        "timed_out": timed_out,
        "output_limited": output_limited,
    }

    if process.returncode == 125 and not timed_out and not output_limited:
        detail = result["stderr"].strip() or "The container runtime could not start."
        if "image not known" in detail.lower() or "no such image" in detail.lower():
            detail = (
                f"Runner image {image} is not installed. Pull it with: "
                f"{RUNNER_ENGINE} pull {image}"
            )
        raise RunnerUnavailable(f"Isolated runner unavailable: {detail}")
    if timed_out:
        result["stderr"] = (result["stderr"] + "\nExecution timed out.").strip()
    if output_limited:
        result["stderr"] = (result["stderr"] + "\nOutput limit reached.").strip()
    return result


def run_python(source):
    """Backward-compatible Python runner entry point."""
    return run_program("python", source)


def _ensure_image_available(image):
    """Check the image in the calling backend user's Podman store, without pulling."""
    if not shutil.which(RUNNER_ENGINE):
        raise RunnerUnavailable(
            f"Container runtime '{RUNNER_ENGINE}' is not installed or not on the "
            "Django process PATH. Install Podman and restart Django."
        )

    try:
        available = subprocess.run(
            [RUNNER_ENGINE, "image", "exists", image],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
            text=True,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RunnerUnavailable(
            f"Could not query {RUNNER_ENGINE} as Django uid {os.geteuid()}: {exc}"
        ) from exc

    if available.returncode == 0:
        return

    try:
        info = subprocess.run(
            [RUNNER_ENGINE, "info", "--format", "{{.Store.GraphRoot}}"],
            capture_output=True,
            timeout=5,
            check=False,
            text=True,
        )
        graph_root = info.stdout.strip() if info.returncode == 0 else "unknown"
        runtime_error = info.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        graph_root = "unknown"
        runtime_error = str(exc)

    if available.returncode == 1:
        raise RunnerUnavailable(
            f"Runner image {image} is missing from the Podman image store used by "
            f"Django (uid {os.geteuid()}, store {graph_root}). Pull it as the same "
            f"user that runs Django: {RUNNER_ENGINE} pull {image}."
        )

    detail = available.stderr.strip() or runtime_error or "No runtime details available."
    raise RunnerUnavailable(
        f"Could not access Podman as Django uid {os.geteuid()} "
        f"(image store {graph_root}): {detail}"
    )
