// 34 B3 — scene-lint's rules (scripts/scene-lint.cjs), each PLANTED in a minimal session and each
// silent on the clean one — the counterfactual per rule. The catalogs are read from core's own
// sources, so these also fail if a catalog moves and the extraction stops finding it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const lint = require('../../scripts/scene-lint.cjs');
const { zipSync, strToU8 } = require('fflate');

const M = (x = 0, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const box = (name, at, size = [1, 1, 1], extra = {}) => ({
	metadata: { version: 4.7, type: 'Object' },
	geometries: [{ uuid: 'g-' + name, type: 'BoxGeometry', width: size[0], height: size[1], depth: size[2] }],
	object: { uuid: 'u-' + name, type: 'Mesh', name, layers: 1, matrix: M(...at), geometry: 'g-' + name, userData: {}, ...extra }
});
const clean = () => ({
	format: 1,
	objects: [box('floor', [0, -0.05, 0], [20, 0.1, 20]), box('crate', [3, 0.5, 0])],
	graphs: { scene: { nodes: [{ id: 'k', type: 'keypress', data: { code: 'Space' } }, { id: 's', type: 'script', data: { code: 'return inputs.a * 2;' } }], edges: [] } },
	environment: { preset: 'daylight' },
	physics: { play: { spawn: { position: [0, 0, 4], yaw: 0 }, bounds: { min: [-10, -1, -10], max: [10, 5, 10] } } }
});
const rules = (session, opts) => lint.lintSession(session, opts).filter((f) => f.severity !== 'info').map((f) => `${f.severity}:${f.rule}`);

describe('the catalogs come from core', () => {
	it('node types: the renderer table, the palette and the docs', () => {
		const t = lint.coreNodeTypes();
		for (const k of ['keypress', 'script', 'hudscreen', 'customnode', 'charcontroller', 'setgamestate']) expect(t.has(k)).toBe(true);
		expect(t.size).toBeGreaterThan(90);
	});
	it('environment presets + custom', () => {
		expect([...lint.envPresets()].sort()).toEqual(expect.arrayContaining(['custom', 'studio', 'daylight', 'sunset', 'night']));
	});
	it('the helper layer is not an XR eye layer', () => {
		expect(lint.HELPER_LAYER).toBeGreaterThan(2);
	});
});

describe('lintSession', () => {
	it('a clean scene has no findings', () => {
		expect(rules(clean())).toEqual([]);
	});
	it('node-unknown: a type nothing knows, no module declared', () => {
		const s = clean();
		s.graphs.scene.nodes.push({ id: 'x', type: 'wobblify', data: {} });
		expect(rules(s)).toEqual(['error:node-unknown']);
		// ...but with a declared module it is the module's (an info line, not an error)
		s.modules = [{ id: 'wobble', version: '1.0.0' }];
		expect(rules(s)).toEqual([]);
		expect(lint.lintSession(s).some((f) => f.rule === 'node-module' && /wobblify/.test(f.message))).toBe(true);
	});
	it('customnode-def: a custom def no declared module owns', () => {
		const s = clean();
		s.modules = [{ id: 'waves', version: '2.2.0' }];
		s.graphs.scene.nodes.push({ id: 'c', type: 'customnode', data: { defId: 'mod-waves-turret' } });
		expect(rules(s)).toEqual([]);
		s.graphs.scene.nodes.push({ id: 'd', type: 'customnode', data: { defId: 'user-1234' } });
		expect(rules(s)).toEqual(['warn:customnode-def']);
	});
	it('object-type: a three type ObjectLoader does not know', () => {
		const s = clean();
		s.objects[1].object.type = 'Cone';
		expect(rules(s)).toContain('error:object-type');
	});
	it('env-unknown: "dusk" (falls back to studio silently), and custom with no payload', () => {
		const s = clean();
		s.environment.preset = 'dusk';
		expect(rules(s)).toEqual(['error:env-unknown']);
		s.environment = { preset: 'custom' };
		expect(rules(s)).toEqual(['error:env-unknown']);
		s.environment = { preset: 'custom', customPreset: { base: 'night' } };
		expect(rules(s)).toEqual([]);
	});
	it('layer-helper: an object saved on the helper layer', () => {
		const s = clean();
		s.objects[1].object.layers = 1 | (1 << lint.HELPER_LAYER);
		expect(rules(s)).toEqual(['error:layer-helper']);
	});
	it('layer-one-eye: layer 1 (left eye) or 2 (right eye) without layer 0; a child counts too', () => {
		const s = clean();
		s.objects[1].object.layers = 0b10;
		expect(rules(s)).toEqual(['error:layer-one-eye']);
		s.objects[1].object.layers = 0b11; // on layer 0 as well: both eyes see it
		expect(rules(s)).toEqual([]);
		s.objects[1].object.children = [{ uuid: 'kid', type: 'Mesh', name: 'kid', layers: 0b100, matrix: M(), geometry: 'g-crate' }];
		expect(rules(s)).toEqual(['error:layer-one-eye']);
	});
	it('spawn-bounds: the spawn outside play.bounds', () => {
		const s = clean();
		s.physics.play.spawn.position = [0, 0, 12];
		expect(rules(s)).toEqual(['error:spawn-bounds']);
	});
	it('spawn-collider: the player body inside a box is an error; inside a mesh/kit box a warning', () => {
		const s = clean();
		s.objects.push(box('wall', [0, 1.5, 4], [4, 3, 0.4]));
		expect(rules(s)).toEqual(['error:spawn-collider']);
		// a sensor is no collider
		s.objects[2].object.userData = { physics: { sensor: true } };
		expect(rules(s)).toEqual([]);
		// a kit piece only has its bounding box (it may be a doorway): a warning
		const s2 = clean();
		s2.objects.push({ object: { uuid: 'arch', type: 'Group', name: 'Arch', layers: 1, matrix: M(0, 0, 4), userData: { packRef: { pack: 'architecture-kit', item: 'Arch', path: 'x.glb', box: [-1.5, 0, -0.3, 1.5, 3, 0.3] } } } });
		expect(rules(s2)).toEqual(['warn:spawn-collider']);
		// standing ON the floor is not inside it
		expect(rules(clean())).toEqual([]);
	});
	it('shell-duplicate: a pause menu of the graph\'s own', () => {
		const s = clean();
		s.graphs.scene.nodes.push({ id: 'p', type: 'hudscreen', data: { screen: 'pause', action: 'toggle' } });
		expect(rules(s)).toEqual(['warn:shell-duplicate']);
		const s2 = clean();
		s2.graphs.scene.nodes.push({ id: 'q', type: 'setgamestate', data: { state: 'paused' } });
		expect(rules(s2)).toEqual(['warn:shell-duplicate']);
	});
	it('script-nondeterministic: Math.random, Date.now, new Date, performance.now, storage', () => {
		for (const code of ['return Math.random();', 'return Date.now() % 2;', 'const d = new Date();', 'return performance.now();', 'localStorage.x = 1']) {
			const s = clean();
			s.graphs.scene.nodes[1].data.code = code;
			expect(rules(s)).toEqual(['error:script-nondeterministic']);
		}
	});
	it('a per-object graph is linted too', () => {
		const s = clean();
		s.graphs['u-crate'] = { nodes: [{ id: 'z', type: 'script', data: { code: 'Math.random()' } }], edges: [] };
		expect(rules(s)).toEqual(['error:script-nondeterministic']);
	});
	it('budget-static: more than 150 separately drawn meshes', () => {
		const s = clean();
		for (let i = 0; i < 150; i++) s.objects.push(box('b' + i, [i % 10, 0.5, -5 - Math.floor(i / 10)], [0.5, 0.5, 0.5]));
		expect(rules(s)).toEqual(['warn:budget-static']);
	});
});

describe('kit pieces against a packs checkout', () => {
	// a minimal packs tree: one pack, one GLB with 3000 tris and a double-sided material
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-packs-'));
	const glb = (tris, doubleSided) => {
		const json = Buffer.from(
			JSON.stringify({
				asset: { version: '2.0' },
				nodes: [{ mesh: 0 }],
				meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
				accessors: [{ count: 3 }, { count: tris * 3 }],
				materials: [{ name: 'm', doubleSided }]
			}).padEnd(4 * Math.ceil(10000 / 4))
		);
		const head = Buffer.alloc(20);
		head.writeUInt32LE(0x46546c67, 0);
		head.writeUInt32LE(2, 4);
		head.writeUInt32LE(20 + json.length, 8);
		head.writeUInt32LE(json.length, 12);
		head.writeUInt32LE(0x4e4f534a, 16);
		return Buffer.concat([head, json]);
	};
	fs.writeFileSync(path.join(dir, 'index.json'), '[]');
	fs.mkdirSync(path.join(dir, 'kit', 'Big', 'glTF-Binary'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'kit', 'Door', 'glTF-Binary'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'kit', 'Big', 'glTF-Binary', 'big.glb'), glb(3000, true));
	fs.writeFileSync(path.join(dir, 'kit', 'Door', 'glTF-Binary', 'door.glb'), glb(500, false));
	fs.writeFileSync(
		path.join(dir, 'kit', 'default.json'),
		JSON.stringify([
			{ name: 'Big', variants: {} },
			{ name: 'Door', variants: {}, behavior: { type: 'door', clip: 'Open', trigger: 'click' } }
		])
	);
	const packs = lint.makePackIndex(dir);
	const piece = (item, file, at) => ({ object: { uuid: 'p-' + item, type: 'Group', name: item, layers: 1, matrix: M(...at), userData: { packRef: { pack: 'kit', item, path: `kit/${item}/glTF-Binary/${file}`, box: [-0.2, 0, -0.2, 0.2, 1, 0.2] } } } });

	it('the GLB reader counts triangles and double-sided materials', () => {
		expect(lint.glbInfo(path.join(dir, 'kit', 'Big', 'glTF-Binary', 'big.glb'))).toEqual({ tris: 3000, doubleSided: ['m'] });
	});
	it('pack-lod-missing: a heavy piece without LODs (and its double-sided summary)', () => {
		const s = clean();
		s.objects.push(piece('Big', 'big.glb', [5, 0, 5]));
		expect(rules(s, { packs })).toEqual(['warn:pack-lod-missing']);
		expect(lint.lintSession(s, { packs }).some((f) => f.rule === 'pack-flicker' && /double-sided/.test(f.message))).toBe(true);
	});
	it('pack-behavior: a row behavior normalizeBehavior rejects', () => {
		const s = clean();
		s.objects.push(piece('Door', 'door.glb', [5, 0, 5]));
		expect(rules(s, { packs })).toEqual([]);
		const rows = JSON.parse(fs.readFileSync(path.join(dir, 'kit', 'default.json'), 'utf8'));
		rows[1].behavior = { type: 'teleporter', trigger: 'click' };
		fs.writeFileSync(path.join(dir, 'kit', 'default.json'), JSON.stringify(rows));
		expect(rules(s, { packs: lint.makePackIndex(dir) })).toEqual(['error:pack-behavior']);
	});
	it('without a packs checkout the kit rules say they were skipped', () => {
		const s = clean();
		s.objects.push(piece('Big', 'big.glb', [5, 0, 5]));
		expect(lint.lintSession(s).some((f) => f.rule === 'pack-data')).toBe(true);
	});
});

describe('lintDef (the authoring def — what the saved file can no longer show)', () => {
	it('an unknown env preset in a def is an error (the author path would save studio)', () => {
		expect(lint.lintDef({ slug: 'x', env: 'dusk' }).map((f) => f.rule)).toEqual(['env-unknown']);
		expect(lint.lintDef({ slug: 'x', env: { preset: 'dusk', exposure: 1 } }).map((f) => f.rule)).toEqual(['env-unknown']);
		expect(lint.lintDef({ slug: 'x', env: { preset: 'custom', base: 'dawn' } }).map((f) => f.rule)).toEqual(['env-unknown']);
		expect(lint.lintDef({ slug: 'x', env: { preset: 'custom', base: 'night', fog: {} } })).toEqual([]);
		expect(lint.lintDef({ slug: 'x', env: 'sunset' })).toEqual([]);
		expect(lint.lintDef({ slug: 'x' })).toEqual([]);
	});
	it('every committed authoring def passes', () => {
		const { LEVEL_DEFS } = require('../../scripts/level-templates.cjs');
		for (const d of LEVEL_DEFS) expect(lint.lintDef(d)).toEqual([]);
	});
});

describe('lintBytes', () => {
	it('reads a .tpscene zip', () => {
		const s = clean();
		s.environment.preset = 'dusk';
		const bytes = zipSync({ 'session.json': strToU8(JSON.stringify(s)), 'assets/index.json': strToU8('[]') });
		expect(lint.lintBytes(bytes).map((f) => f.rule)).toContain('env-unknown');
	});
});
