// 34 R2 (kit-entities): the pure halves of kit.health and kit.spawner v2 — hit points, the
// entity store, the ONE `kitentity` wire message and its wireValidate shape.
import { describe, it, expect } from 'vitest';
import {
	createHealth,
	damage,
	heal,
	revive,
	hpAt,
	fraction
} from '../../src/lib/kit/healthCore.js';
import {
	createEntityStore,
	spawnEntity,
	despawnEntity,
	flushMessage,
	snapshotMessage,
	applyEntityMessage,
	adoptAuthority,
	renderPos,
	cleanTags,
	cleanData,
	KIT_ENTITY_CEILING
} from '../../src/lib/kit/entityCore.js';
import {
	validateWireMessage,
	isKitEntityRecord,
	KIT_ENTITY_MAX_ROWS
} from '../../src/lib/wireValidate.js';
import { readFileSync } from 'node:fs';

describe('kit.health core', () => {
	it('damage, death, the overkill guard and armor', () => {
		const h = createHealth({ max: 30, armor: 2 });
		expect(damage(h, 12, 1, 'p1')).toEqual({ applied: 10, died: false });
		expect(h.hp).toBe(20);
		expect(damage(h, 50, 2, 'p2')).toEqual({ applied: 20, died: true });
		expect(h.dead).toBe(true);
		expect(h.by).toBe('p2');
		// a dead entity takes nothing (the health module's engine.js:163 guard)
		expect(damage(h, 5, 3)).toEqual({ applied: 0, died: false });
		expect(heal(h, 5, 3)).toBe(0); // heal is not revive
		revive(h, 4);
		expect(h.dead).toBe(false);
		expect(h.hp).toBe(30);
	});

	it('refuses junk amounts', () => {
		const h = createHealth({ max: 10 });
		for (const a of [NaN, -5, 0, Infinity, '7x'])
			expect(damage(h, /** @type {any} */ (a), 1).applied).toBe(0);
		expect(h.hp).toBe(10);
	});

	it('regen is a pure function of the stamp, folded on every write (never double-counted)', () => {
		const h = createHealth({ max: 100, regen: 2 });
		damage(h, 50, 10);
		expect(hpAt(h, 10)).toBe(50);
		expect(hpAt(h, 15)).toBe(60);
		damage(h, 10, 15); // folds the 10 regen first
		expect(hpAt(h, 15)).toBe(50);
		expect(hpAt(h, 1000)).toBe(100); // capped at max
		expect(fraction(h, 15)).toBe(0.5);
	});
});

describe('entity store + the kitentity wire', () => {
	it('spawn -> flush -> apply puts the same entities on the receiver, with events', () => {
		const a = createEntityStore();
		const b = createEntityStore();
		const e = spawnEntity(
			a,
			{
				kind: 'robot',
				tpl: 'tpl-uuid',
				pos: [1, 0, 2],
				hp: 30,
				tags: ['enemy', 'grunt'],
				data: { lane: 2 }
			},
			5
		);
		const msg = flushMessage(a, 5);
		expect(validateWireMessage(msg)).toBe(true);
		const out = applyEntityMessage(b, msg, 'host', 'host');
		expect(out?.spawned.map((x) => x.id)).toEqual([e?.id]);
		const r = b.ents.get(/** @type {string} */ (e?.id));
		expect(r?.kind).toBe('robot');
		expect(r?.pos).toEqual([1, 0, 2]);
		expect(r?.health.hp).toBe(30);
		expect(r?.tags).toEqual(['enemy', 'grunt']);
		expect(r?.data).toEqual({ lane: 2 });
		// nothing changed: no message
		expect(flushMessage(a, 6)).toBeNull();
	});

	it('pose + hp travel as compact rows; damage / death / despawn become receiver events', () => {
		const a = createEntityStore();
		const b = createEntityStore();
		const e = /** @type {any} */ (spawnEntity(a, { pos: [0, 0, 0], hp: 20 }, 0));
		applyEntityMessage(b, flushMessage(a, 0), 'h', 'h');
		e.pos[0] = 3;
		damage(e.health, 5, 1);
		a.moved.add(e.id);
		const m1 = flushMessage(a, 1);
		expect(m1.put).toBeUndefined();
		expect(m1.upd).toEqual([[e.id, 3, 0, 0, 0, 15, 0]]);
		const o1 = applyEntityMessage(b, m1, 'h', 'h');
		expect(o1?.damaged.map((d) => d.amount)).toEqual([5]);
		damage(e.health, 50, 2);
		e.dead = true;
		a.moved.add(e.id);
		const o2 = applyEntityMessage(b, flushMessage(a, 2), 'h', 'h');
		expect(o2?.died.map((x) => x.id)).toEqual([e.id]);
		despawnEntity(a, e.id);
		const o3 = applyEntityMessage(b, flushMessage(a, 3), 'h', 'h');
		expect(o3?.removed.map((x) => x.id)).toEqual([e.id]);
		expect(b.ents.size).toBe(0);
	});

	it('ONE WRITER: a message from anyone but the authority is refused; a stale seq is refused', () => {
		const a = createEntityStore();
		const b = createEntityStore();
		spawnEntity(a, {}, 0);
		const m = flushMessage(a, 0);
		expect(applyEntityMessage(b, m, 'mallory', 'host')).toBeNull();
		expect(b.ents.size).toBe(0);
		expect(applyEntityMessage(b, m, 'host', 'host')).not.toBeNull();
		expect(applyEntityMessage(b, m, 'host', 'host')).toBeNull(); // a duplicate
	});

	it('a snapshot replaces the whole set (what it does not name is gone)', () => {
		const a = createEntityStore();
		const b = createEntityStore();
		const x = /** @type {any} */ (spawnEntity(a, {}, 0));
		spawnEntity(a, {}, 0);
		applyEntityMessage(b, flushMessage(a, 0), 'h', 'h');
		despawnEntity(a, x.id);
		a.removed.clear(); // the del is LOST (a message that never arrived)
		const out = applyEntityMessage(b, snapshotMessage(a, 1), 'h', 'h');
		expect(out?.removed.map((r) => r.id)).toEqual([x.id]);
		expect([...b.ents.keys()]).toEqual([...a.ents.keys()]);
	});

	it(`the ceiling is ${KIT_ENTITY_CEILING} and is the SAME number as spawner.js's SPAWN_HARD_CEILING`, () => {
		const src = readFileSync(new URL('../../src/lib/spawner.js', import.meta.url), 'utf8');
		const m = /SPAWN_HARD_CEILING = (\d+)/.exec(src);
		expect(Number(m?.[1])).toBe(KIT_ENTITY_CEILING);
		const s = createEntityStore();
		for (let i = 0; i < KIT_ENTITY_CEILING; i++) expect(spawnEntity(s, {}, 0)).not.toBeNull();
		expect(spawnEntity(s, {}, 0)).toBeNull();
		expect(s.refused).toBe(1);
	});

	it('a peer that BECOMES the authority never mints an id that exists, and rebuilds movers', () => {
		const a = createEntityStore();
		const b = createEntityStore();
		for (let i = 0; i < 5; i++) spawnEntity(a, { mover: { speed: 3 } }, 0);
		applyEntityMessage(b, flushMessage(a, 0), 'h', 'h');
		adoptAuthority(b, 1);
		const fresh = spawnEntity(b, {}, 1);
		expect(a.ents.has(/** @type {string} */ (fresh?.id))).toBe(false);
		for (const e of b.ents.values()) if (e.mv) expect(e.mover?.speed).toBe(3);
	});

	it('tags and data are bounded', () => {
		expect(cleanTags(['a', 'a', 'b', 7, '', 'x'.repeat(40)])).toEqual(['a', 'b', 'x'.repeat(32)]);
		expect(cleanTags(Array.from({ length: 20 }, (_, i) => 't' + i)).length).toBe(8);
		expect(cleanData({ big: 'x'.repeat(2000) })).toEqual({});
		expect(cleanData([1, 2])).toEqual({});
	});

	it('receivers ease between poses (golden rule 11) and snap a teleport', () => {
		/** @type {any} */
		const e = { pos: [1, 0, 0], prev: [0, 0, 0], prevAt: 0, at: 0.1 };
		expect(renderPos(e, 0.1)[0]).toBeCloseTo(0);
		expect(renderPos(e, 0.15)[0]).toBeCloseTo(0.5);
		expect(renderPos(e, 0.5)[0]).toBeCloseTo(1);
		e.pos = [9, 0, 0];
		expect(renderPos(e, 0.1)[0]).toBe(9);
	});
});

describe('wireValidate: kitentity', () => {
	const ok = {
		type: 'kitentity',
		seq: 1,
		at: 2.5,
		put: [{ id: 'k1', pos: [0, 0, 0], yaw: 0, hp: 10, max: 10, dead: false }],
		upd: [['k2', 1, 2, 3, 0, 5, 0]],
		del: ['k3']
	};
	it('accepts a real message', () => {
		expect(validateWireMessage(ok)).toBe(true);
		expect(validateWireMessage({ type: 'kitentity', seq: 0, at: 0 })).toBe(true);
	});
	it('refuses NaN poses, junk rows, unbounded counts and oversized data', () => {
		const bad = [
			{ ...ok, seq: -1 },
			{ ...ok, seq: 1.5 },
			{ ...ok, at: NaN },
			{ ...ok, put: [{ ...ok.put[0], pos: [0, NaN, 0] }] },
			{ ...ok, put: [{ ...ok.put[0], hp: Infinity }] },
			{ ...ok, put: [{ ...ok.put[0], dead: 'no' }] },
			{ ...ok, put: [{ ...ok.put[0], tags: ['x'.repeat(33)] }] },
			{ ...ok, put: [{ ...ok.put[0], data: { s: 'x'.repeat(3000) } }] },
			{ ...ok, upd: [['k2', 1, 2, 3, 0, 5]] },
			{ ...ok, upd: [['k2', 1, 2, NaN, 0, 5, 0]] },
			{ ...ok, upd: [[7, 1, 2, 3, 0, 5, 0]] },
			{ ...ok, del: [''] },
			{ ...ok, del: Array.from({ length: KIT_ENTITY_MAX_ROWS + 1 }, (_, i) => 'k' + i) },
			{ ...ok, snap: 'yes' }
		];
		for (const m of bad) expect(validateWireMessage(m)).toBe(false);
		expect(isKitEntityRecord(null)).toBe(false);
	});
	it('every message the store makes passes (the codec and the validator agree)', () => {
		const a = createEntityStore();
		for (let i = 0; i < 200; i++)
			spawnEntity(
				a,
				{ pos: [i, 0, -i], hp: 5, tags: ['t' + (i % 3)], data: { i }, mover: { speed: 2 } },
				0
			);
		expect(validateWireMessage(flushMessage(a, 0))).toBe(true);
		expect(validateWireMessage(snapshotMessage(a, 1))).toBe(true);
	});
});
