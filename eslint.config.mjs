import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
    js.configs.recommended,
    sonarjs.configs.recommended,
    {
        languageOptions: { globals: globals.node },
        rules: { eqeqeq: ['error', 'always'] },
    },
    prettier,
]);
