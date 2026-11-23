import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { runChecks, summarize } from '../../src/lib/export/checkCore.js';
import { SCENE_RULES, layerProblem, PUBLISH_MAX_BYTES, TEXTURE_MAX_PX } from '../../src/lib/export/sceneChecks.js';

const require = createRequire(import.meta.url);
const lint = require('../../scripts/scene-lint.cjs');

/** @param {any} scene @param {any} [extra] */
const check = (scene, extra = {}) => runChecks(SCENE_RULES, { target: 'publish', scene, ...extra });
const ids = (/** @type {any[]} */ rows) => rows.map((r) => r.id);

describe('sceneChecks (63-publish row 13)', () => {
	it('an empty scene has nothing to say', async () => {
		expect(await check({})).toEqual([]);
	});

	it('bundle over the publish limit: error with the biggest parts, shrink offered only when a texture is large', async () => {
		const rows = await check({ bundleBytes: PUBLISH_MAX_BYTES + 1, biggest: [{ label: 'song.mp3', bytes: 9e6 }] });
		expect(rows[0]).toMatchObject({ id: 'scene-bundle-size', severity: 'error', items: [{ label: 'song.mp3' }] });
		expect(rows[0].fix).toBeUndefined();
		const withTex = await check({ bundleBytes: 3e7, textures: [{ uuid: 'u', name: 'Floor', width: 4096, height: 4096 }] });
		expect(withTex.find((r) => r.id === 'scene-bundle-size')?.fix?.name).toBe('scene-shrink-textures');
		// the export doors measure their own zip (63-export): the publish size rule stays out
		expect(await runChecks(SCENE_RULES, { target: 'itch', scene: { bundleBytes: 3e7 } })).toEqual([]);
		// and it never blocks publishing
		expect(summarize(rows, 'publish').blocking).toBe(0);
	});

	it('textures over 2048 px, each a select item, one fix', async () => {
		const rows = await check({ textures: [{ uuid: 'a', name: 'Wall', width: 4096, height: 1024 }, { uuid: 'b', name: 'Ok', width: TEXTURE_MAX_PX, height: TEXTURE_MAX_PX }] });
		expect(ids(rows)).toEqual(['scene-texture-large']);
		expect(rows[0].items).toEqual([{ label: 'Wall (4096 x 1024)', where: 'a' }]);
		expect(rows[0].fix?.name).toBe('scene-shrink-textures');
	});

	it('a game with no spawn point (not a dungeon, not a plain scene)', async () => {
		expect(ids(await check({ isGame: true }))).toEqual(['scene-no-spawn']);
		expect(await check({ isGame: true, dungeon: true })).toEqual([]);
		expect(await check({ isGame: false })).toEqual([]);
		expect(await check({ isGame: true, spawn: { position: [0, 0, 0] } })).toEqual([]);
	});

	it('touch: a game for phones with keys no button presses; phone defaults on for publish only', async () => {
		const scene = { isGame: true, spawn: { position: [0, 0, 0] }, touch: { uncovered: ['F', 'G'] } };
		expect((await check(scene))[0]).toMatchObject({ id: 'scene-touch-missing', fix: { name: 'scene-touch-layout' } });
		expect(await check(scene, { phone: false })).toEqual([]);
		expect(await runChecks(SCENE_RULES, { target: 'crazygames', scene })).toEqual([]);
		expect(ids(await runChecks(SCENE_RULES, { target: 'crazygames', phone: true, scene }))).toEqual(['scene-touch-missing']);
	});

	it('modules a visitor will lack: user-installed and not in the gallery; unknown gallery says nothing', async () => {
		const scene = { modules: [{ id: 'mine', name: 'My mod', user: true, inGallery: false }, { id: 'pub', user: true, inGallery: true }, { id: 'core', user: false, inGallery: false }, { id: 'unk', user: true, inGallery: null }] };
		const rows = await check(scene);
		expect(ids(rows)).toEqual(['scene-module-missing']);
		expect(rows[0].title).toContain('My mod');
		expect(await runChecks(SCENE_RULES, { target: 'itch', scene })).toEqual([]);
	});

	it('missing asset bytes', async () => {
		const rows = await check({ assets: [{ name: 'boom.wav', kind: 'audio', hash: 'h1', missing: true }, { name: 'ok.png', kind: 'image', hash: 'h2', missing: false }] });
		expect(rows[0]).toMatchObject({ id: 'scene-asset-missing', fix: { name: 'scene-fetch-assets' } });
		expect(rows[0].title).toContain('boom.wav');
	});

	it('HELPER_LAYER is the one helperLayer.js exports', () => {
		const src = fs.readFileSync(new URL('../../src/lib/helperLayer.js', import.meta.url), 'utf8');
		expect(Number(/export const HELPER_LAYER = (\d+)/.exec(src)?.[1])).toBe(lint.HELPER_LAYER);
		expect(layerProblem(1 << lint.HELPER_LAYER)).toBe('helper');
	});

	// REUSE: the three author-kit lint rules give the same verdict as scripts/scene-lint.cjs
	it('parity with scene-lint: script-nondeterministic, spawn-bounds, layer-helper / layer-one-eye', async () => {
		const masks = [1, 1 << 30, 2, 4, 6, 3, 7, (1 << 30) | 1];
		for (const mask of masks) {
			const session = { objects: [{ object: { uuid: 'x' + mask, type: 'Object3D', name: 'o', layers: mask } }] };
			const lintHit = lint.lintSession(session).some((/** @type {any} */ f) => f.rule === 'layer-helper' || f.rule === 'layer-one-eye');
			expect([mask, !!layerProblem(mask)]).toEqual([mask, lintHit]);
		}
		for (const code of ['return Math.random()', 'const t = Date.now()', 'return a + b', 'localStorage.x']) {
			const session = { graphs: { scene: { nodes: [{ id: 's1', type: 'script', data: { code } }], edges: [] } } };
			const lintHit = lint.lintSession(session).some((/** @type {any} */ f) => f.rule === 'script-nondeterministic');
			const ours = (await check({ scripts: [{ id: 's1', code, graph: 'scene' }] })).some((r) => r.id === 'scene-script-random');
			expect([code, ours]).toEqual([code, lintHit]);
		}
		for (const pos of [[0, 0, 0], [50, 0, 0], [0, -9, 0]]) {
			const bounds = { min: [-10, -1, -10], max: [10, 10, 10] };
			const session = { physics: { play: { spawn: { position: pos }, bounds } } };
			const lintHit = lint.lintSession(session).some((/** @type {any} */ f) => f.rule === 'spawn-bounds');
			const ours = (await check({ spawn: { position: pos }, bounds })).some((r) => r.id === 'scene-spawn-bounds');
			expect([pos, ours]).toEqual([pos, lintHit]);
		}
	});
});
