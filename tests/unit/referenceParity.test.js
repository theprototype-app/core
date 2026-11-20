// 2.0-n3c (roadmap 2.0 N3c) — THE PARITY TABLE: every convertible type's reference JS, run exactly as a
// converted Script value node runs it (scriptIO's input coercion, the v2 signature, the output
// harvest), against the built-in eval over a fixture grid: NaN, ±Infinity, numeric and other strings,
// booleans, null, arrays and missing (unwired) inputs, every op, the variadic extras, the seeded Random
// sequence (interval, seed, reroll stamps) and the late joiner's value. A reference that drifts from its
// built-in fails here, in CI.
import { describe, test, expect } from 'vitest';
import { nodeEvalOf, nodeDef } from '../../src/lib/nodes/index.js';
import { REFERENCE_TYPES, REFERENCE_JS, referenceShape } from '../../src/lib/nodes/reference.js';
import { convertedCode } from '../../src/lib/nodes/convertCode.js';
import { coerceInput, harvestOutputs, SCRIPT_HELPERS } from '../../src/lib/scriptIO.js';
import { socketCount, opFolds, foldMath, foldGate, INPUT_LETTERS } from '../../src/lib/variadicNodes.js';
import { hudFormat } from '../../src/lib/hudFormat.js';
import { lintScript } from '../../src/lib/scriptLint.js';

/** flowRuntime's num / bool / hashString / mulberry32, verbatim (they are module-private there) */
const num = (/** @type {any} */ v) => {
	if (Array.isArray(v)) return Number(v[0]) || 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};
const bool = (/** @type {any} */ v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v !== 0 : !!v);
const hashString = (/** @type {string} */ s) => {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	return h >>> 0;
};
const mulberry32 = (/** @type {number} */ seed) => {
	let t = (seed + 0x6d2b79f5) >>> 0;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MISSING = Symbol('missing');
/** the value grid every input walks */
const VALUES = [0, 1, -2.5, 7, 0.5, 2, NaN, Infinity, -Infinity, '4', ' 3 ', 'abc', '', true, false, null, [2, 3, 4], [], MISSING];

/**
 * The built-in's value. `wired` maps a handle to its raw value (MISSING = no wire); the rt bag is
 * flowRuntime's helpers for these evals.
 * @param {any} node @param {Record<string, any>} wired @param {number} time @param {any} ctx
 */
function builtIn(node, wired, time, ctx = { triggers: {} }) {
	const allEdges = Object.entries(wired)
		.filter(([, v]) => v !== MISSING)
		.map(([h]) => ({ id: 'e' + h, source: 'src-' + h, target: node.id, targetHandle: h }));
	const input = (/** @type {string} */ h, /** @type {any} */ fallback) => (h in wired && wired[h] !== MISSING && wired[h] !== undefined ? wired[h] : fallback);
	const rt = /** @type {any} */ ({
		num,
		bool,
		socketCount,
		opFolds,
		foldMath,
		foldGate,
		hashString,
		mulberry32,
		variadicExtras: (/** @type {any} */ n, /** @type {any[]} */ edges, /** @type {any} */ inp) => {
			const has = new Set(edges.filter((e) => e.target === n.id).map((e) => e.targetHandle));
			return INPUT_LETTERS.slice(2, socketCount(n.data))
				.filter((h) => has.has(h))
				.map((h) => inp(h, undefined))
				.filter((v) => v !== undefined);
		}
	});
	const ev = /** @type {any} */ (nodeEvalOf(node.type));
	return ev(node, { d: node.data, input, time, ctx, allNodes: [node], allEdges, seen: new Set() }, rt);
}

/**
 * The converted node's value, the way flowRuntime runs a Script value node: each declared input is
 * `input(name, socket.value)` then scriptIO's coerceInput; the code is `new Function(inputs, time,
 * dist, lerp, clamp, api)`; the return goes through harvestOutputs.
 * @param {any} node @param {Record<string, any>} wired @param {number} time @param {any} [api]
 */
function converted(node, wired, time, api = null) {
	const used = new Set(Object.entries(wired).filter(([, v]) => v !== MISSING).map(([h]) => h));
	const shape = /** @type {any} */ (referenceShape(node.type, node.data, used));
	const code = convertedCode(node.type, shape.params);
	/** @type {Record<string, any>} */
	const inputs = {};
	for (const s of shape.inputs) {
		const raw = s.name in wired && wired[s.name] !== MISSING && wired[s.name] !== undefined ? wired[s.name] : s.value;
		inputs[s.name] = coerceInput(s.type, raw);
	}
	const fn = new Function('inputs', 'time', 'dist', 'lerp', 'clamp', 'api', code);
	const result = fn(inputs, time, SCRIPT_HELPERS.dist, SCRIPT_HELPERS.lerp, SCRIPT_HELPERS.clamp, api);
	const harvested = harvestOutputs(result, shape.outputs);
	expect(harvested.problems).toEqual([]);
	return { raw: result[shape.outputs[0].name], value: harvested.value.__default };
}

/** Object.is, but NaN-safe already; arrays by JSON */
const same = (/** @type {any} */ a, /** @type {any} */ b) => Object.is(a, b) || (Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b));

/** every pair from the grid (a, b), with the params in `data` @param {string} type @param {any} data */
function gridPairs(type, data) {
	let rows = 0;
	for (const a of VALUES)
		for (const b of VALUES) {
			const node = { id: 'n1', type, data };
			const wired = { a, b };
			const want = builtIn(node, wired, 1);
			const got = converted(node, wired, 1);
			if (!same(want, got.raw)) throw new Error(`${type} ${JSON.stringify(data)} a=${String(a)} b=${String(b)}: built-in ${String(want)}, code ${String(got.raw)}`);
			rows++;
		}
	return rows;
}

describe('2.0-n3c parity: reference JS == built-in', () => {
	test('every convertible type has a referenceJs half, and it is the reference module', () => {
		for (const type of REFERENCE_TYPES) expect(/** @type {any} */ (nodeDef(type)).referenceJs).toBe(REFERENCE_JS[type]);
	});

	test('the converted code passes the script lint (the pure-function contract: inputs, time, api reads)', () => {
		for (const type of REFERENCE_TYPES) {
			const shape = /** @type {any} */ (referenceShape(type, { sockets: 4 }));
			expect(lintScript(convertedCode(type, shape.params))).toEqual([]);
		}
	});

	const mathOps = ['add', 'sub', 'mul', 'div', 'min', 'max', 'mod', 'pow', 'sin', 'cos', 'abs', 'round', 'floor', 'clamp', 'neg', 'nonsense', undefined];
	for (const op of mathOps)
		test(`math ${op}: the value grid, wired and missing`, () => {
			expect(gridPairs('math', { op })).toBe(VALUES.length ** 2);
			// dialled values stand in for missing wires
			expect(gridPairs('math', { op, a: 3, b: -4 })).toBe(VALUES.length ** 2);
			expect(gridPairs('math', { op, a: 'x', b: Infinity })).toBe(VALUES.length ** 2);
		});

	test('math / gate variadic extras: wired extras fold, unwired and empty ones are skipped', () => {
		const extrasGrid = [5, -1, 0, NaN, '2', true, MISSING, undefined];
		for (const type of ['math', 'gate'])
			for (const op of type === 'math' ? ['add', 'sub', 'mul', 'div', 'min', 'max', 'mod'] : ['and', 'or', 'xor', 'not'])
				for (const sockets of [2, 4, 8])
					for (const c of extrasGrid)
						for (const e of extrasGrid) {
							const node = { id: 'n1', type, data: { op, sockets } };
							const wired = { a: type === 'gate' ? true : 3, b: type === 'gate' ? 1 : 2, c, e, h: 4 };
							const want = builtIn(node, wired, 0);
							expect(converted(node, wired, 0).raw, `${type} ${op} ${sockets} c=${String(c)} e=${String(e)}`).toEqual(want);
						}
	});

	for (const op of ['gt', 'lt', 'eq', 'gte', 'lte', 'neq', undefined])
		test(`compare ${op}: the value grid`, () => {
			expect(gridPairs('compare', { op })).toBe(VALUES.length ** 2);
			expect(gridPairs('compare', { op, a: 2, b: 2 })).toBe(VALUES.length ** 2);
		});

	for (const op of ['and', 'or', 'not', 'xor', undefined])
		test(`gate ${op}: the value grid`, () => {
			expect(gridPairs('gate', { op })).toBe(VALUES.length ** 2);
			expect(gridPairs('gate', { op, a: true, b: 'yes' })).toBe(VALUES.length ** 2);
		});

	test('select: index grid x slot values, 2-way and 4-way, wired and dialled', () => {
		const datas = [{}, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { a: 'p', b: 'q', c: 'r', d: 's' }, { index: 3, a: 9 }];
		for (const data of datas)
			for (const index of VALUES)
				for (const slot of [MISSING, 5, 'abc', NaN]) {
					const node = { id: 'n1', type: 'select', data };
					for (const wiredSlots of [['a'], ['a', 'd'], ['c']]) {
						/** @type {Record<string, any>} */
						const wired = { index };
						for (const k of wiredSlots) wired[k] = slot;
						// planner Q5: 'any' slots and out, so EXACTLY the raw value the built-in passes on
						const want = builtIn(node, wired, 0);
						expect(converted(node, wired, 0).value, `select ${JSON.stringify(data)} i=${String(index)} ${wiredSlots} ${String(slot)}`).toStrictEqual(want);
					}
				}
	});

	test('map range: the input grid over clamped / unclamped / inverted / zero-span ranges', () => {
		const ranges = [{}, { inMin: 0, inMax: 10, outMin: 100, outMax: 200 }, { inMin: 10, inMax: 0, outMin: -1, outMax: 1, clamp: false }, { inMin: 5, inMax: 5 }, { inMin: '2', inMax: NaN, outMin: Infinity, clamp: 0 }];
		for (const data of ranges)
			for (const a of VALUES) {
				const node = { id: 'n1', type: 'maprange', data };
				const want = builtIn(node, { a }, 0);
				expect(converted(node, { a }, 0).raw, `maprange ${JSON.stringify(data)} a=${String(a)}`).toBe(want);
			}
	});

	test('random: the seeded sequence over time (interval), seed and reroll stamps matches exactly', () => {
		const datas = [{}, { min: 1, max: 6, integer: true, interval: 0.5 }, { min: -10, max: 10, interval: 2 }, { min: 'x', max: NaN }, { interval: 0.25, integer: true, max: 100 }];
		const stamps = [null, 0, 12.345, 99.9999, 1e6 + 0.001];
		let rows = 0;
		for (const data of datas)
			for (const seed of [MISSING, 0, 7, -3, 2.5, NaN, '11'])
				for (const lastT of stamps)
					for (let t = 0; t < 6; t += 0.37) {
						const node = { id: 'rnd-' + rows % 3, type: 'random', data };
						const ctx = { triggers: lastT === null ? {} : { [node.id]: { count: 1, lastT } } };
						const api = { self: () => ({ id: node.id }), stamp: (/** @type {string} */ h) => (h === 'reroll' ? lastT : null) };
						const want = builtIn(node, { seed }, t, ctx);
						expect(converted(node, { seed }, t, api).raw, `random ${JSON.stringify(data)} seed=${String(seed)} lastT=${lastT} t=${t}`).toBe(want);
						rows++;
					}
		expect(rows).toBeGreaterThan(1000);
	});

	test('random, late joiner: a peer that only holds the restored trigger log reads the same number', () => {
		// the peer that saw the reroll and the joiner that got the log through gettriggers hold the same
		// stamp for the reroll source; the converted node reads it there (api.stamp), the built-in from
		// its own entry, which the same pulse wrote
		const node = { id: 'rnd-join', type: 'random', data: { min: 0, max: 1000, integer: true } };
		const pulse = 4321.25;
		const witnessed = builtIn(node, {}, 10, { triggers: { [node.id]: { count: 3, lastT: pulse } } });
		const joinerLog = { 'key-1': { count: 0, lastT: pulse } }; // the source's entry, restored (count lost)
		const api = { self: () => ({ id: node.id }), stamp: () => joinerLog['key-1'].lastT };
		expect(converted(node, {}, 10, api).raw).toBe(witnessed);
		// and with no reroll yet, both read the id-seeded first roll
		expect(converted(node, {}, 10, { self: () => ({ id: node.id }), stamp: () => null }).raw).toBe(builtIn(node, {}, 10));
	});

	test('HUD Text formatting: value x format x decimals == hudFormat (what the HUD Text shows)', () => {
		const formats = [MISSING, '{v}', 'Gems: {v}', '{v}/{v}', 'no token', '', 42, null];
		const values = [...VALUES, 'Player One', '3.14159'];
		let rows = 0;
		for (const decimals of [undefined, 0, 2, 7, -1, '1', NaN])
			for (const dialled of [{}, { format: 'Score {v}', value: 5 }, { value: 'idle' }])
				for (const format of formats)
					for (const value of values) {
						const data = { ...dialled, decimals };
						const node = { id: 'h1', type: 'hudtext', data };
						// the HUD Text's own path: resolveInputs (a wire overrides the param) -> hudFormat
						const eff = /** @type {any} */ ({ ...data });
						if (format !== MISSING && format !== undefined) eff.format = format;
						if (value !== MISSING && value !== undefined) eff.value = value;
						const want = hudFormat(eff.format, eff.value, num(eff.decimals));
						expect(converted(node, { value, format }, 0).raw, `hudtext ${JSON.stringify(data)} f=${String(format)} v=${String(value)}`).toBe(want);
						rows++;
					}
		expect(rows).toBeGreaterThan(1000);
	});
});
