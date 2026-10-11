// 34 PF — THE PROFILER'S MATHS. Everything the Profiler tab shows that is not pixels: the
// timeline's series and their buckets, a frame/range's numbers, the per-object TREE
// (scene → module/game → object → mesh/material), the "who draws most" rankings, the CPU
// phases of a frame or range, and the comparison of two recordings.
//
// A LEAF over tpprof.js (pure; no store, no scene, no DOM), for the same reason tpprof.js is
// one: the panel, the headset lane's live viewer and the unit layer all read it, and a
// recording someone imported from another build must be readable without the scene it was
// made in. Every function here takes a T1 document (or part of one) and returns plain data.
//
// WHAT A ROW IS. A detailed capture's `objects` are per-DRAW rows (contract T1 `drawn`): one
// per drawable, plus a separate `shadow: true` row for its shadow-map passes. Their `path` is
// the '/'-joined names from the scene root, 'Scene/'-prefixed for the user's objects. The
// tree groups rows by OWNER (the module that made it, else "Scene objects"), then by the
// TOP-LEVEL object the path starts with — the thing a user can select — then lists the
// meshes themselves. Two top-level objects with the same name share a node: the path is all
// a capture keeps, and the rows underneath still carry their own uuids.
import { summarize, CPU_PHASES } from './tpprof.js';

/** The Quest budget the timeline draws (Performance protocol: ≤ 150 calls, ≤ 300k triangles, 72 Hz). */
export const BUDGET = Object.freeze({ calls: 150, tris: 300000, ms: 13.9, fps: 72 });

/**
 * What a row COSTS, as its share of the Quest budget: calls / 150 + triangles / 300k. One draw
 * call and 2 000 triangles weigh the same, so a 60k-triangle mesh outranks four cheap draws —
 * the order "who draws most" means on a headset, where either budget can be the one blown.
 * @param {{calls: number, tris: number}} n
 */
export function costOf(n) {
	return (n.calls || 0) / BUDGET.calls + (n.tris || 0) / BUDGET.tris;
}

/** what the user's own objects are grouped under when no module owns them */
export const SCENE_GROUP = 'Scene objects';

/**
 * The editor's own drawing — the transform gizmo, the grid, light/camera/collider helpers.
 * Real draw calls while you edit, none in Play (helpers hide there), so they get their own
 * owner, sorted LAST, and stay out of the rankings: "who draws most" is about what ships.
 * A row may say so itself (`helper: true`, forward compatible); older rows are recognised by
 * the names three and the editor give those objects.
 */
export const EDITOR_GROUP = 'Editor (not in Play)';
const EDITOR_SEGMENT = /^(TransformControls\w*|editor-grid|.*helpers?|.*-helper-.*)$/i;

/**
 * The timeline's stacked graphs, top to bottom. `of` reads one frame (null = no value).
 * @type {ReadonlyArray<{key: string, label: string, unit: string, budget: number | null, of: (f: import('./tpprof.js').TpFrame) => number | null, higherIsBetter?: boolean}>}
 */
export const SERIES = Object.freeze([
	{
		key: 'fps',
		label: 'FPS',
		unit: '',
		budget: BUDGET.fps,
		higherIsBetter: true,
		of: (f) => (f.ms > 0 ? 1000 / f.ms : null)
	},
	{ key: 'ms', label: 'Frame ms', unit: 'ms', budget: BUDGET.ms, of: (f) => f.ms },
	{
		key: 'calls',
		label: 'Draw calls',
		unit: '',
		budget: BUDGET.calls,
		of: (f) => (typeof f.calls === 'number' ? f.calls : null)
	},
	{
		key: 'tris',
		label: 'Triangles',
		unit: '',
		budget: BUDGET.tris,
		of: (f) => (typeof f.tris === 'number' ? f.tris : null)
	},
	{
		key: 'quality',
		label: 'Quality',
		unit: '',
		budget: null,
		of: (f) => (typeof f.quality === 'number' ? f.quality : null)
	}
]);

/** @param {number} v */
const r1 = (v) => Math.round(v * 10) / 10;
/** @param {number} v */
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- time

/**
 * The time span a recording covers (ms since startedAt): from the start of its first frame to
 * the end of its last, widened to its events so a marker before the first frame still shows.
 * @param {Pick<import('./tpprof.js').Tpprof, 'frames' | 'events'>} doc
 */
export function spanOf(doc) {
	const frames = doc?.frames ?? [];
	let from = frames.length ? Math.max(0, frames[0].t - frames[0].ms) : 0;
	let to = frames.length ? frames[frames.length - 1].t : 0;
	for (const e of doc?.events ?? []) {
		if (e.t < from) from = Math.max(0, e.t);
		if (e.t > to) to = e.t;
	}
	if (to <= from) to = from + 1;
	return { from, to };
}

/**
 * Index of the first frame whose END time is ≥ t (frames are in time order). A frame covers
 * (t - ms, t], so this is the frame "under" time t.
 * @param {import('./tpprof.js').TpFrame[]} frames @param {number} t
 */
export function frameIndexAt(frames, t) {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].t < t) lo = mid + 1;
		else hi = mid;
	}
	return Math.min(lo, frames.length - 1);
}

/** index of the first frame whose end time is AFTER t @param {import('./tpprof.js').TpFrame[]} frames @param {number} t */
function firstAfter(frames, t) {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].t <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The frames that END inside (from, to] — a range selection. A frame covers (t - ms, t], so a
 * selection of exactly one frame's span ({from: t - ms, to: t}) is that frame and not also the
 * one ending at `from`. A range narrower than one frame yields the single frame under `to`, so
 * a click is never an empty selection.
 * @param {import('./tpprof.js').TpFrame[]} frames @param {number} from @param {number} to
 */
export function framesIn(frames, from, to) {
	if (!frames.length) return [];
	if (to < from) [from, to] = [to, from];
	// t and ms are each rounded to 0.1 ms in a recording, so one frame's own span can start a
	// hair before the previous frame's end: half a tenth of slack keeps that frame out
	const a = firstAfter(frames, from + 0.15);
	const b = firstAfter(frames, to);
	return b > a ? frames.slice(a, b) : [frames[frameIndexAt(frames, to)]];
}

/**
 * Min / max / mean of one series per pixel column — what keeps a 72 000-frame recording
 * drawable at 60 fps while zoomed out (every spike survives as a column's max).
 * @param {import('./tpprof.js').TpFrame[]} frames @param {number} from @param {number} to
 * @param {number} columns @param {(f: import('./tpprof.js').TpFrame) => number | null} of
 * @returns {{min: Float32Array, max: Float32Array, mean: Float32Array, has: Uint8Array}}
 */
export function bucketize(frames, from, to, columns, of) {
	const n = Math.max(1, Math.floor(columns));
	const min = new Float32Array(n);
	const max = new Float32Array(n);
	const mean = new Float32Array(n);
	const has = new Uint8Array(n);
	const count = new Uint32Array(n);
	const span = to - from || 1;
	if (!frames.length) return { min, max, mean, has };
	for (let i = frameIndexAt(frames, from); i < frames.length; i++) {
		const f = frames[i];
		if (f.t > to) break;
		const v = of(f);
		if (v === null || !Number.isFinite(v)) continue;
		const c = Math.min(n - 1, Math.max(0, Math.floor(((f.t - from) / span) * n)));
		if (!has[c]) {
			min[c] = v;
			max[c] = v;
			has[c] = 1;
		} else {
			if (v < min[c]) min[c] = v;
			if (v > max[c]) max[c] = v;
		}
		mean[c] += v;
		count[c]++;
	}
	for (let c = 0; c < n; c++) if (count[c]) mean[c] /= count[c];
	return { min, max, mean, has };
}

/**
 * A series' drawing scale: 0 .. a round number above its 99th percentile (one 400-fps frame
 * after a tab switch must not flatten the whole lane; the few values above it draw clipped at
 * the top) and above its budget line, so the line is always on screen — the point of drawing
 * it is to see how far below it you are.
 * @param {import('./tpprof.js').TpFrame[]} frames @param {(f: any) => number | null} of @param {number | null} budget
 */
export function scaleOf(frames, of, budget) {
	/** @type {number[]} */
	const vals = [];
	for (const f of frames) {
		const v = of(f);
		if (v !== null && Number.isFinite(v)) vals.push(v);
	}
	vals.sort((a, b) => a - b);
	let max = vals.length ? vals[Math.min(vals.length - 1, Math.ceil(vals.length * 0.99) - 1)] : 0;
	if (budget) max = Math.max(max, budget * 1.15);
	if (max <= 0) return 1;
	const mag = Math.pow(10, Math.floor(Math.log10(max)));
	for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * mag >= max) return step * mag;
	return 10 * mag;
}

// ---------------------------------------------------------------- a frame / a range

/**
 * The headline numbers of a selection (one frame or a range): the T1 summary over its frames
 * and events, plus the mean CPU phases when the recording is detailed.
 * @param {import('./tpprof.js').Tpprof} doc @param {number} from @param {number} to
 */
export function rangeStats(doc, from, to) {
	const frames = framesIn(doc.frames ?? [], from, to);
	const lo = frames.length ? frames[0].t - frames[0].ms : from;
	const hi = frames.length ? frames[frames.length - 1].t : to;
	const events = (doc.events ?? []).filter((e) => e.t > lo && e.t <= hi);
	return { ...summarize({ frames, events }), from: lo, to: hi, events, cpu: cpuPhases(frames) };
}

/**
 * CPU ms per phase over frames (detailed recordings only; null for a light one). `share` is of
 * the phases' own total, `mean`/`max` per frame.
 * @param {import('./tpprof.js').TpFrame[]} frames
 * @returns {null | {frames: number, total: number, phases: {phase: string, mean: number, max: number, share: number}[]}}
 */
export function cpuPhases(frames) {
	const withCpu = frames.filter((f) => f.cpu && typeof f.cpu === 'object');
	if (!withCpu.length) return null;
	/** @type {string[]} */
	const keys = [...CPU_PHASES];
	for (const f of withCpu)
		for (const k of Object.keys(/** @type {any} */ (f.cpu))) if (!keys.includes(k)) keys.push(k);
	const sum = new Map(keys.map((k) => [k, 0]));
	const max = new Map(keys.map((k) => [k, 0]));
	for (const f of withCpu) {
		for (const [k, v] of Object.entries(/** @type {Record<string, number>} */ (f.cpu))) {
			if (!Number.isFinite(v)) continue;
			sum.set(k, /** @type {number} */ (sum.get(k)) + v);
			if (v > /** @type {number} */ (max.get(k))) max.set(k, v);
		}
	}
	const means = keys.map((k) => /** @type {number} */ (sum.get(k)) / withCpu.length);
	const total = means.reduce((a, b) => a + b, 0);
	return {
		frames: withCpu.length,
		total: r3(total),
		phases: keys.map((phase, i) => ({
			phase,
			mean: r3(means[i]),
			max: r3(/** @type {number} */ (max.get(phase))),
			share: total > 0 ? r3(means[i] / total) : 0
		}))
	};
}

// ---------------------------------------------------------------- captures

/**
 * The detailed captures behind a selection: every capture taken inside [from, to], else the
 * NEAREST one (with how far away it is, so the panel can say "nearest capture 0.4 s later").
 * A light recording has none.
 * @param {import('./tpprof.js').Tpprof} doc @param {number} from @param {number} to
 * @returns {{captures: import('./tpprof.js').TpCapture[], nearest: boolean, distance: number}}
 */
export function capturesFor(doc, from, to) {
	const caps = doc.captures ?? [];
	if (!caps.length) return { captures: [], nearest: false, distance: 0 };
	if (to < from) [from, to] = [to, from];
	const inside = caps.filter((c) => c.t >= from && c.t <= to);
	if (inside.length) return { captures: inside, nearest: false, distance: 0 };
	const mid = (from + to) / 2;
	let best = caps[0];
	for (const c of caps) if (Math.abs(c.t - mid) < Math.abs(best.t - mid)) best = c;
	return { captures: [best], nearest: true, distance: r1(best.t - mid) };
}

/**
 * Several captures as one: per-row MEANS over all of them (a row missing from a capture
 * counts as 0 there — it was not drawn). Rows are keyed by uuid + shadow, so an object and
 * its shadow passes stay separate.
 * @param {import('./tpprof.js').TpCapture[]} captures
 * @returns {import('./tpprof.js').TpDrawn[]}
 */
export function mergeCaptures(captures) {
	if (!captures.length) return [];
	if (captures.length === 1) return captures[0].objects.map((o) => ({ ...o }));
	/** @type {Map<string, any>} */
	const rows = new Map();
	for (const cap of captures) {
		for (const o of cap.objects) {
			const key = o.uuid + (o.shadow ? ':s' : '');
			let row = rows.get(key);
			if (!row) rows.set(key, (row = { ...o, calls: 0, tris: 0, ...(o.shadow ? {} : { ms: 0 }) }));
			else
				Object.assign(row, {
					name: o.name ?? row.name,
					path: o.path ?? row.path,
					module: o.module ?? row.module,
					material: o.material ?? row.material
				});
			row.calls += o.calls;
			row.tris += o.tris;
			if (!o.shadow && typeof o.ms === 'number') row.ms += o.ms;
		}
	}
	const n = captures.length;
	return [...rows.values()].map((row) => ({
		...row,
		calls: Math.round((row.calls / n) * 100) / 100,
		tris: Math.round(row.tris / n),
		...(typeof row.ms === 'number' ? { ms: r3(row.ms / n) } : {})
	}));
}

// ---------------------------------------------------------------- the tree

/** @param {import('./tpprof.js').TpDrawn & {helper?: boolean}} row */
export function placeOfRow(row) {
	const path = String(row.path ?? row.name ?? '');
	const scene = path.startsWith('Scene/');
	const parts = (scene ? path.slice(6) : path).split('/').filter(Boolean);
	if (!scene && !row.module) {
		const mark = parts.find((p) => EDITOR_SEGMENT.test(p));
		if (row.helper === true || mark)
			return {
				group: EDITOR_GROUP,
				object: mark || parts[0] || row.name || row.uuid,
				scene: false,
				depth: parts.length,
				editor: true
			};
	}
	const group = row.module ? String(row.module) : scene ? SCENE_GROUP : parts[0] || 'Other';
	const object = parts[0] || row.name || row.uuid;
	return { group, object, scene, depth: parts.length, editor: false };
}

/** @param {import('./tpprof.js').TpDrawn} row */
export const isEditorRow = (row) => placeOfRow(row).editor;

/**
 * @typedef {{
 *   id: string, kind: 'scene' | 'group' | 'object' | 'mesh', label: string,
 *   calls: number, tris: number, ms: number, shadowCalls: number,
 *   uuid: string | null, top: boolean, scene: boolean, editor?: boolean, material?: string, shadow?: boolean, transparent?: boolean,
 *   objects?: number, children: TreeNode[]
 * }} TreeNode
 */

/** @param {string} id @param {TreeNode['kind']} kind @param {string} label @returns {TreeNode} */
function node(id, kind, label) {
	return {
		id,
		kind,
		label,
		calls: 0,
		tris: 0,
		ms: 0,
		shadowCalls: 0,
		uuid: null,
		top: false,
		scene: false,
		children: []
	};
}

/** the sort keys a tree / ranking column offers @type {Record<string, (a: any, b: any) => number>} */
export const SORTS = {
	cost: (a, b) => costOf(b) - costOf(a) || b.ms - a.ms || String(a.label).localeCompare(b.label),
	calls: (a, b) => b.calls - a.calls || b.tris - a.tris,
	tris: (a, b) => b.tris - a.tris || b.calls - a.calls,
	ms: (a, b) => b.ms - a.ms || b.calls - a.calls,
	name: (a, b) => String(a.label).localeCompare(b.label)
};

/**
 * Rows → the tree: scene → module/game → object → mesh/material. Every level carries the sum
 * of what is under it (calls, triangles, CPU ms; shadow calls are counted in `calls` and also
 * shown on their own). `uuid` on an object node is the row's own when the object IS the mesh
 * (a single-mesh object, the common case) and the first mesh's otherwise — selecting either
 * reaches the same top-level object in the live scene.
 * @param {import('./tpprof.js').TpDrawn[]} rows @param {{scene?: string | null, sort?: string}} [opts]
 * @returns {TreeNode}
 */
export function buildTree(rows, opts = {}) {
	const root = node('scene', 'scene', opts.scene || 'Scene');
	/** @type {Map<string, TreeNode>} */
	const groups = new Map();
	/** @type {Map<string, TreeNode>} */
	const objects = new Map();
	for (const row of rows) {
		const { group, object, scene, depth, editor } = placeOfRow(row);
		let g = groups.get(group);
		if (!g) {
			groups.set(group, (g = node('g:' + group, 'group', group)));
			g.scene = scene;
			g.editor = editor;
			root.children.push(g);
		}
		const oKey = group + '\u0000' + object;
		let o = objects.get(oKey);
		if (!o) {
			objects.set(oKey, (o = node('o:' + oKey, 'object', object)));
			o.scene = scene;
			g.children.push(o);
		}
		if (depth <= 1 && !row.shadow) {
			o.uuid = row.uuid;
			o.top = true;
		} else if (!o.uuid) o.uuid = row.uuid;
		const leaf = node(
			'm:' + row.uuid + (row.shadow ? ':s' : ''),
			'mesh',
			(row.name || row.uuid) + (row.shadow ? ' (shadow)' : '')
		);
		Object.assign(leaf, {
			uuid: row.uuid,
			scene,
			calls: row.calls,
			tris: row.tris,
			ms: row.ms ?? 0,
			shadowCalls: row.shadow ? row.calls : 0,
			material: row.material ?? '',
			shadow: !!row.shadow,
			transparent: !!row.transparent
		});
		o.children.push(leaf);
		for (const n of [o, g, root]) {
			n.calls += leaf.calls;
			n.tris += leaf.tris;
			n.ms += leaf.ms;
			n.shadowCalls += leaf.shadowCalls;
		}
	}
	for (const g of root.children) g.objects = g.children.length;
	root.objects = objects.size;
	const tidy = (/** @type {TreeNode} */ n) => {
		n.calls = Math.round(n.calls * 100) / 100;
		n.ms = r3(n.ms);
		n.children.forEach(tidy);
	};
	tidy(root);
	sortTree(root, opts.sort ?? 'cost');
	return root;
}

/** Re-sort a tree in place, every level. @param {TreeNode} tree @param {string} key */
export function sortTree(tree, key) {
	const cmp = SORTS[key] ?? SORTS.cost;
	const walk = (/** @type {TreeNode} */ n) => {
		n.children.sort(cmp);
		n.children.forEach(walk);
	};
	walk(tree);
	// the editor's own drawing goes last whatever it costs (it does not ship)
	tree.children.sort((a, b) => Number(!!a.editor) - Number(!!b.editor));
	return tree;
}

// ---------------------------------------------------------------- who draws most

/**
 * The ranked lists: OBJECTS (the tree's object level, flattened across owners), MATERIALS
 * (non-shadow rows grouped by material), SHADOW casters (shadow-pass rows — a capture counts
 * shadow draws per CASTER; which light cast them is not in T1), and TRANSPARENT rows ranked by
 * triangles (a transparent surface is drawn over what is behind it: its triangles are the
 * overdraw proxy a capture can give).
 * @param {import('./tpprof.js').TpDrawn[]} rows @param {number} [limit]
 */
export function rankings(rows, limit = 20) {
	const all = rows;
	const editorRows = all.filter((r) => isEditorRow(r));
	rows = all.filter((r) => !isEditorRow(r));
	const tree = buildTree(rows);
	const objects = tree.children
		.flatMap((g) =>
			g.children.map((o) => ({
				label: o.label,
				group: g.label,
				uuid: o.uuid,
				scene: o.scene,
				calls: o.calls,
				tris: o.tris,
				ms: o.ms,
				shadowCalls: o.shadowCalls
			}))
		)
		.sort(SORTS.cost)
		.slice(0, limit);
	/** @type {Map<string, {label: string, calls: number, tris: number, ms: number, objects: number, uuid: string | null}>} */
	const mats = new Map();
	for (const row of rows) {
		if (row.shadow) continue;
		const label = row.material || '(none)';
		let m = mats.get(label);
		if (!m) mats.set(label, (m = { label, calls: 0, tris: 0, ms: 0, objects: 0, uuid: row.uuid }));
		m.calls += row.calls;
		m.tris += row.tris;
		m.ms += row.ms ?? 0;
		m.objects++;
	}
	const materials = [...mats.values()]
		.map((m) => ({ ...m, calls: Math.round(m.calls * 100) / 100, ms: r3(m.ms) }))
		.sort(SORTS.cost)
		.slice(0, limit);
	const shadowRows = rows.filter((r) => r.shadow);
	const shadows = shadowRows
		.map((r) => ({
			label: r.name || r.uuid,
			group: placeOfRow(r).group,
			uuid: r.uuid,
			scene: placeOfRow(r).scene,
			calls: r.calls,
			tris: r.tris,
			ms: 0
		}))
		.sort(SORTS.cost)
		.slice(0, limit);
	const transparent = rows
		.filter((r) => r.transparent && !r.shadow)
		.map((r) => ({
			label: r.name || r.uuid,
			group: placeOfRow(r).group,
			uuid: r.uuid,
			scene: placeOfRow(r).scene,
			calls: r.calls,
			tris: r.tris,
			ms: r.ms ?? 0,
			material: r.material ?? ''
		}))
		.sort(SORTS.tris)
		.slice(0, limit);
	const sum = (/** @type {any[]} */ list, /** @type {string} */ k) =>
		list.reduce((n, r) => n + (r[k] ?? 0), 0);
	return {
		objects,
		materials,
		shadows,
		transparent,
		totals: {
			calls: Math.round(sum(rows, 'calls') * 100) / 100,
			tris: sum(rows, 'tris'),
			shadowCalls: Math.round(sum(shadowRows, 'calls') * 100) / 100,
			transparentRows: rows.filter((r) => r.transparent && !r.shadow).length,
			editorCalls: Math.round(sum(editorRows, 'calls') * 100) / 100,
			editorTris: sum(editorRows, 'tris')
		}
	};
}

// ---------------------------------------------------------------- compare

/** the summary keys a comparison shows, and which way is better */
export const COMPARE_KEYS = Object.freeze([
	{ key: 'fpsP50', label: 'FPS (median)', higherIsBetter: true },
	{ key: 'fpsP5', label: 'FPS (slow 5%)', higherIsBetter: true },
	{ key: 'msP50', label: 'Frame ms (median)' },
	{ key: 'msP95', label: 'Frame ms (p95)' },
	{ key: 'msMax', label: 'Worst frame ms' },
	{ key: 'callsP50', label: 'Draw calls (median)' },
	{ key: 'callsMax', label: 'Draw calls (max)' },
	{ key: 'trisP50', label: 'Triangles (median)' },
	{ key: 'stalls', label: 'Stalls' }
]);

/**
 * @param {number | null | undefined} a @param {number | null | undefined} b @param {boolean} [higherIsBetter]
 * @returns {{a: number | null, b: number | null, delta: number | null, pct: number | null, verdict: 'better' | 'worse' | 'same' | null}}
 */
export function delta(a, b, higherIsBetter = false) {
	const av = typeof a === 'number' && Number.isFinite(a) ? a : null;
	const bv = typeof b === 'number' && Number.isFinite(b) ? b : null;
	if (av === null || bv === null) return { a: av, b: bv, delta: null, pct: null, verdict: null };
	const d = bv - av;
	const pct = av !== 0 ? r1((d / Math.abs(av)) * 100) : null;
	// a change under 2% (or under a whole draw call) is noise between two runs
	const tiny = Math.abs(d) < 1e-9 || (pct !== null && Math.abs(pct) < 2);
	const verdict = tiny ? 'same' : d > 0 === higherIsBetter ? 'better' : 'worse';
	return { a: av, b: bv, delta: Math.round(d * 1000) / 1000, pct, verdict };
}

/**
 * Two recordings side by side: A = the baseline, B = the new one. The summaries always; per
 * owner (module/game) and per object when BOTH are detailed (each side's captures merged into
 * one mean frame); CPU phases when both carry them. Objects are matched by owner + top-level
 * name (uuids differ between sessions), so "the same tree, after a change" lines up.
 * @param {import('./tpprof.js').Tpprof} a @param {import('./tpprof.js').Tpprof} b
 */
export function compareDocs(a, b) {
	const sa = summarize(a);
	const sb = summarize(b);
	const summary = COMPARE_KEYS.map((k) => ({
		...k,
		...delta(/** @type {any} */ (sa)[k.key], /** @type {any} */ (sb)[k.key], !!k.higherIsBetter)
	}));
	const detailed = !!(a.captures?.length && b.captures?.length);
	/** @type {any[]} */
	let groups = [];
	/** @type {any[]} */
	let objects = [];
	if (detailed) {
		const ta = buildTree(mergeCaptures(/** @type {any} */ (a.captures)));
		const tb = buildTree(mergeCaptures(/** @type {any} */ (b.captures)));
		/** @param {TreeNode} t */
		const index = (t) => {
			/** @type {Map<string, any>} */ const g = new Map();
			/** @type {Map<string, any>} */ const o = new Map();
			for (const gn of t.children) {
				g.set(gn.label, gn);
				for (const on of gn.children)
					o.set(gn.label + '\u0000' + on.label, { ...on, group: gn.label });
			}
			return { g, o };
		};
		const ia = index(ta);
		const ib = index(tb);
		/** @param {Map<string, any>} ma @param {Map<string, any>} mb */
		const pair = (ma, mb) =>
			[...new Set([...ma.keys(), ...mb.keys()])].map((key) => {
				const x = ma.get(key);
				const y = mb.get(key);
				return {
					key,
					label: (x ?? y).label,
					group: (x ?? y).group ?? null,
					uuid: (y ?? x).uuid ?? null,
					status: !x ? 'added' : !y ? 'removed' : 'both',
					calls: delta(x?.calls ?? 0, y?.calls ?? 0),
					tris: delta(x?.tris ?? 0, y?.tris ?? 0),
					ms: delta(x?.ms ?? 0, y?.ms ?? 0)
				};
			});
		const byChange = (/** @type {any} */ p, /** @type {any} */ q) =>
			Math.abs(q.calls.delta ?? 0) - Math.abs(p.calls.delta ?? 0) ||
			Math.abs(q.tris.delta ?? 0) - Math.abs(p.tris.delta ?? 0) ||
			String(p.label).localeCompare(q.label);
		groups = pair(ia.g, ib.g).sort(byChange);
		objects = pair(ia.o, ib.o).sort(byChange);
	}
	const ca = cpuPhases(a.frames ?? []);
	const cb = cpuPhases(b.frames ?? []);
	const cpu =
		ca && cb
			? [...new Set([...ca.phases.map((p) => p.phase), ...cb.phases.map((p) => p.phase)])].map(
					(phase) => ({
						phase,
						...delta(
							ca.phases.find((p) => p.phase === phase)?.mean ?? 0,
							cb.phases.find((p) => p.phase === phase)?.mean ?? 0
						)
					})
				)
			: null;
	return { a: sa, b: sb, summary, detailed, groups, objects, cpu };
}

// ---------------------------------------------------------------- 41 G17: the Details sidebar

/**
 * WHAT THE DETAILS SIDEBAR SAYS about the selection — ONE frame, a RANGE, or (nothing selected)
 * the whole RECORDING: frame time (p50 / p95 / max), fps, draw calls and triangles (p50 / max,
 * against the Quest budget), GPU ms when the recording measured it, the quality levels seen,
 * stalls, the heaviest CPU phases; and, from the detailed captures behind it, how many materials
 * were drawn, what each module/game cost, and the PICKED object (its draw calls, triangles,
 * meshes, materials, CPU ms). Pure: the sidebar renders it, the unit test reads it.
 * @param {import('./tpprof.js').Tpprof} doc
 * @param {{from: number, to: number} | null} sel
 * @param {string | null} [picked] an object/mesh uuid (a tree row the user clicked)
 */
export function selectionDetails(doc, sel, picked = null) {
	const range = sel ?? spanOf(doc);
	const frames = framesIn(doc.frames ?? [], range.from, range.to);
	const st = rangeStats(doc, range.from, range.to);
	const kind = !sel ? 'recording' : frames.length === 1 ? 'frame' : 'range';
	/** @type {number[]} */
	const gpu = [];
	/** @type {number[]} */
	const quality = [];
	for (const f of frames) {
		if (typeof f.gpu === 'number' && Number.isFinite(f.gpu)) gpu.push(f.gpu);
		if (typeof f.quality === 'number' && Number.isFinite(f.quality)) quality.push(f.quality);
	}
	const caps = capturesFor(doc, range.from, range.to);
	const rows = mergeCaptures(caps.captures).filter((r) => !isEditorRow(r));
	const tree = buildTree(rows);
	const total = tree.calls || 1;
	const modules = tree.children
		.map((g) => ({ label: g.label, calls: g.calls, tris: g.tris, ms: g.ms, objects: g.objects ?? g.children.length, share: Math.round((g.calls / total) * 1000) / 10 }))
		.sort(SORTS.cost)
		.slice(0, 6);
	/** @type {null | {label: string, group: string, calls: number, tris: number, ms: number, meshes: number, materials: number, shadowCalls: number}} */
	let object = null;
	if (picked)
		for (const g of tree.children)
			for (const o of g.children)
				if (!object && (o.uuid === picked || o.children.some((m) => m.uuid === picked)))
					object = {
						label: o.label,
						group: g.label,
						calls: o.calls,
						tris: o.tris,
						ms: o.ms,
						meshes: o.children.filter((m) => !m.shadow).length,
						materials: new Set(o.children.filter((m) => !m.shadow && m.material).map((m) => m.material)).size,
						shadowCalls: o.shadowCalls
					};
	return {
		kind,
		from: st.from,
		to: st.to,
		frames: frames.length,
		ms: { p50: st.msP50, p95: st.msP95, max: st.msMax },
		fps: st.fpsP50,
		calls: { p50: st.callsP50, max: st.callsMax, budget: BUDGET.calls },
		tris: { p50: st.trisP50, max: st.trisMax, budget: BUDGET.tris },
		gpu: gpu.length ? { mean: r3(gpu.reduce((a, b) => a + b, 0) / gpu.length), max: r3(Math.max(...gpu)) } : null,
		quality: quality.length ? { min: Math.min(...quality), max: Math.max(...quality) } : null,
		stalls: st.stalls,
		cpu: st.cpu ? st.cpu.phases.filter((p) => p.mean > 0).sort((a, b) => b.mean - a.mean).slice(0, 4) : null,
		detailed: !!doc.captures?.length,
		/** ms from the selection to the capture used when none lies inside it (null = inside) */
		nearest: caps.nearest ? caps.distance : null,
		materials: rows.length ? new Set(rows.filter((r) => !r.shadow && r.material).map((r) => r.material)).size : null,
		modules,
		object
	};
}

// ---------------------------------------------------------------- formatting (shared by the panel and the headset lane)

/** 1234567 → "1.23M", 12345 → "12.3k" @param {number | null | undefined} n */
export function fmtCount(n) {
	if (n === null || n === undefined || !Number.isFinite(n)) return '–';
	const a = Math.abs(n);
	if (a >= 1e6) return r1(n / 1e6) + 'M';
	if (a >= 1e4) return r1(n / 1e3) + 'k';
	if (a >= 100 || Number.isInteger(n)) return String(Math.round(n));
	return String(Math.round(n * 100) / 100);
}

/** ms with sensible precision @param {number | null | undefined} ms */
export function fmtMs(ms) {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
	if (ms >= 100) return Math.round(ms) + ' ms';
	if (ms >= 1) return r1(ms) + ' ms';
	return r3(ms) + ' ms';
}

/** a duration in seconds for the timeline axis @param {number} ms */
export function fmtSec(ms) {
	if (!Number.isFinite(ms)) return '–';
	return (ms >= 10000 ? Math.round(ms / 1000) : r1(ms / 1000)) + ' s';
}
