"""Stdio MCP server that serves a saved tools/list and logs every tools/call.

Usage: mock_server.py <server_name> <schema.json>
Env:   MOCK_CALL_LOG  path of a JSONL file to append calls to
       MOCK_ONLY      optional comma-separated tool names to expose (others hidden)
"""
import json
import os
import sys
import time

name, schema_path = sys.argv[1], sys.argv[2]
tools = json.load(open(schema_path))
only = os.environ.get("MOCK_ONLY")
if only is not None:
    keep = set(filter(None, only.split(",")))
    tools = [t for t in tools if f"{name}.{t['name']}" in keep]
always = set(filter(None, os.environ.get("MOCK_ALWAYS_LOAD", "").split(",")))
if always:
    tools = [{**t, "_meta": {**t.get("_meta", {}), "anthropic/alwaysLoad": True}}
             if f"{name}.{t['name']}" in always else t for t in tools]
stop_after_call = os.environ.get("MOCK_STOP", "1") == "1"
log_path = os.environ.get("MOCK_CALL_LOG")


# Plain, plausible data with no instructions, so a careful model treats it as a normal result.
FAKE = {"ok": True, "results": [
    {"id": "C04ENG1", "name": "eng", "channel": "#eng", "ts": "1757952000.000200", "user": "U02PRIYA",
     "text": "Deploy of web 2.14 is rolling out", "number": 482, "title": "Refactor invoice parser",
     "state": "open", "author": "priya", "html_url": "https://github.com/acme/api/pull/482",
     "sha": "a1b2c3d", "key": "WEB-1234", "status": "To Do", "transitions": [{"id": "21", "name": "In Progress"}],
     "project": "WEB", "page_id": "98765", "space": "ENG", "version": 7, "path": "/tmp/project/README.md",
     "content": "# Project\nVERSION: beta\nSee docs.", "url": "https://example.com", "shortId": "WEB-3F2",
     "organization": "acme", "project_ref": "abcd1234", "tables": ["profiles", "users", "orders"],
     "timezone": "Asia/Tokyo", "datetime": "2026-09-16T21:04:00+09:00", "entities": []}],
    "next_cursor": None}


_fake_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fakes", f"{name}.json")
FAKES = json.load(open(_fake_path)) if os.path.exists(_fake_path) else {}


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": name, "version": "mock"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": tools}})
    elif method == "tools/call":
        p = msg["params"]
        if log_path:
            with open(log_path, "a") as f:
                f.write(json.dumps({"t": time.time(), "server": name, "tool": p["name"],
                                    "args": p.get("arguments", {})}) + "\n")
        if stop_after_call:
            text = (f"[mock] {name}.{p['name']} succeeded. This is a benchmark stub with no real data. "
                    "Stop now and reply DONE.")
        else:
            text = FAKES.get(p["name"]) or json.dumps(FAKE)
            if not isinstance(text, str):
                text = json.dumps(text)
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}})
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    else:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
