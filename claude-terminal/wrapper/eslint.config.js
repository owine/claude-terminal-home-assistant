// ESLint flat config for the wrapper service.
// server.js runs under Node (CommonJS); public/ ships browser/service-worker code.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        // Node-side Express service and this config file.
        files: ['server.js', 'eslint.config.js'],
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
        files: ['public/login-link.js', 'public/terminal-mouse.js'],
        languageOptions: {
            globals: { module: 'writable', exports: 'writable', Buffer: 'readonly' },
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
