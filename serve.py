#!/usr/bin/env python3
"""Serve the editor on localhost.

The editor itself never needs the internet. When an edited line needs a font
the PDF does not fully contain, /api/font looks for it on this computer first
and only then on Google Fonts; downloads are cached in fonts/cache/.

POST /api/markdown converts a PDF to Markdown with MarkItDown. MarkItDown needs
Python 3.10+, so it lives in its own environment (.venv-markitdown), created on
first use with uv or any Python 3.10+ found on PATH.
"""

import http.server
import shutil
import threading
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
MD_VENV = os.path.join(ROOT, ".venv-markitdown")
MD_PYTHON = os.path.join(MD_VENV, "Scripts" if os.name == "nt" else "bin", "python")
MD_REQUIREMENT = "markitdown[pdf]"
MD_MAX_BYTES = 200 * 1024 * 1024
_md_lock = threading.Lock()


def ensure_dependencies():
    try:
        import fontTools  # noqa: F401
        return
    except ImportError:
        pass
    venv_python = os.path.join(
        VENV, "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"
    )
    if os.path.abspath(sys.executable) == os.path.abspath(venv_python):
        print("Installing font tools:", ", ".join(REQUIREMENTS))
        subprocess.check_call([venv_python, "-m", "pip", "install", "-q", *REQUIREMENTS])
        return
    if not os.path.exists(venv_python):
        print("Creating local Python environment in .venv …")
        subprocess.check_call([sys.executable, "-m", "venv", VENV])
    if os.name == "nt":
        # os.execv() on Windows mangles argv when a path contains spaces
        # (e.g. "C:\Users\me\My Project"), so re-launch as a subprocess instead.
        sys.exit(subprocess.call([venv_python, os.path.abspath(__file__), *sys.argv[1:]]))
    os.execv(venv_python, [venv_python, os.path.abspath(__file__), *sys.argv[1:]])


ensure_dependencies()
import fontresolver  # noqa: E402


def ensure_markitdown():
    """Create .venv-markitdown with MarkItDown installed, once. Returns its python."""
    with _md_lock:
        if os.path.exists(MD_PYTHON):
            probe = subprocess.run([MD_PYTHON, "-c", "import markitdown"], capture_output=True)
            if probe.returncode == 0:
                return MD_PYTHON
        uv = shutil.which("uv")
        if uv:
            print("Setting up MarkItDown (uv, Python 3.12) …", flush=True)
            if not os.path.exists(MD_PYTHON):
                subprocess.check_call([uv, "venv", "-q", "--python", "3.12", MD_VENV])
            subprocess.check_call([uv, "pip", "install", "-q", "--python", MD_PYTHON, MD_REQUIREMENT])
            return MD_PYTHON
        for name in ("python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"):
            exe = shutil.which(name)
            if not exe:
                continue
            ok = subprocess.run([exe, "-c", "import sys; sys.exit(sys.version_info < (3, 10))"], capture_output=True)
            if ok.returncode == 0:
                print(f"Setting up MarkItDown ({exe}) …", flush=True)
                if not os.path.exists(MD_PYTHON):
                    subprocess.check_call([exe, "-m", "venv", MD_VENV])
                subprocess.check_call([MD_PYTHON, "-m", "pip", "install", "-q", MD_REQUIREMENT])
                return MD_PYTHON
        raise RuntimeError("MarkItDown needs Python 3.10 or newer (or uv). Install one and try again.")


def pdf_to_markdown(pdf_bytes):
    python = ensure_markitdown()
    script = os.path.join(ROOT, "markdown_convert.py")
    proc = subprocess.run([python, "-I", script], input=pdf_bytes, capture_output=True, timeout=600)
    if proc.returncode != 0:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "conversion failed")
    return proc.stdout


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

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/markdown":
            return self.serve_markdown()
        self.send_error(404)

    def serve_markdown(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MD_MAX_BYTES:
            return self.send_json(413 if length else 400, {"error": "send a PDF up to 200 MB"})
        pdf = self.rfile.read(length)
        try:
            markdown = pdf_to_markdown(pdf)
        except Exception as err:
            print("markdown: failed:", err)
            return self.send_json(500, {"error": str(err)})
        print(f"markdown: {length // 1024} KB PDF -> {len(markdown) // 1024} KB Markdown")
        self.send_response(200)
        self.send_header("Content-Type", "text/markdown; charset=utf-8")
        self.send_header("Content-Length", str(len(markdown)))
        self.end_headers()
        self.wfile.write(markdown)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
