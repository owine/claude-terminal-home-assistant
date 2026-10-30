// ESLint flat config for the wrapper service.
// server.js runs under Node (CommonJS); public/ ships browser/service-worker code.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        // Node-side Express service, its helper modules, and this config file.
        files: ['server.js', 'cache-policy.js', 'http-guards.js', 'upload-naming.js', 'proxy-error.js', 'login-notifier.js', 'files-api.js', 'files-download.js', 'files-upload.js', 'upload-parts.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
    {
        // Browser assets, including the PWA service worker.
        files: ['public/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser, ...globals.serviceworker },
        },
    },
    {
        // Dual-target UMD modules: shipped to the browser AND required by the Node test harness.
        // The public/**/*.js block above already grants browser + serviceworker globals;
        // this adds the CommonJS globals they need for `module.exports`.
        files: ['public/login-link.js', 'public/terminal-clipboard.js', 'public/terminal-keys.js', 'public/files-sidebar.js', 'public/viewport-fit.js'],
        languageOptions: {
            globals: { module: 'writable', exports: 'writable', Buffer: 'readonly' },
        },
    },
    {
        // Dual-target as well, and under Node it require()s files-sidebar.js.
        files: ['public/upload-client.js'],
        languageOptions: {
            globals: { module: 'writable', exports: 'writable', require: 'readonly' },
        },
    },
    {
        // Browser-driving integration test: ESM, Node globals, not run by CI.
        files: ['test/integration/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },
    {
        // Node test harness (no framework).
        files: ['test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
];
