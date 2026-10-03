import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 27-I (audit L9): the unit layer the project never had. Deliberately NARROW — only
// modules that import NOTHING run here, so a unit run needs no browser, no jsdom, no
// svelte compiler and no three.js. That is what makes it fast enough to be a required
// CI job, and it is why throwVelocity (imports three) and transferLedger (imports
// svelte/store) are NOT in this first cut: padding the list with modules that need a
// runtime is how a "unit" suite turns into a slow, flaky second e2e suite.
export default defineConfig({
	// 34 R6: `$lib` resolves as it does in the app, so a suite may import the module SDK and
	// the registries its members write to (tests/unit/moduleLifecycle.test.js)
	resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
	test: {
		include: ['tests/unit/**/*.test.js'],
		// node, not jsdom: every module in this layer imports NOTHING, which is the
		// entry requirement. A test that needs a DOM belongs in tests/e2e.
		environment: 'node'
	}
});
