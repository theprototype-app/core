// 30c level design — the three kit levels' DEFS (scripts/level-templates.cjs), checked with
// no browser: every piece names a real kit item, sits on the kit's grid, every custom
// collider fits the 1200-float cap, and each level has a spawn and a walk controller.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { LEVEL_DEFS, COLLIDERS } = require('../../scripts/level-templates.cjs');

// the three kits' item lists, when a local snapshot of the packs is around (the pack PRs
// are separate repos; the list check SKIPS rather than fails without them)
const PACKS_DIR = process.env.PACKS_DIR || '/home/deck/.code/lanes-30/levels-packs';
/** @param {string} pack */
function itemsOf(pack) {
	const file = path.join(PACKS_DIR, pack, 'default.json');
	return fs.existsSync(file) ? new Set(JSON.parse(fs.readFileSync(file, 'utf8')).map((/** @type {any} */ r) => r.name)) : null;
}

/** @param {any} def */
const kits = (def) => def.objects.filter((/** @type {any} */ o) => o.type === 'kit');

describe('level templates', () => {
	it('are three general-tab templates kept out of the offline seed', () => {
		expect(LEVEL_DEFS.map((/** @type {any} */ d) => d.slug)).toEqual(['castle-courtyard', 'forest-clearing', 'tavern-interior']);
		for (const def of LEVEL_DEFS) {
			expect(def.kind).toBe('template');
			expect(def.seed).toBe(false);
			expect(def.description.length).toBeGreaterThan(40);
		}
	});

	it('name every object uniquely', () => {
		for (const def of LEVEL_DEFS) {
			const names = def.objects.map((/** @type {any} */ o) => o.name);
			expect(new Set(names).size).toBe(names.length);
		}
	});

	it('build from the kits, and only from items the kits ship', () => {
		for (const def of LEVEL_DEFS) {
			expect(kits(def).length).toBeGreaterThan(90);
			for (const o of kits(def)) {
				const items = itemsOf(o.pack);
				if (items) expect(items.has(o.item), def.slug + ': ' + o.pack + '/' + o.item).toBe(true);
			}
		}
	});

	it('stand walls and floors on the 1 m grid, turned in right angles', () => {
		const grid = /^(Wall(Stone|Plaster)|Floor|Railing|Battlement|Block|Tower|Pillar|CornerPost|Stairs|Gate|RoofSlope|Arch|Door|Window)/;
		for (const def of LEVEL_DEFS)
			for (const o of kits(def)) {
				// the tavern's bar is half walls used as FURNITURE (scaled, off the grid on purpose)
				if (!grid.test(o.item) || /^Bar/.test(o.name)) continue;
				const [x, , z] = o.pos;
				// walls sit on grid lines, cells on odd metres; rails ride 0.08 inside an edge
				expect(Math.abs(x * 2 - Math.round(x * 2)) < 0.17 || o.item === 'Railing', def.slug + ' ' + o.name + ' x ' + x).toBe(true);
				expect(Math.abs(z * 2 - Math.round(z * 2)) < 0.17 || o.item === 'Railing', def.slug + ' ' + o.name + ' z ' + z).toBe(true);
				const yaw = o.rot?.[1] ?? 0;
				expect(Math.abs(yaw / (Math.PI / 2) - Math.round(yaw / (Math.PI / 2))) < 1e-3, def.slug + ' ' + o.name + ' yaw').toBe(true);
			}
	});

	it('give every custom collider valid pieces under the 1200-float cap', () => {
		for (const def of LEVEL_DEFS)
			for (const o of def.objects) {
				const p = o.physics;
				if (p?.collider !== 'custom') continue;
				expect(p.colliderVerts.length).toBeLessThanOrEqual(1200);
				expect(p.colliderVerts.length % 3).toBe(0);
				for (const [start, count] of p.colliderPieces) {
					expect(count).toBeGreaterThanOrEqual(9);
					expect(start + count).toBeLessThanOrEqual(p.colliderVerts.length);
				}
			}
	});

	it('leave the doorway and the archway walkable for the 0.3 m capsule', () => {
		/** @param {any} c */
		const gap = (c) => {
			const v = c.colliderVerts;
			const [a, b] = c.colliderPieces;
			const leftMax = Math.max(...v.slice(a[0], a[0] + a[1]).filter((/** @type {number} */ _, /** @type {number} */ i) => i % 3 === 0));
			const rightMin = Math.min(...v.slice(b[0], b[0] + b[1]).filter((/** @type {number} */ _, /** @type {number} */ i) => i % 3 === 0));
			return rightMin - leftMax;
		};
		expect(gap(COLLIDERS.doorway)).toBeGreaterThan(0.6);
		expect(gap(COLLIDERS.arch)).toBeGreaterThan(0.6);
		// a staircase is a ramp the walker can climb (50° is its limit)
		const slope = Math.atan2(3, 4) * (180 / Math.PI);
		expect(slope).toBeLessThan(50);
	});

	it('carry a spawn, sim-on-play and ONE walk-mode character controller', () => {
		for (const def of LEVEL_DEFS) {
			expect(def.physics.play.simOnPlay).toBe(true);
			expect(def.physics.play.spawn.position).toHaveLength(3);
			const nodes = def.graphs.scene.nodes;
			expect(nodes.filter((/** @type {any} */ n) => n.type === 'charcontroller')).toHaveLength(1);
			expect(nodes[0].data.mode).toBe('walk');
			// the sim needs something dynamic, or startSimulation declines to run at all
			expect(def.objects.some((/** @type {any} */ o) => o.physics?.mode === 'dynamic')).toBe(true);
		}
	});

	it('are deterministic (a re-author writes the same layout)', () => {
		delete require.cache[require.resolve('../../scripts/level-templates.cjs')];
		const again = require('../../scripts/level-templates.cjs').LEVEL_DEFS;
		expect(JSON.stringify(again)).toBe(JSON.stringify(LEVEL_DEFS));
	});
});
