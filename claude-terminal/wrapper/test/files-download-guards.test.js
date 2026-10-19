'use strict';

// Files sidebar downloads (files-download.js), part 4 of 4: who may start
// one. A download another site starts is refused before the rate limiters,
// and costs no one's budget; the zip limiter applies.
// Fixture: files-download-fixture.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../http-guards.js');
const { withServer } = require('./files-download-fixture.js');

test('routes: a download another site starts (Sec-Fetch-Site: cross-site) is a 403 JSON', async () => {
    // A cross-site page can start a GET (a link, an <img>) but not read the
    // answer; refusing it anyway keeps another site from making the browser
    // save /config files or start zips. Same-origin is the sidebar, under
    // ingress too (the wrapper frame and its URLs share HA's origin).
    const routes = [
        ['download', 'download?path=configuration.yaml'],
        ['zip', 'download-zip?path=blueprints'],
        ['zip check', 'download-zip?path=blueprints&check=1'],
    ];
    await withServer({}, async (url) => {
        for (const [label, route] of routes) {
            const refusedRes = await fetch(`${url}/${route}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
            assert.strictEqual(refusedRes.status, 403, label);
            assert.strictEqual(refusedRes.headers.get('content-disposition'), null, label);
            assert.match((await refusedRes.json()).error, /another site/, label);
            for (const site of ['same-origin', 'same-site', 'none', null]) {
                const res = await fetch(`${url}/${route}`, site === null ? {} : { headers: { 'Sec-Fetch-Site': site } });
                assert.strictEqual(res.status, 200, `${label}, Sec-Fetch-Site: ${site}`);
                await res.arrayBuffer();
            }
        }
    });
});

test('routes: a refused cross-site request costs no rate-limit budget', async () => {
    await withServer({ zipLimiter: createRateLimiter({ max: 1 }), fileLimiter: createRateLimiter({ max: 1 }) }, async (url) => {
        const cross = { headers: { 'Sec-Fetch-Site': 'cross-site' } };
        assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`, cross)).status, 403);
        assert.strictEqual((await fetch(`${url}/download?path=configuration.yaml`, cross)).status, 403);
        assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 200);
        const res = await fetch(`${url}/download?path=configuration.yaml`);
        assert.strictEqual(res.status, 200);
        await res.arrayBuffer();
    });
});

test('routes: the zip rate limiter applies', async () => {
    await withServer({ zipLimiter: createRateLimiter({ max: 1 }) }, async (url) => {
        assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 200);
        assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 429);
    });
});
