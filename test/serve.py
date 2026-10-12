"""Serves src/ like Cockpit does: /pkg/cronjobs/…, the mock cockpit.js and po.js under
/pkg/base1/, Cockpit's fonts under /static/fonts/ (a stand-in when Cockpit is not
installed), with Cockpit's CSP."""
import http.server, os, sys

here = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(here), "src")
STATIC = os.environ.get("COCKPIT_STATIC", "/usr/share/cockpit/static")
MAP = {
    "/pkg/base1/cockpit.js": os.path.join(here, "web", "mock-cockpit.js"),
    "/pkg/base1/po.js": os.path.join(here, "web", "mock-po.js"),
}
CSP = ("default-src 'self'; connect-src 'self' ws: wss:; form-action 'self'; base-uri 'self'; "
       "object-src 'none'; font-src 'self' data:; img-src 'self' data:; block-all-mixed-content")
TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8",
         ".json": "application/json", ".woff2": "font/woff2"}


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        fn = None
        if path in MAP:
            fn = MAP[path]
        elif path.startswith("/pkg/cronjobs/"):
            rel = os.path.normpath(path[len("/pkg/cronjobs/"):])
            if not rel.startswith(".."):
                fn = os.path.join(SRC, rel)
        elif path.startswith("/static/"):
            rel = os.path.normpath(path[len("/static/"):])
            if not rel.startswith(".."):
                fn = os.path.join(STATIC, rel)
                if not os.path.isfile(fn) and os.path.isfile(fn + ".gz"):
                    import gzip
                    data = gzip.open(fn + ".gz").read()
                    return self.send(data, os.path.splitext(fn)[1])
        if path.startswith("/static/fonts/") and path.endswith(".woff2") and (not fn or not os.path.isfile(fn)):
            # Without Cockpit installed (e.g. in CI) a stand-in, so that the page sees a font.
            fn = os.path.join(SRC, "DMSans.woff2")
        if not fn or not os.path.isfile(fn):
            self.send_response(404)
            self.end_headers()
            return
        self.send(open(fn, "rb").read(), os.path.splitext(fn)[1])

    def send(self, data, ext):
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8772), H).serve_forever()
