"""Lets the window show local files (images, video, audio, PDFs): each file gets a random one-off link on 127.0.0.1
that serves exactly that file, with byte ranges so video and audio can seek. Nothing else on disk is reachable."""

import http.server
import mimetypes
import os
import secrets
import socketserver
import threading
import urllib.parse

KINDS = {
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"},
    "video": {".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"},
    "audio": {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"},
    "pdf": {".pdf"},
}


def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    return next((k for k, exts in KINDS.items() if ext in exts), "file")


class MediaServer:
    def __init__(self):
        self.tokens = {}   # token -> absolute path
        self.paths = {}    # absolute path -> token
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                token = self.path.lstrip("/").split("/", 1)[0]
                path = server.tokens.get(token)
                if not path or not os.path.isfile(path):
                    self.send_error(404)
                    return
                size = os.path.getsize(path)
                start, end = 0, size - 1
                rng = self.headers.get("Range", "")
                if rng.startswith("bytes="):
                    a, _, b = rng[6:].split(",")[0].partition("-")
                    start = int(a) if a else max(0, size - int(b or 0))
                    end = min(size - 1, int(b)) if a and b else end
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                else:
                    self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(path, "rb") as f:
                    f.seek(start)
                    left = end - start + 1
                    try:
                        while left > 0:
                            chunk = f.read(min(256 * 1024, left))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            left -= len(chunk)
                    except (ConnectionError, OSError):
                        pass   # the player stopped reading (seek, close)

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.httpd = Server(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="media").start()

    def url(self, path):
        path = os.path.abspath(path)
        token = self.paths.get(path)
        if token is None:
            token = secrets.token_urlsafe(12)
            self.tokens[token] = path
            self.paths[path] = token
        return f"http://127.0.0.1:{self.port}/{token}/{urllib.parse.quote(os.path.basename(path))}"
