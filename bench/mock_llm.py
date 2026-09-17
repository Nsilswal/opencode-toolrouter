"""OpenAI-compatible chat completions server that records every request and replies with plain text.

Usage: mock_llm.py <port> <log.jsonl>
It lets us see exactly which tools opencode sends to the model, without paying for a model.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        tools = body.get("tools") or []
        names = [t.get("function", {}).get("name") for t in tools]
        with open(LOG, "a") as f:
            f.write(json.dumps({
                "t": time.time(), "path": self.path, "n_tools": len(tools), "tool_names": names,
                "tools_chars": len(json.dumps(tools)), "messages_chars": len(json.dumps(body.get("messages", []))),
            }) + "\n")
        chunks = [
            {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "DONE"}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for c in chunks:
                c.update({"id": "mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": body.get("model")})
                self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            out = {"id": "mock", "object": "chat.completion", "created": int(time.time()), "model": body.get("model"),
                   "choices": [{"index": 0, "message": {"role": "assistant", "content": "DONE"}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
            data = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
