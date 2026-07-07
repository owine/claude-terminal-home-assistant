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
        // Dual-target UMD module: shipped to the browser AND required by the Node test harness.
        // The public/**/*.js block above already grants browser + serviceworker globals;
        // this adds the CommonJS globals it needs for `module.exports`.
        files: ['public/login-link.js'],
        languageOptions: {
            globals: { module: 'writable', exports: 'writable' },
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
