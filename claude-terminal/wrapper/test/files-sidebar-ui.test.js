'use strict';

// files-sidebar-ui.js is the Files sidebar's DOM wiring; what it does on the
// page is proven by the integration suite. Tested here is its contract with
// index.html: loading it only attaches FilesSidebarUI, init() insists on
// the three page functions it uses, and a missing files-sidebar.js still
// hides the Files button instead of throwing. Runs the file in a node:vm
// context whose document records every lookup.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'files-sidebar-ui.js'), 'utf8');

// `elements` maps an id to what getElementById returns.
function load(elements = {}) {
    const touched = [];
    const errors = [];
    const document = {
        getElementById(id) { touched.push('#' + id); return elements[id] || null; },
        querySelector(sel) { touched.push(sel); return null; },
        querySelectorAll(sel) { touched.push(sel); return []; },
        addEventListener(type) { touched.push('document:' + type); },
    };
    const win = {
        document,
        console: { error: (...a) => errors.push(a.join(' ')), warn() {}, log() {} },
        addEventListener(type) { touched.push('window:' + type); },
    };
    win.self = win;
    win.window = win;
    vm.runInContext(SOURCE, vm.createContext(win), { filename: 'files-sidebar-ui.js' });
    return { win, touched, errors };
}

const pageFunctions = () => ({
    injectIntoTerminal: () => true,
    copyToClipboard: async () => true,
    setStatus: () => {},
});

// An error thrown inside the vm has the vm's TypeError, not this realm's,
// so match by name rather than with instanceof.
const typeErrorNaming = (name) => (err) => err.name === 'TypeError' && err.message.includes(name);

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}`);
        console.error(err.message);
        process.exitCode = 1;
    }
}

test('loading attaches FilesSidebarUI, with init and nothing else', () => {
    const { win } = load();
    assert.deepStrictEqual(Object.keys(win.FilesSidebarUI), ['init']);
    assert.strictEqual(typeof win.FilesSidebarUI.init, 'function');
});

// What lets index.html load it with the other scripts, ahead of its page
// script: until init() it needs no element and wires no listener.
test('loading touches no element and adds no listener', () => {
    const { touched } = load();
    assert.deepStrictEqual(touched, []);
});

test('init refuses each missing page function by name, before touching the page', () => {
    for (const name of ['injectIntoTerminal', 'copyToClipboard', 'setStatus']) {
        const { win, touched } = load();
        const deps = pageFunctions();
        delete deps[name];
        assert.throws(() => win.FilesSidebarUI.init(deps), typeErrorNaming(name), name);
        assert.deepStrictEqual(touched, [], name);
    }
});

test('init with no argument at all is refused the same way', () => {
    const { win } = load();
    assert.throws(() => win.FilesSidebarUI.init(), typeErrorNaming('injectIntoTerminal'));
});

// The guard that was at the top of the inline sidebar code, now at the top
// of init(): its early return must still stop everything after it.
test('without files-sidebar.js, init hides the Files button and stops there', () => {
    const filesBtn = { style: {} };
    const { win, touched, errors } = load({ 'files-sidebar': {}, 'files-btn': filesBtn });
    win.FilesSidebarUI.init(pageFunctions());
    assert.strictEqual(filesBtn.style.display, 'none');
    assert.ok(errors.some((e) => e.includes('files-sidebar.js did not load')), JSON.stringify(errors));
    assert.deepStrictEqual(touched, ['#files-sidebar', '#files-btn']);
});

console.log(`\n${passed} passed`);
