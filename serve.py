#!/usr/bin/env python3
"""Serve the editor on localhost.

The editor itself never needs the internet. When an edited line needs a font
the PDF does not fully contain, /api/font looks for it on this computer first
and only then on Google Fonts; downloads are cached in fonts/cache/.
"""

import http.server
import json
import os
import subprocess
import sys
import urllib.parse
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(ROOT, ".venv")
REQUIREMENTS = ["fonttools", "brotli"]


def ensure_dependencies():
    try:
        import fontTools  # noqa: F401
        return
    except ImportError:
        pass
    venv_python = os.path.join(VENV, "Scripts" if os.name == "nt" else "bin", "python")
    if os.path.abspath(sys.executable) == os.path.abspath(venv_python):
        print("Installing font tools:", ", ".join(REQUIREMENTS))
        subprocess.check_call([venv_python, "-m", "pip", "install", "-q", *REQUIREMENTS])
        return
    if not os.path.exists(venv_python):
        print("Creating local Python environment in .venv …")
        subprocess.check_call([sys.executable, "-m", "venv", VENV])
    os.execv(venv_python, [venv_python, os.path.abspath(__file__), *sys.argv[1:]])


ensure_dependencies()
import fontresolver  # noqa: E402


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".gz": "application/gzip",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/font":
            return self.serve_font(urllib.parse.parse_qs(url.query))
        return super().do_GET()

    def serve_font(self, q):
        flag = lambda k: q.get(k, ["0"])[0] == "1"  # noqa: E731
        try:
            data, info = fontresolver.resolve(
                q.get("name", [""])[0],
                bold=flag("bold"), italic=flag("italic"), serif=flag("serif"), mono=flag("mono"),
            )
        except Exception as err:
            data, info = None, {"source": "none", "error": str(err)}
        print("font:", info.get("requested"), "->", info.get("source"), info.get("match", ""))
        self.send_response(200 if data else 404)
        self.send_header("Content-Type", "font/ttf" if data else "application/json")
        self.send_header("X-Font-Info", json.dumps(info))
        self.end_headers()
        self.wfile.write(data or json.dumps(info).encode())

    def end_headers(self):
        # Always serve the current app code (no stale cached modules after updates).
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    url = f"http://localhost:{PORT}/"
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"PDF editor running at {url}  (Ctrl+C to stop)", flush=True)
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
