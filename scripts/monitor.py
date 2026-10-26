#!/usr/bin/env python3
"""Perform real HTTP checks and persist observed status/history; no synthetic data."""
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "monitors.json"
PRIVATE_CONFIG = ROOT / "config" / "monitors.private.json"
STATUS = ROOT / "data" / "status.json"
HISTORY = ROOT / "data" / "history.json"
PRIVATE_STATUS = ROOT / "data" / "status-private.json"
UA = "AirlinyStatusMonitor/1.0 (+GitHub Actions; real HTTP health checks)"

# Probes run on the cron interval (5 min). Data files are only rewritten when a
# monitor changes state, or when this many minutes have passed since the last
# flush. That keeps commits at ~48/day instead of ~288/day without losing
# fast failure detection.
FLUSH_MINUTES = int(os.environ.get("FLUSH_INTERVAL_MINUTES", "30"))
PBKDF2_ITERATIONS = 210000


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def b64e(raw):
    return base64.b64encode(raw).decode("ascii")


def b64d(text):
    return base64.b64decode(text)


def aesgcm_class():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        raise SystemExit("cryptography is required when private monitors are configured: pip install cryptography")
    return AESGCM


def derive_key(password, salt, iterations):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations), 32)


def encrypt_payload(payload, password):
    AESGCM = aesgcm_class()
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = derive_key(password, salt, PBKDF2_ITERATIONS)
    sealed = AESGCM(key).encrypt(nonce, json.dumps(payload, ensure_ascii=False).encode("utf-8"), None)
    return {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "cipher": "AES-256-GCM",
        "iterations": PBKDF2_ITERATIONS,
        "salt": b64e(salt),
        "nonce": b64e(nonce),
        "data": b64e(sealed),
    }


def decrypt_payload(blob, password):
    AESGCM = aesgcm_class()
    key = derive_key(password, b64d(blob["salt"]), blob.get("iterations", PBKDF2_ITERATIONS))
    plain = AESGCM(key).decrypt(b64d(blob["nonce"]), b64d(blob["data"]), None)
    return json.loads(plain.decode("utf-8"))


def load_monitors(path):
    monitors = read_json(path, [])
    if not isinstance(monitors, list):
        raise SystemExit(f"{path.name} must contain a JSON array")
    return [m for m in monitors if isinstance(m, dict)]


def load_private_monitors():
    raw = os.environ.get("PRIVATE_MONITORS", "").strip()
    if raw:
        try:
            monitors = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"PRIVATE_MONITORS Secret is not valid JSON: {exc}")
        if not isinstance(monitors, list):
            raise SystemExit("PRIVATE_MONITORS Secret must contain a JSON array")
        return [m for m in monitors if isinstance(m, dict)]
    if PRIVATE_CONFIG.exists():
        return load_monitors(PRIVATE_CONFIG)
    return []


def redact(text, url):
    if not text:
        return text
    host = urllib.parse.urlsplit(url).hostname
    return text.replace(host, "[redacted]") if host else text


def check(monitor):
    url = monitor["url"]
    timeout = max(1, min(int(monitor.get("timeout_seconds", 15)), 60))
    expected = set(int(x) for x in monitor.get("expected_status", [200]))
    started = time.perf_counter()
    status = None
    error = None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"}, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                status = response.status
                response.read(1024)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.read(1024)
        ok = status in expected
    except Exception as exc:
        ok = False
        error = type(exc).__name__ + (": " + str(exc)[:180] if str(exc) else "")
    return {"ok": bool(ok), "http_status": status, "response_ms": round((time.perf_counter() - started) * 1000), "error": error}


def probe(monitors, old_by_id, events, timestamp, mask_errors):
    """Check every monitor, appending state-change events. Returns (items, change_count)."""
    items = []
    changes = 0
    for monitor in monitors:
        for required in ("id", "name", "url"):
            if not monitor.get(required):
                raise SystemExit(f"monitor entry missing {required}: {monitor!r}")
        result = check(monitor)
        if mask_errors and result.get("error"):
            result["error"] = redact(result["error"], monitor["url"])
        item = {**monitor, **result, "last_check": timestamp}
        items.append(item)
        previous = old_by_id.get(monitor["id"])
        if previous and previous.get("last_check") and previous.get("ok") != item["ok"]:
            events.insert(0, {
                "at": timestamp,
                "monitor_id": monitor["id"],
                "name": monitor["name"],
                "type": "recovered" if item["ok"] else "down",
                "http_status": item["http_status"],
                "error": item["error"],
            })
            changes += 1
    return items, changes


def should_flush(last_generated, state_changes, now):
    """Decide whether this run should rewrite the data files."""
    force = "--force" in sys.argv or os.environ.get("FORCE_FLUSH") == "1"
    if force:
        return True, "forced"
    if state_changes:
        return True, f"{state_changes} state change(s)"
    if not last_generated:
        return True, "first run"
    try:
        previous = datetime.fromisoformat(str(last_generated).replace("Z", "+00:00"))
    except ValueError:
        return True, "unreadable generated_at"
    if previous.tzinfo is None:
        previous = previous.replace(tzinfo=timezone.utc)
    elapsed = now - previous
    if elapsed >= timedelta(minutes=FLUSH_MINUTES):
        return True, f"{FLUSH_MINUTES}m flush window elapsed"
    return False, f"last flush {int(elapsed.total_seconds() // 60)}m ago"


def accumulate_history(history, items, now):
    history.setdefault("monitors", {})
    today = now.date().isoformat()
    cutoff = (now.date() - timedelta(days=89)).isoformat()
    for item in items:
        records = history["monitors"].setdefault(item["id"], [])
        if not records or records[-1].get("date") != today:
            records.append({"date": today, "up": 0, "total": 0})
        day = records[-1]
        day["total"] = int(day.get("total", 0)) + 1
        if item["ok"]:
            day["up"] = int(day.get("up", 0)) + 1
        history["monitors"][item["id"]] = [r for r in records if r.get("date", "") >= cutoff]


def main():
    public = load_monitors(CONFIG)
    private = load_private_monitors()
    password = os.environ.get("PRIVATE_PASSWORD", "").strip()
    if private and not password:
        raise SystemExit("PRIVATE_MONITORS is configured but PRIVATE_PASSWORD is missing")

    old_status = read_json(STATUS, {"monitors": [], "events": []})
    old_by_id = {m.get("id"): m for m in old_status.get("monitors", [])}
    events = old_status.get("events", [])

    now = datetime.now(timezone.utc).replace(microsecond=0)
    timestamp = now.isoformat().replace("+00:00", "Z")

    current, public_changes = probe(public, old_by_id, events, timestamp, mask_errors=False)

    private_current = []
    private_events = []
    private_changes = 0
    if private:
        previous_blob = read_json(PRIVATE_STATUS, None)
        previous_payload = {}
        if previous_blob:
            try:
                previous_payload = decrypt_payload(previous_blob, password)
            except Exception:
                print("warning: existing private status could not be decrypted; rebuilding baseline")
        private_events = previous_payload.get("events", [])
        private_old = {m.get("id"): m for m in previous_payload.get("monitors", [])}
        private_current, private_changes = probe(private, private_old, private_events, timestamp, mask_errors=True)

    flush, reason = should_flush(old_status.get("generated_at"), public_changes + private_changes, now)
    if not flush:
        failed = [m["id"] for m in current + private_current if not m["ok"]]
        print(f"checked {len(current)} public + {len(private_current)} private monitor(s); unchanged since {reason}; data files untouched")
        if failed:
            print(f"note: {', '.join(failed)} reported failure but status did not change")
        return

    history = read_json(HISTORY, {"monitors": {}})
    accumulate_history(history, current, now)
    write_json(HISTORY, history)
    write_json(STATUS, {"generated_at": timestamp, "monitors": current, "events": events[:100]})

    if private:
        write_json(PRIVATE_STATUS, encrypt_payload({
            "generated_at": timestamp,
            "count": len(private_current),
            "monitors": private_current,
            "events": private_events[:100],
        }, password))

    print(f"data written ({reason}); {len(current)} public, {len(private_current)} private")
    if private_changes:
        print(f"private monitors changed state {private_changes} time(s)")


if __name__ == "__main__":
    main()
