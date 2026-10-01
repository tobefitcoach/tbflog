# Local preview: python3 dev-server.py  ->  http://localhost:8000
#
# Same as `python3 -m http.server 8000`, but tells the browser never to
# cache. Locally every file is loaded as ?v=__V__ (the deploy workflow
# stamps the real version), so without this a browser could keep showing
# an old copy of a file you just edited.
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    print('Serving on http://localhost:8000 (no caching)')
    ThreadingHTTPServer(('', 8000), NoCacheHandler).serve_forever()
