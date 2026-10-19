'use strict';

// The upload flow the Files sidebar and the terminal share
// (public/upload-client.js). Requests go through fakes: a fetch that answers
// from a list and an XMLHttpRequest that replies on the next microtask, so
// every way through uploadOne and runBatch runs without a server. What the
// callers do with it on the page is the integration suite's.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const client = require('../public/upload-client.js');

const PUBLIC = path.join(__dirname, '..', 'public');

// fetch: each call takes the next answer, { status, data } or { status, text },
// or an Error to throw. Records every call.
function fakeFetch(...answers) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const a = answers.shift();
        if (!a) throw new Error('unexpected fetch: ' + url);
        if (a instanceof Error) throw a;
        const text = a.text !== undefined ? a.text : JSON.stringify(a.data ?? {});
        return { status: a.status, text: async () => text, json: async () => JSON.parse(text) };
    };
    return { fetchImpl, calls };
}

// XMLHttpRequest: each send() takes the next reply, { status, data or text,
// progress: [fractions or raw progress events] }, or 'error' / 'abort'.
// Records every request. A send with no reply left throws, as an unexpected
// fetch does, so a request that should not happen fails the test at once.
function fakeXHR(...replies) {
    const sent = [];
    class XHRImpl {
        constructor() { this.upload = {}; this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { this.headers[name] = value; }
        send(body) {
            this.body = body;
            sent.push(this);
            const r = replies.shift();
            if (!r) throw new Error('unexpected upload: ' + this.url);
            queueMicrotask(() => {
                if (r === 'error') return this.onerror();
                if (r === 'abort') return this.onabort();
                for (const f of r.progress || []) {
                    this.upload.onprogress?.(typeof f === 'number'
                        ? { lengthComputable: true, loaded: f * 100, total: 100 }
                        : f);
                }
                this.status = r.status;
                this.responseText = r.text !== undefined ? r.text : JSON.stringify(r.data ?? {});
                this.onload();
            });
        }
    }
    return { XHRImpl, sent };
}

const file = (name, type = 'application/octet-stream', body = 'x') => new File([body], name, { type });

// --- ask: the check=1 question ---

test('ask posts with no body and no cache, and returns the status and JSON', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, data: { name: 'a.txt', exists: false } });
    const got = await client.ask('api/files/upload?name=a.txt&check=1&size=1', { fetchImpl });
    assert.deepStrictEqual(got, { status: 200, data: { name: 'a.txt', exists: false } });
    assert.deepStrictEqual(calls, [{ url: 'api/files/upload?name=a.txt&check=1&size=1', init: { method: 'POST', cache: 'no-store' } }]);
});

test('ask reads an answer that is not JSON as no data', async () => {
    const { fetchImpl } = fakeFetch({ status: 502, text: '<html>Bad gateway</html>' });
    assert.deepStrictEqual(await client.ask('u', { fetchImpl }), { status: 502, data: {} });
});

test('ask without an answer is status 0, with the reason', async () => {
    const { fetchImpl } = fakeFetch(new TypeError('Failed to fetch'));
    assert.deepStrictEqual(await client.ask('u', { fetchImpl }), { status: 0, data: { error: 'Failed to fetch' } });
});

// --- send: the upload itself ---

test('send posts the bytes as they are, reports progress, and returns the JSON', async () => {
    // An event with no length to go by, or a total of 0, is no progress to
    // show (it would be NaN or a guess), so it is left out.
    const { XHRImpl, sent } = fakeXHR({
        status: 200,
        data: { path: '/config/uploads/a.txt' },
        progress: [
            0.25,
            { lengthComputable: false, loaded: 50, total: 100 },
            { lengthComputable: true, loaded: 0, total: 0 },
            1,
        ],
    });
    const seen = [];
    const f = file('a.txt');
    const got = await client.send('api/files/upload?name=a.txt', f, (x) => seen.push(x), { XHRImpl });
    assert.deepStrictEqual(got, { status: 200, data: { path: '/config/uploads/a.txt' } });
    assert.deepStrictEqual(seen, [0.25, 1]);
    assert.strictEqual(sent[0].method, 'POST');
    assert.strictEqual(sent[0].url, 'api/files/upload?name=a.txt');
    assert.deepStrictEqual(sent[0].headers, { 'Content-Type': 'application/octet-stream' });
    assert.strictEqual(sent[0].body, f);
});

test('send without an answer (a network error, an abort) is status 0', async () => {
    const { XHRImpl } = fakeXHR('error', 'abort');
    assert.deepStrictEqual(await client.send('u', file('a'), undefined, { XHRImpl }), { status: 0, data: {} });
    assert.deepStrictEqual(await client.send('u', file('a'), undefined, { XHRImpl }), { status: 0, data: {} });
});

test('send reads an answer that is not JSON as no data', async () => {
    const { XHRImpl } = fakeXHR({ status: 500, text: 'oops' });
    assert.deepStrictEqual(await client.send('u', file('a'), undefined, { XHRImpl }), { status: 500, data: {} });
});

// --- uploadOne: one file, asked about, then sent ---

test('uploadOne asks, then sends to the same place, in that order, and returns the answer', async () => {
    const order = [];
    const fake = fakeFetch({ status: 200, data: {} });
    const fetchImpl = (url, init) => { order.push('ask'); return fake.fetchImpl(url, init); };
    const { XHRImpl, sent } = fakeXHR({ status: 200, data: { path: '/config/a b/x.txt', name: 'x.txt' }, progress: [0.5] });
    const got = await client.uploadOne(file('x.txt', 'text/plain', 'abc'), {
        dest: '/config/a b',
        onCheck: () => order.push('check'),
        onSend: () => { order.push('send'); return (f) => order.push(f); },
        fetchImpl,
        XHRImpl,
    });
    assert.deepStrictEqual(got, { result: { path: '/config/a b/x.txt', name: 'x.txt' } });
    assert.deepStrictEqual(order, ['check', 'ask', 'send', 0.5]);
    assert.strictEqual(fake.calls[0].url, 'api/files/upload?name=x.txt&dest=%2Fconfig%2Fa%20b&check=1&size=3');
    assert.strictEqual(sent[0].url, 'api/files/upload?name=x.txt&dest=%2Fconfig%2Fa%20b');
});

test('uploadOne: a taken name in a chosen folder asks, and Replace sends with onConflict=replace', async () => {
    const asked = [];
    const { fetchImpl } = fakeFetch({ status: 409, data: { reason: 'exists', replaceable: true, error: 'x.txt already exists in /config/f.' } });
    const { XHRImpl, sent } = fakeXHR({ status: 200, data: { path: '/config/f/x.txt', replaced: true } });
    const got = await client.uploadOne(file('x.txt'), {
        dest: '/config/f',
        askCollision: async (text, replaceable) => { asked.push([text, replaceable]); return 'replace'; },
        fetchImpl,
        XHRImpl,
    });
    assert.deepStrictEqual(asked, [['x.txt already exists in /config/f.', true]]);
    assert.strictEqual(sent[0].url, 'api/files/upload?name=x.txt&dest=%2Fconfig%2Ff&onConflict=replace');
    assert.deepStrictEqual(got, { result: { path: '/config/f/x.txt', replaced: true } });
});

test('uploadOne: Cancel skips the file and sends nothing', async () => {
    const asked = [];
    const { fetchImpl } = fakeFetch({ status: 409, data: { reason: 'exists', replaceable: false } });
    const { XHRImpl, sent } = fakeXHR();
    const got = await client.uploadOne(file('x.txt'), {
        dest: '/config/f',
        askCollision: async (text, replaceable) => { asked.push([text, replaceable]); return null; },
        fetchImpl,
        XHRImpl,
    });
    assert.deepStrictEqual(got, { skipped: 'x.txt' });
    // No message from the server: one of its own.
    assert.deepStrictEqual(asked, [['x.txt already exists.', false]]);
    assert.strictEqual(sent.length, 0);
});

// The terminal never asks: the inbox numbers a taken name, so a 409 there
// is something else gone wrong, and is reported.
test('uploadOne: with nothing to ask, a taken name is a refusal', async () => {
    const { fetchImpl } = fakeFetch({ status: 409, data: { reason: 'exists', replaceable: true, error: 'x.txt already exists in /config/uploads.' } });
    const { XHRImpl, sent } = fakeXHR();
    const got = await client.uploadOne(file('x.txt'), { fetchImpl, XHRImpl });
    assert.deepStrictEqual(got, { problem: 'x.txt already exists in /config/uploads.', status: 409 });
    assert.strictEqual(sent.length, 0);
});

test('uploadOne: a 409 that is not a taken name is a refusal, even with someone to ask', async () => {
    const { fetchImpl } = fakeFetch({ status: 409, data: { reason: 'not-plain-folder', error: '/config/f is not a plain folder (it is a symlink or a file), so nothing is uploaded into it.' } });
    const { XHRImpl, sent } = fakeXHR();
    let asked = 0;
    const got = await client.uploadOne(file('x.txt'), { dest: '/config/f', askCollision: async () => { asked++; return 'replace'; }, fetchImpl, XHRImpl });
    assert.strictEqual(asked, 0);
    assert.strictEqual(got.status, 409);
    assert.strictEqual(sent.length, 0);
});

test('uploadOne: a refused question is a problem with its status, and nothing is sent', async () => {
    const limit = 'big.bin is 26.0 MB, over the 25 MB upload limit (the add-on\'s upload_max_mb option).';
    const { fetchImpl } = fakeFetch({ status: 413, data: { error: limit } }, new TypeError('Failed to fetch'));
    const { XHRImpl, sent } = fakeXHR();
    assert.deepStrictEqual(await client.uploadOne(file('big.bin'), { fetchImpl, XHRImpl }), { problem: limit, status: 413 });
    assert.deepStrictEqual(await client.uploadOne(file('a.txt'), { fetchImpl, XHRImpl }),
        { problem: 'Could not reach the add-on to upload a.txt. Check the connection and try again.', status: 0 });
    assert.strictEqual(sent.length, 0);
});

test('uploadOne: a failed upload, or an answer with no path, is a problem', async () => {
    const { fetchImpl } = fakeFetch({ status: 200, data: {} }, { status: 200, data: {} });
    const { XHRImpl } = fakeXHR({ status: 507, data: { error: 'The disk is full.' } }, { status: 200, data: {} });
    assert.deepStrictEqual(await client.uploadOne(file('a.txt'), { fetchImpl, XHRImpl }), { problem: 'a.txt: The disk is full.', status: 507 });
    assert.deepStrictEqual(await client.uploadOne(file('a.txt'), { fetchImpl, XHRImpl }), { problem: 'a.txt: upload failed (HTTP 200).', status: 200 });
});

// --- runBatch: one file after another ---

test('runBatch: one file after another, each in its bucket, with a counter only when there are several', async () => {
    const seen = [];
    const answers = { a: { result: { path: '/x/a' } }, b: { problem: 'b: no', status: 403 }, c: { skipped: 'c' } };
    const got = await client.runBatch([file('a'), file('b'), file('c')],
        async (f, counter, i) => { seen.push([f.name, counter, i]); return answers[f.name]; },
        { onStart: (i) => seen.push(['start', i]) });
    assert.deepStrictEqual(got, { results: [{ path: '/x/a' }], problems: ['b: no'], skipped: ['c'], busy: [] });
    assert.deepStrictEqual(seen, [['start', 0], ['a', ' (1 of 3)', 0], ['start', 1], ['b', ' (2 of 3)', 1], ['start', 2], ['c', ' (3 of 3)', 2]]);
    const one = [];
    await client.runBatch([file('solo')], async (f, counter) => { one.push(counter); return { result: { path: '/x/solo' } }; });
    assert.deepStrictEqual(one, ['']);
});

// Too many uploads: every file after the first 429 would be refused too,
// each spending another request.
test('runBatch stops at the first 429: that file and the rest are busy, and none of them is tried', async () => {
    const tried = [];
    const got = await client.runBatch([file('a'), file('b'), file('c'), file('d')], async (f) => {
        tried.push(f.name);
        return f.name === 'b' ? { problem: 'Too many uploads', status: 429 } : { result: { path: '/x/' + f.name } };
    });
    assert.deepStrictEqual(tried, ['a', 'b']);
    assert.deepStrictEqual(got, { results: [{ path: '/x/a' }], problems: [], skipped: [], busy: ['b', 'c', 'd'] });
});

// --- droppedFiles ---

test('droppedFiles: the files of a drop, folders by name, from items or else from files', () => {
    const a = file('a.txt');
    const b = file('b.txt');
    const items = [
        { kind: 'file', getAsFile: () => a, webkitGetAsEntry: () => null },
        { kind: 'file', getAsFile: () => file('photos'), webkitGetAsEntry: () => ({ isDirectory: true, name: 'photos' }) },
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => b },   // no webkitGetAsEntry at all
    ];
    const names = ({ files, folders }) => ({ files: files.map((f) => f.name), folders });
    assert.deepStrictEqual(names(client.droppedFiles({ items, files: [] })), { files: ['a.txt', 'b.txt'], folders: ['photos'] });
    assert.deepStrictEqual(names(client.droppedFiles({ items: [], files: [a] })), { files: ['a.txt'], folders: [] });
    assert.deepStrictEqual(names(client.droppedFiles(undefined)), { files: [], folders: [] });
});

// --- In the browser ---

// Runs the file as the page does: no module system, files-sidebar.js
// (or not) loaded before it into the same global.
function loadInBrowser({ withHelpers }) {
    const errors = [];
    const win = { console: { error: (...a) => errors.push(a.join(' ')), warn() {}, log() {} } };
    win.self = win;
    win.window = win;
    const context = vm.createContext(win);
    if (withHelpers) vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'files-sidebar.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'upload-client.js'), 'utf8'), context);
    return { win, errors };
}

test('in the browser it attaches UploadClient, using files-sidebar.js loaded before it', () => {
    const { win, errors } = loadInBrowser({ withHelpers: true });
    assert.strictEqual(typeof win.UploadClient.uploadOne, 'function');
    assert.deepStrictEqual(errors, []);
});

test('without files-sidebar.js it attaches nothing, and says so', () => {
    const { win, errors } = loadInBrowser({ withHelpers: false });
    assert.strictEqual(win.UploadClient, undefined);
    assert.ok(errors.some((e) => e.includes('files-sidebar.js did not load')), JSON.stringify(errors));
});

// --- The terminal's paperclip, paste and drop ---

const naming = require('../upload-naming.js');

// A type or a size sent to the image upload that the server then refused
// would be a dead upload; one it would have taken sent to the inbox instead
// would change where images land. The two sides must agree.
test('the image types and limit are the image upload\'s own', () => {
    assert.deepStrictEqual([...client.IMAGE_TYPES].sort(), Object.keys(naming.EXTENSION_FOR_MIME).sort());
    assert.strictEqual(client.IMAGE_MAX_BYTES, naming.IMAGE_MAX_BYTES);
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /fileSize:\s*IMAGE_MAX_BYTES\b/, 'server.js must limit images with IMAGE_MAX_BYTES');
});

test('terminalRoute: a small allowlisted image to the image upload, everything else to the inbox', () => {
    const at = (type, size) => client.terminalRoute({ name: 'f', type, size });
    for (const type of client.IMAGE_TYPES) {
        assert.strictEqual(at(type, client.IMAGE_MAX_BYTES), 'image', type);
        assert.strictEqual(at(type, client.IMAGE_MAX_BYTES + 1), 'inbox', type + ' over the limit');
    }
    for (const type of ['image/heic', 'image/tiff', 'application/pdf', 'text/plain', '']) {
        assert.strictEqual(at(type, 1), 'inbox', type || '(no type)');
    }
});

test('sendImage posts the file as the image field to upload, as the paperclip always has', async () => {
    const { fetchImpl, calls } = fakeFetch(
        { status: 200, data: { success: true, path: '/data/images/pasted-1-0a0b0c0d.png' } },
        { status: 502, text: '<html></html>' },
        new TypeError('Failed to fetch'),
    );
    const f = file('shot.png', 'image/png');
    assert.deepStrictEqual(await client.sendImage(f, { fetchImpl }),
        { status: 200, data: { success: true, path: '/data/images/pasted-1-0a0b0c0d.png' } });
    assert.strictEqual(calls[0].url, 'upload');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(calls[0].init.body.get('image').name, 'shot.png');
    assert.deepStrictEqual(await client.sendImage(f, { fetchImpl }), { status: 502, data: {} });
    assert.deepStrictEqual(await client.sendImage(f, { fetchImpl }), { status: 0, data: { error: 'Failed to fetch' } });
});

test('uploadForTerminal: a small image goes to the image upload, with one line and no progress', async () => {
    const lines = [];
    const { fetchImpl, calls } = fakeFetch(
        { status: 200, data: { success: true, path: '/data/images/pasted-1-0a0b0c0d.png' } },
        { status: 429, data: { error: 'Upload rate limit exceeded, try again in a minute' } },
    );
    const got = await client.uploadForTerminal(file('shot.png', 'image/png'),
        { counter: ' (1 of 2)', onLine: (...a) => lines.push(a), fetchImpl });
    assert.deepStrictEqual(got, { result: { success: true, path: '/data/images/pasted-1-0a0b0c0d.png' } });
    assert.deepStrictEqual(lines, [['Uploading shot.png (1 of 2)…', null]]);
    assert.deepStrictEqual(calls.map((c) => c.url), ['upload']);
    // A 429 keeps its status, so runBatch stops the batch there.
    assert.deepStrictEqual(await client.uploadForTerminal(file('shot.png', 'image/png'), { fetchImpl }),
        { problem: 'shot.png: Upload rate limit exceeded, try again in a minute', status: 429 });
});

test('uploadForTerminal: anything else is asked about and sent to the inbox, with progress', async () => {
    const lines = [];
    const { fetchImpl, calls } = fakeFetch({ status: 200, data: {} });
    const { XHRImpl, sent } = fakeXHR({ status: 200, data: { path: '/config/uploads/my report.pdf' }, progress: [0.5] });
    const got = await client.uploadForTerminal(file('my report.pdf', 'application/pdf', 'pdf'),
        { onLine: (...a) => lines.push(a), fetchImpl, XHRImpl });
    assert.deepStrictEqual(got, { result: { path: '/config/uploads/my report.pdf' } });
    assert.strictEqual(calls[0].url, 'api/files/upload?name=my%20report.pdf&check=1&size=3');
    assert.strictEqual(sent[0].url, 'api/files/upload?name=my%20report.pdf');
    assert.deepStrictEqual(lines, [['Checking my report.pdf…', null], ['Uploading my report.pdf…', 0], ['Uploading my report.pdf…', 0.5]]);
});

test('typedPaths: each path quoted where it needs it, space-separated, in order', () => {
    assert.strictEqual(client.typedPaths([]), '');
    assert.strictEqual(client.typedPaths([
        { path: '/data/images/pasted-1-0a0b0c0d.png' },
        { path: '/config/uploads/my report.pdf' },
        { path: "/config/uploads/it's $HOME.txt" },
    ]), "/data/images/pasted-1-0a0b0c0d.png '/config/uploads/my report.pdf' '/config/uploads/it'\\''s $HOME.txt'");
});

test('terminalStatus: nothing to add when the paths were typed; else what happened, refusals kept', () => {
    assert.strictEqual(client.terminalStatus({ typed: '/a', count: 1, delivered: 'terminal' }), null);
    assert.deepStrictEqual(client.terminalStatus({ typed: "'/c/a b'", count: 1, delivered: 'clipboard' }),
        { message: "Copied path: '/c/a b' — paste in terminal", type: 'success', persistent: false });
    assert.deepStrictEqual(client.terminalStatus({ typed: '/a /b', count: 2, delivered: 'clipboard' }),
        { message: 'Copied paths: /a /b — paste in terminal', type: 'success', persistent: false });
    assert.deepStrictEqual(client.terminalStatus({ typed: '/a', count: 1, delivered: 'none' }),
        { message: 'Path: /a', type: 'success', persistent: true });
    assert.deepStrictEqual(client.terminalStatus({
        typed: '/a', count: 1, delivered: 'terminal',
        problems: ['big.bin: too big'], busy: ['c.txt', 'd.txt'], folders: ['photos'],
    }), {
        message: 'Folders are not uploaded: photos. Drop the files inside them instead. ⚠️ big.bin: too big '
            + '⏳ 2 not uploaded: too many uploads, try again in a minute.',
        type: 'error',
        persistent: true,
    });
    assert.deepStrictEqual(client.terminalStatus({ typed: '/a', count: 1, delivered: 'clipboard', problems: ['b: no'] }),
        { message: 'Copied path: /a — paste in terminal ⚠️ b: no', type: 'error', persistent: true });
});

// A clipboard with plain text on it is a text paste: spreadsheet cells come
// with a picture of themselves, and the terminal must get their text.
test('clipboardFiles: the files of a paste, and none when it also holds plain text', () => {
    const shot = file('image.png', 'image/png');
    const fileItem = { kind: 'file', getAsFile: () => shot };
    const textItem = { kind: 'string', type: 'text/plain', getAsFile: () => null };
    const names = (cd) => client.clipboardFiles(cd).map((f) => f.name);
    assert.deepStrictEqual(names({ types: ['Files'], items: [fileItem] }), ['image.png']);
    assert.deepStrictEqual(names({ types: ['text/html', 'Files'], items: [{ kind: 'string', type: 'text/html' }, fileItem] }), ['image.png']);
    assert.deepStrictEqual(names({ types: ['text/plain', 'Files'], items: [textItem, fileItem] }), []);
    assert.deepStrictEqual(names({ types: ['text/plain'], items: [textItem] }), []);
    assert.deepStrictEqual(names({ types: ['Files'], items: [], files: [shot] }), ['image.png']);
    assert.deepStrictEqual(names(null), []);
});
