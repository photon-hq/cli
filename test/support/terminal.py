"""Run a command with standard output and standard error each on its own
pseudo-terminal, or on a pipe, and print what each received as JSON.

Usage: python3 terminal.py '{"command": [...], "env": {...}, "stdout": "terminal",
"stderr": "pipe"}'
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
    exited_at = None
    while sources:
        if process.poll() is not None and exited_at is None:
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
    process.wait()
    os.close(stdin_master)
    print(
        json.dumps(
            {
                "exitCode": process.returncode,
                "stderr": output["stderr"].decode().replace("\r\n", "\n"),
                "stdout": output["stdout"].decode().replace("\r\n", "\n"),
            }
        )
    )


main()
