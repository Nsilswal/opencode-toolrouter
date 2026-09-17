"""Run real opencode against 18 mock MCP servers (296 tools) and a mock model, with and without the plugin.

Records the tools opencode sends in each model request. No model cost; routing uses TYPESAFE_API_KEY.

Usage: python3 bench/opencode_e2e.py [--prompts gh1,mx2,nt1] [--opencode-version 1.18.31]
"""
import argparse
import json
import os
import signal
import socket
import statistics as st
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
MCP = BENCH / "mcp"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def config(port, plugin):
    servers = sorted(p.stem for p in (MCP / "schemas").glob("*.json"))
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "model": "mock/mock-1",
        "small_model": "mock/mock-1",
        "provider": {"mock": {"npm": "@ai-sdk/openai-compatible", "name": "Mock",
                              "options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "mock"},
                              "models": {"mock-1": {"name": "Mock 1", "tool_call": True}}}},
        "mcp": {s: {"type": "local", "enabled": True, "environment": {"MOCK_STOP": "0"},
                    "command": [sys.executable, str(MCP / "mock_server.py"), s, str(MCP / "schemas" / f"{s}.json")]}
                for s in servers},
        "permission": {"*": "allow"},
    }
    if plugin:
        cfg["plugin"] = [[str(ROOT / "dist" / "index.js"), {"minTools": 30}]]
    return cfg


def run(mode, prompt, version, keep):
    work = Path(tempfile.mkdtemp(prefix=f"oc-{mode}-"))
    port = free_port()
    log = work / "llm.jsonl"
    llm = subprocess.Popen([sys.executable, str(BENCH / "mock_llm.py"), str(port), str(log)])
    (work / "project").mkdir()
    (work / "project" / "opencode.json").write_text(json.dumps(config(port, mode == "routed"), indent=1))
    home = work / "home"
    env = {**os.environ, "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
           "XDG_DATA_HOME": str(home / ".local/share"), "XDG_STATE_HOME": str(home / ".local/state"),
           "XDG_CACHE_HOME": str(keep / "xdg-cache"), "npm_config_cache": str(Path.home() / ".npm"),
           "OPENCODE_DISABLE_AUTOUPDATE": "1"}
    t0 = time.time()
    # Own process group: opencode leaves a server and its MCP children behind otherwise.
    proc = subprocess.Popen(["npx", "-y", f"opencode-ai@{version}", "run", prompt, "-m", "mock/mock-1"],
                            cwd=work / "project", env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=180)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        out, err, code = "", "timeout", -1
    finally:
        llm.terminate()
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
    p = subprocess.CompletedProcess([], code, out, err)
    wall = time.time() - t0
    reqs = [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []
    main = [r for r in reqs if r["n_tools"] > 0]
    return {"mode": mode, "wall_s": round(wall, 1), "exit": p.returncode, "requests": len(reqs),
            "n_tools": main[0]["n_tools"] if main else 0, "tools_chars": main[0]["tools_chars"] if main else 0,
            "tool_names": main[0]["tool_names"] if main else [], "stderr": p.stderr[-1500:], "work": str(work)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompts", default="gh1,mx2,sl3,ji2,web1,nt1")
    ap.add_argument("--opencode-version", default="1.18.31")
    a = ap.parse_args()
    prompts = {p["id"]: p for p in json.load(open(BENCH / "prompts.json"))}
    keep = BENCH / "work"
    keep.mkdir(exist_ok=True)
    out = BENCH / "results"
    out.mkdir(exist_ok=True)
    rows = []
    for pid in a.prompts.split(","):
        p = prompts[pid]
        for mode in ("all", "routed"):
            r = run(mode, p["prompt"], a.opencode_version, keep)
            r["id"] = pid
            r["must_loaded"] = all(any(t.replace(".", "_", 1) in r["tool_names"] for t in g) for g in p["must"]) if p["must"] else None
            rows.append(r)
            print(f"{pid:5s} {mode:6s} exit={r['exit']} requests={r['requests']} tools_sent={r['n_tools']:3d} "
                  f"tool_chars={r['tools_chars']:7,d} (~{r['tools_chars'] // 4:,} tokens) must_loaded={r['must_loaded']} {r['wall_s']}s", flush=True)
            if r["exit"] != 0:
                print("   stderr:", r["stderr"][-600:])
    (out / "opencode_e2e.json").write_text(json.dumps(rows, indent=1))
    for mode in ("all", "routed"):
        m = [r for r in rows if r["mode"] == mode and r["requests"]]
        if m:
            print(f"{mode:6s} mean tools sent {st.mean(r['n_tools'] for r in m):.0f}, mean tool schema chars {st.mean(r['tools_chars'] for r in m):,.0f}")


if __name__ == "__main__":
    main()
