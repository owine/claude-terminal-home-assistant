// A stand-in for Home Assistant's ingress, for integration testing.
//
// Hitting http://localhost:7680/ directly is not how anyone actually uses this
// add-on, and the differences are exactly where bugs have hidden:
//
//   1. Ingress serves the wrapper under a long path prefix
//      (/api/hassio_ingress/<token>/), so every relative URL in index.html --
//      `config`, `terminal/`, `terminal-clipboard.js`, the service worker scope
//      -- resolves somewhere other than the site root. A path that works at the
//      root and 404s under a prefix is invisible to a direct-port test.
//   2. The wrapper page runs INSIDE an iframe on the HA page, so the terminal
//      is a nested frame and browser features that iframes gate -- clipboard
//      access in particular -- behave differently than at the top level.
//
// This harness reproduces both. It deliberately does NOT reproduce TLS: HA
// serves ingress over HTTPS, but localhost is already a secure context, so the
// clipboard APIs take the same path either way. TLS-specific behaviour is a
// known, accepted gap.
//
// The iframe carries no `allow` attribute on purpose. That is the restrictive
// case: anything that works here works regardless of what HA chooses to
// delegate. If clipboard delivery fails here but works on a direct port, that
// is a real finding about iframe permissions, not a harness artifact.

import http from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';

const TOKEN = 'TESTINGRESSTOKEN0000000000000000';
export const INGRESS_PATH = `/api/hassio_ingress/${TOKEN}/`;

const OUTER_PAGE = `<!doctype html>
<html><head><title>Home Assistant (test harness)</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
</head><body>
<iframe id="ingress-frame" src="${INGRESS_PATH}"></iframe>
</body></html>`;

export function startIngress({ target = 'http://localhost:7680', port = 8123 } = {}) {
    const proxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        // Strip the ingress prefix, the way HA's own ingress does. The wrapper
        // never learns it is behind one -- which is the point, and why its URLs
        // have to stay relative.
        pathRewrite: { [`^${INGRESS_PATH}`]: '/' },
    });

    const server = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(OUTER_PAGE);
            return;
        }
        if (req.url.startsWith(INGRESS_PATH)) return proxy(req, res, () => {
            res.writeHead(502); res.end('proxy error');
        });
        res.writeHead(404); res.end('not found');
    });

    // ttyd's terminal is a WebSocket, so the upgrade path has to be proxied too
    // or the terminal never connects and every assertion times out.
    server.on('upgrade', (req, socket, head) => {
        if (req.url.startsWith(INGRESS_PATH)) proxy.upgrade(req, socket, head);
        else socket.destroy();
    });

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () =>
            resolve({ url: `http://localhost:${port}/`, close: () => server.close() }));
    });
}
