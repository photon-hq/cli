"""Run a command with standard output and standard error each on its own
pseudo-terminal, or on a pipe, and print what each received as JSON.

Usage: python3 terminal.py '{"command": [...], "env": {...}, "stdout": "terminal",
"stderr": "pipe"}'

Optional: "answer": {"after": "...", "send": "..."} types "send" on the
standard input terminal once standard output or error has shown "after", and
"timeoutSeconds" kills a command still running after that long ("timedOut").
"""

import json
import os
import pty
import select
import subprocess
import sys
import time

QUIET_AFTER_EXIT_SECONDS = 0.5


def main():
    spec = json.loads(sys.argv[1])
    stdin_master, stdin_slave = pty.openpty()
    sources = {}
    handles = {}
    slaves = [stdin_slave]
    for name in ("stdout", "stderr"):
        if spec.get(name, "terminal") == "terminal":
            master, slave = pty.openpty()
            sources[master] = name
            handles[name] = slave
            slaves.append(slave)
        else:
            handles[name] = subprocess.PIPE
    process = subprocess.Popen(
        spec["command"],
        cwd=spec.get("cwd"),
        env=spec["env"],
        stdin=stdin_slave,
        stdout=handles["stdout"],
        stderr=handles["stderr"],
    )
    for slave in slaves:
        os.close(slave)
    for name in ("stdout", "stderr"):
        stream = getattr(process, name)
        if stream is not None:
            sources[stream.fileno()] = name
    output = {"stdout": b"", "stderr": b""}
    answer = spec.get("answer")
    timeout = spec.get("timeoutSeconds")
    started_at = time.monotonic()
    exited_at = None
    timed_out = False
    while sources or process.poll() is None:
        if process.poll() is not None and exited_at is None:
            exited_at = time.monotonic()
        if exited_at is None and timeout is not None and time.monotonic() - started_at > timeout:
            process.kill()
            timed_out = True
            exited_at = time.monotonic()
        if exited_at is not None and time.monotonic() - exited_at > QUIET_AFTER_EXIT_SECONDS:
            break
        ready, _, _ = select.select(list(sources), [], [], 0.1)
        for descriptor in ready:
            try:
                chunk = os.read(descriptor, 65536)
            except OSError:
                chunk = b""
            if chunk:
                output[sources[descriptor]] += chunk
            else:
                del sources[descriptor]
        if answer is not None and any(
            answer["after"].encode() in shown for shown in output.values()
        ):
            os.write(stdin_master, answer["send"].encode())
            answer = None
    process.wait()
    os.close(stdin_master)
    print(
        json.dumps(
            {
                "exitCode": process.returncode,
                "stderr": output["stderr"].decode().replace("\r\n", "\n"),
                "stdout": output["stdout"].decode().replace("\r\n", "\n"),
                "timedOut": timed_out,
            }
        )
    )


main()
