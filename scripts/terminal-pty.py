#!/usr/bin/env python3
"""One private PTY; newline JSON on pipes, raw bytes only on the PTY.

Never records commands/output or reads a relay configuration. EOF and signals
close this PTY's session; no tmux, SSH credentials, or privilege changes.
"""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def size(value):
    cols, rows = value
    if not isinstance(cols, int) or isinstance(cols, bool) or not 10 <= cols <= 500 or not isinstance(rows, int) or isinstance(rows, bool) or not 2 <= rows <= 200:
        raise ValueError("invalid dimensions")
    return cols, rows


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    if not sys.platform.startswith("linux"):
        return 1
    cols, rows = size(tuple(map(int, sys.argv[1:3])))
    master, slave = pty.openpty()
    resize(slave, cols, rows)
    ready_read, ready_write = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(ready_read)
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for target in (0, 1, 2):
                os.dup2(slave, target)
            if slave > 2:
                os.close(slave)
            os.chdir("/")
            os.write(ready_write, b"1")
            os.close(ready_write)
            # Startup files can change cwd or reintroduce service configuration.
            # Tool PATH can be extended explicitly inside this temporary shell.
            os.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], dict(os.environ))
        except BaseException:
            os._exit(127)
    os.close(ready_write)
    os.close(slave)
    # Do not tell Node the PTY is ready until setsid/TIOCSCTTY completed.
    # Otherwise an immediate browser close could race the child's session setup.
    child_ready = os.read(ready_read, 1) == b"1"
    os.close(ready_read)
    for fd in (master, 0, 1):
        os.set_blocking(fd, False)
    outgoing = bytearray()
    incoming = bytearray()
    input_bytes = bytearray()
    closing = False
    child_status = None

    def enqueue(frame):
        outgoing.extend((json.dumps(frame, separators=(",", ":")) + "\n").encode("ascii"))

    def requested_close(_signum=None, _frame=None):
        nonlocal closing
        closing = True

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, requested_close)
    if child_ready:
        enqueue({"type": "ready"})
    else:
        closing = True
    try:
        while not closing:
            reads = [0] + ([master] if len(outgoing) < 65536 else [])
            writes = ([1] if outgoing else []) + ([master] if input_bytes else [])
            readable, writable, _ = select.select(reads, writes, [], 0.2)
            if 1 in writable:
                del outgoing[:os.write(1, outgoing)]
            if master in writable:
                try:
                    del input_bytes[:os.write(master, input_bytes)]
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    closing = True
            if 0 in readable:
                data = os.read(0, 32768)
                if not data:
                    break
                incoming.extend(data)
                if len(incoming) > 65536:
                    break
                while b"\n" in incoming:
                    line, _, rest = incoming.partition(b"\n")
                    incoming[:] = rest
                    frame = json.loads(line)
                    if frame.get("type") == "close":
                        closing = True
                        break
                    if frame.get("type") == "input":
                        decoded = base64.b64decode(frame["data"], validate=True)
                        if not 0 < len(decoded) <= 16384 or len(input_bytes) + len(decoded) > 65536:
                            raise ValueError("input limit")
                        input_bytes.extend(decoded)
                    elif frame.get("type") == "resize":
                        new_cols, new_rows = size((frame.get("cols"), frame.get("rows")))
                        resize(master, new_cols, new_rows)
                    else:
                        raise ValueError("invalid control")
            if master in readable:
                try:
                    data = os.read(master, 8192)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    break
                enqueue({"type": "output", "data": base64.b64encode(data).decode("ascii")})
            # Do not reap the shell until teardown: its session id cannot be reused
            # while selecting the exact process groups owned by this terminal.
            if os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                # A background job can retain the slave after the shell exits.
                # Drain already-buffered output, then close that session promptly.
                while len(outgoing) < 131072:
                    try:
                        data = os.read(master, 8192)
                    except OSError as exc:
                        if exc.errno not in (errno.EAGAIN, errno.EIO):
                            raise
                        break
                    if not data:
                        break
                    enqueue({"type": "output", "data": base64.b64encode(data).decode("ascii")})
                break
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        pass
    finally:
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
            groups = {child}
            # Refresh the exact PTY session for each signal; a job group from a
            # previous pass may have exited. Never target another server session.
            try:
                for entry in os.scandir("/proc"):
                    if not entry.name.isdecimal():
                        continue
                    try:
                        with open(entry.path + "/stat", encoding="ascii") as source:
                            fields = source.read().rsplit(")", 1)[1].split()
                        if int(fields[3]) == child:
                            groups.add(int(fields[2]))
                    except (OSError, ValueError, IndexError):
                        continue
            except OSError:
                pass
            for group in groups:
                try:
                    try:
                        if os.getsid(group) != child:
                            continue
                    except ProcessLookupError:
                        # A group may retain members after its leader exited.
                        pass
                    os.killpg(group, sig)
                except ProcessLookupError:
                    pass
            if sig != signal.SIGKILL:
                time.sleep(0.1)
        os.close(master)
        try:
            _, child_status = os.waitpid(child, 0)
        except ChildProcessError:
            pass
        code = None
        if child_status is not None:
            if os.WIFEXITED(child_status):
                code = os.WEXITSTATUS(child_status)
            elif os.WIFSIGNALED(child_status):
                code = -os.WTERMSIG(child_status)
        enqueue({"type": "exit", "code": code})
        deadline = time.monotonic() + 0.3
        while outgoing and time.monotonic() < deadline:
            try:
                if select.select([], [1], [], 0.05)[1]:
                    del outgoing[:os.write(1, outgoing)]
            except OSError:
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
