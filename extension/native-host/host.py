#!/usr/bin/env python3
"""Native messaging helper for the Pagecrawl cookies extension.

Brave starts this per message. It reads one JSON request from stdin, writes the ticked
cookies to a local folder (action "save"), and for action "send" also copies the file into
the pagecrawl service's cookie folder over SSH. Settings live in config.json next to this file.
"""
import json
import os
import re
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def log(text):
    # host.log is gitignored. It records what happened, never cookie values.
    with open(os.path.join(HERE, "host.log"), "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}\n")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    return json.loads(sys.stdin.buffer.read(struct.unpack("<I", raw)[0]))


def reply(ok, message):
    log(f"reply ok={ok} {message!r}")
    data = json.dumps({"ok": ok, "message": message}).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def main():
    log(f"start pid={os.getpid()} python={sys.executable}")
    req = read_message()
    log(f"request action={req.get('action')} name={req.get('name')} cookies={len(req.get('cookies') or [])}")
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    name = str(req.get("name", ""))
    cookies = req.get("cookies")
    if not re.fullmatch(r"[\w.+-]{1,80}", name) or name.startswith("."):
        return reply(False, "Bad file name.")
    if not isinstance(cookies, list) or not cookies:
        return reply(False, "No cookies ticked.")

    body = json.dumps(cookies, indent=2)
    if req.get("action") == "send":
        return send(cfg, name, body, len(cookies))

    folder = os.path.expanduser(cfg["folder"])
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{name}.json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    reply(True, f"Saved {len(cookies)} cookies to {path}.")


def send(cfg, name, body, count):
    """Pipes the cookies straight to the service's folder over SSH. Nothing is kept on this Mac."""
    remote = f"{cfg['remote_dir']}/{name}.json"
    # Written under a .tmp name and renamed, so the service never reads a half-written file.
    # The service runs as another user, so the file must be world-readable on the server.
    cmd = (f"mkdir -p '{cfg['remote_dir']}' && cat > '{remote}.tmp' && chmod 644 '{remote}.tmp'"
           f" && mv -f '{remote}.tmp' '{remote}'")
    try:
        r = subprocess.run(
            ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", cfg["ssh_host"], cmd],
            input=body, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return reply(False, "SSH timed out. Is SSH reachable on the server?")
    if r.returncode != 0:
        return reply(False, f"SSH failed ({r.returncode}): {r.stderr.strip() or 'no output'}")
    reply(True, f"Sent {count} cookies to {cfg['ssh_host']}:{remote}. The service picks them up on its next read.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # always answer, or Brave reports a bare disconnect
        reply(False, f"Helper error: {e}")
