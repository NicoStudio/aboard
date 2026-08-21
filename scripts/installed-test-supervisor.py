#!/usr/bin/env python3

import signal
import subprocess
import sys
import time


def main():
    if len(sys.argv) != 5:
        raise SystemExit(
            "Usage: installed-test-supervisor.py <node> <test-file> <timeout-ms> <grace-ms>"
        )

    node_bin, test_file = sys.argv[1:3]
    timeout_ms = int(sys.argv[3])
    grace_ms = int(sys.argv[4])
    if timeout_ms <= 0 or grace_ms <= 0:
        raise SystemExit("Installed-test timeouts must be positive")

    pending_signal_status = 0

    def remember_signal(signum, _frame):
        nonlocal pending_signal_status
        if not pending_signal_status:
            pending_signal_status = 128 + signum

    signal.signal(signal.SIGINT, remember_signal)
    signal.signal(signal.SIGTERM, remember_signal)
    if pending_signal_status:
        return pending_signal_status

    try:
        child = subprocess.Popen([node_bin, test_file])
    except OSError as error:
        print(f"Could not start installed Aboard test: {error}", file=sys.stderr)
        return 1

    timeout_deadline = time.monotonic() + timeout_ms / 1000
    stop_deadline = None
    timed_out = False
    return_code = None

    while return_code is None:
        return_code = child.poll()
        if return_code is not None:
            break

        now = time.monotonic()
        if stop_deadline is None and (pending_signal_status or now >= timeout_deadline):
            if not pending_signal_status:
                timed_out = True
                print(f"Installed Aboard test timed out: {test_file}", file=sys.stderr)
            try:
                child.terminate()
            except ProcessLookupError:
                pass
            stop_deadline = now + grace_ms / 1000
        elif stop_deadline is not None and now >= stop_deadline:
            # This process is the test's sole parent and has not reaped it
            # since the poll above. If it exited in this interval it remains a
            # zombie, so this PID cannot have been reused by an unrelated job.
            try:
                child.kill()
            except ProcessLookupError:
                pass
            return_code = child.wait()
            break

        time.sleep(0.02)

    if pending_signal_status:
        return pending_signal_status
    if timed_out:
        return 124
    if return_code is None:
        return 1
    return return_code if return_code >= 0 else 128 - return_code


if __name__ == "__main__":
    raise SystemExit(main())
