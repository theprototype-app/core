// 34 R6 (contract T2): EVERY registration a module makes has a teardown path. The SDK surface
// is enumerated from the ONE table (src/lib/sdk/index.js) against each slice's declaration
// (`sdkX.surface`), and every member declared 'registers' is proven by a fixture: register it
// from inside a real module, see core's registry hold it, unloadModule, see it gone, journal
// empty. The fixtures live in tests/fixtures/sdkLifecycleFixtures.js, shared with the browser
// suite (module-lifecycle), which runs the members node cannot load (the .svelte.js family).
import { describe, test, expect, beforeAll } from 'vitest';
import '../fixtures/sdkLifecycleFixtures.js';
import { lifecycleEnv } from '../../src/lib/sdk/lifecycleEnv.js';

/** @type {any} */ let env;
/** @type {any} */ let run;
const LC = /** @type {any} */ (globalThis).__sdkLifecycle;

beforeAll(async () => {
	env = await lifecycleEnv();
	run = await LC.runContract(env);
}, 60000);

describe('module lifecycle contract (T2)', () => {
	test('every SDK slice declares its surface', () => {
		expect(run.surface.noSurface).toEqual([]);
		expect(run.surface.members).toBeGreaterThan(150);
	});
	test('every member is declared, with a known kind, and no declaration is stale', () => {
		expect(run.surface.undeclared).toEqual([]);
		expect(run.surface.badKind).toEqual([]);
		expect(run.surface.stale).toEqual([]);
	});
	test("every 'registers' member has a teardown fixture", () => {
		expect(run.missingFixture).toEqual([]);
		expect(run.surface.registers.length).toBeGreaterThan(50);
	});
	test('every runnable fixture: journaled, visible in core, gone after unloadModule, journal empty', () => {
		const failed = Object.entries(run.results)
			.filter(([, r]) => !r.skipped && !r.ok)
			.map(([path, r]) => path + ' ' + JSON.stringify(r));
		expect(failed).toEqual([]);
	});
	test('node runs the bulk of them; only the browser-bound ones are left to the e2e', () => {
		const ran = Object.values(run.results).filter((r) => !r.skipped).length;
		const skipped = Object.entries(run.results)
			.filter(([, r]) => r.skipped)
			.map(([path, r]) => path + ' (' + r.skipped + ')');
		// the list is printed so a newly skipped member is noticed in review
		console.log('[module lifecycle] ran ' + ran + ' in node; browser-only: ' + skipped.join('; '));
		expect(ran).toBeGreaterThan(30);
	});
});
