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
];
