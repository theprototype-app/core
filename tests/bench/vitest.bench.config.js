// Roadmap 99 K1: the kernel bench, kept OUT of the unit run (vitest.config.ts includes tests/unit
// only). Run: NODE_OPTIONS='--expose-gc --max-old-space-size=8192' npx vitest run --config tests/bench/vitest.bench.config.js
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
	resolve: { alias: { $lib: fileURLToPath(new URL('../../src/lib', import.meta.url)) } },
	test: { include: ['tests/bench/**/*.bench.test.js'], environment: 'node', testTimeout: 1800000, hookTimeout: 1800000 }
});
