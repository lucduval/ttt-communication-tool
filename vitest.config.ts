import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // `.scratch/` holds gitignored bad-debt run working files, including
        // throwaway copies of repro tests that import product modules by paths
        // only valid from their original location. They are not the suite.
        exclude: ['**/node_modules/**', '**/dist/**', '.scratch/**'],
    },
});
