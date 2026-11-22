// @ts-nocheck -- fixture test: stubbed modules and loose mocks
// 54i (fix-batch-3 a): @threlte/xr's headset task must SKIP a frame when three has no XR frame
// (getFrame() === null after the session ended) instead of throwing
// "Cannot read properties of null (reading 'getViewerPose')". Runs the REAL dist file through the
// vite transform and calls its task with a null frame.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { guardThrelteXrSource } = require('../../scripts/guard-threlte-xr.cjs');

const HEADSET = new URL('../../node_modules/@threlte/xr/dist/internal/setupHeadset.svelte.js', import.meta.url).pathname;
const HITTEST = HEADSET.replace('internal/setupHeadset.svelte.js', 'hooks/useHitTest.svelte.js');

/** Load setupHeadset from source with its imports stubbed; return the task callbacks it registers. */
function headsetTasks(code, xr) {
	const body = code
		.replace(/^import[^;]+;$/gm, '')
		.replace('export const headset', 'const headset')
		.replace('export const setupHeadset', 'const setupHeadset');
	/** @type {Function[]} */
	const tasks = [];
	class V { copy() { return this; } }
	class M { fromArray() { return this; } premultiply() { return this; } decompose() {} }
	const factory = new Function(
		'Group', 'Matrix4', 'Vector3', 'useThrelte', 'useTask', 'useStage', 'isPresenting', 'useXROrigin',
		body + '\nreturn setupHeadset;'
	);
	const setup = factory(
		class { position = new V(); quaternion = new V(); },
		M,
		V,
		() => ({ renderer: { xr }, camera: { current: {} }, renderStage: {} }),
		(/** @type {Function} */ fn) => tasks.push(fn),
		() => ({}),
		{ current: true },
		() => ({ current: undefined })
	);
	setup();
	return tasks;
}

describe('guard-threlte-xr', () => {
	const src = readFileSync(HEADSET, 'utf8');

	it('the unguarded dist still throws on a null frame (the premise)', () => {
		const [task] = headsetTasks(src, { getReferenceSpace: () => ({}), getFrame: () => null });
		expect(() => task()).toThrow(/getViewerPose/);
	});

	it('the transformed headset task skips a null frame', () => {
		const res = guardThrelteXrSource(src, HEADSET);
		expect(res?.missing).toEqual([]);
		const [task] = headsetTasks(res.code, { getReferenceSpace: () => ({}), getFrame: () => null });
		expect(() => task()).not.toThrow();
	});

	it('the transformed headset task still reads a live pose', () => {
		const res = guardThrelteXrSource(src, HEADSET);
		let asked = 0;
		const frame = { getViewerPose: () => (asked++, { transform: { position: {}, orientation: {} } }) };
		const [task] = headsetTasks(res.code, { getReferenceSpace: () => ({}), getFrame: () => frame });
		task();
		expect(asked).toBe(1);
	});

	it('the hit-test task anchor matches the installed version', () => {
		const res = guardThrelteXrSource(readFileSync(HITTEST, 'utf8'), HITTEST);
		expect(res?.missing).toEqual([]);
		expect(res.code).toContain('xr.getFrame()?.getHitTestResults(hitTestSource) ?? []');
	});

	it('leaves other modules alone', () => {
		expect(guardThrelteXrSource('x', '/node_modules/three/src/x.js')).toBeNull();
		expect(guardThrelteXrSource('x', '/node_modules/@threlte/xr/dist/other.js')).toBeNull();
	});
});
