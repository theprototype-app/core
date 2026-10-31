// 57 M11 — the ANIMATION STATES graph (a locomotion state machine), as data + a pure evaluator.
// A LEAF (plain numbers; blendSpeed is a leaf too) so the whole machine is unit-tested.
//
// The graph is part of the model's config (`userData.animGraph`: replicates, saves, undoes, exports)
// and EVERY PEER EVALUATES IT ITSELF from the same inputs — parameters derived from the replicated
// transform (speed, vertical speed, grounded) and synced ones (Set Animation Parameter, a trigger's
// stamp) — the way clip playback already works, so no message per frame and no per-state message.
//
// Shape (version 1):
//   {version: 1, entry: stateId, driver: 'motion' | 'none',
//    params: [{name, type: 'float'|'bool'|'trigger', default?}],
//    states: [{id, name, clip?, blend?: {param, idle, walk, run, walkSpeed, runSpeed}, speed?, loop?}],
//    transitions: [{from: stateId | '*', to: stateId, fade, when: [{param, op, value?}], exitTime?}]}
// ops: '>' '<' '>=' '<=' '==' '!=' (numbers), 'true' / 'false' (bools), 'trigger' (fired since the
// state was entered and not yet used). `driver: 'motion'` fills speed / vy / grounded from how the
// object moves (the character controller, an NPC's logic, a peer's replicated moves alike).

import { blendSpeedWeights, clipForSlot } from './blendSpeed.js';

export const ANIM_GRAPH_VERSION = 1;
export const OPS = ['>', '<', '>=', '<=', '==', '!=', 'true', 'false', 'trigger'];
/** the params a motion driver fills */
export const MOTION_PARAMS = ['speed', 'vy', 'grounded'];

const MAX = { states: 32, transitions: 64, params: 32, when: 8 };
const str = (/** @type {any} */ v, n = 60) => String(v ?? '').slice(0, n);
const num = (/** @type {any} */ v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * A graph as stored and sent: unknown fields dropped, lists capped, ids unique, references valid.
 * null = not a graph.
 * @param {any} raw @returns {any}
 */
export function normalizeAnimGraph(raw) {
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.states)) return null;
	const ids = new Set();
	const states = [];
	for (const s of raw.states.slice(0, MAX.states)) {
		const id = str(s?.id, 40);
		if (!id || ids.has(id)) continue;
		ids.add(id);
		/** @type {any} */
		const st = { id, name: str(s.name) || id };
		if (s.blend && typeof s.blend === 'object')
			st.blend = {
				param: str(s.blend.param) || 'speed',
				idle: str(s.blend.idle, 80),
				walk: str(s.blend.walk, 80),
				run: str(s.blend.run, 80),
				walkSpeed: Math.max(0.05, num(s.blend.walkSpeed, 1.4)),
				runSpeed: Math.max(0.1, num(s.blend.runSpeed, 3.5))
			};
		else st.clip = str(s.clip, 80);
		if (num(s.speed, 1) !== 1) st.speed = Math.min(8, Math.max(0.05, num(s.speed, 1)));
		if (s.loop === false) st.loop = false;
		if (Number.isFinite(s.x)) st.x = num(s.x);
		if (Number.isFinite(s.y)) st.y = num(s.y);
		states.push(st);
	}
	if (!states.length) return null;
	const params = [];
	const pnames = new Set();
	for (const p of Array.isArray(raw.params) ? raw.params.slice(0, MAX.params) : []) {
		const name = str(p?.name, 40);
		if (!name || pnames.has(name)) continue;
		pnames.add(name);
		const type = p.type === 'bool' || p.type === 'trigger' ? p.type : 'float';
		/** @type {any} */
		const out = { name, type };
		if (type === 'float' && Number.isFinite(p.default)) out.default = num(p.default);
		if (type === 'bool' && typeof p.default === 'boolean') out.default = p.default;
		params.push(out);
	}
	const transitions = [];
	for (const t of Array.isArray(raw.transitions) ? raw.transitions.slice(0, MAX.transitions) : []) {
		const from = t?.from === '*' ? '*' : str(t?.from, 40);
		const to = str(t?.to, 40);
		if (!ids.has(to) || (from !== '*' && !ids.has(from))) continue;
		const when = (Array.isArray(t.when) ? t.when : [])
			.slice(0, MAX.when)
			.filter((/** @type {any} */ c) => c && typeof c.param === 'string' && OPS.includes(c.op))
			.map((/** @type {any} */ c) => ({ param: str(c.param, 40), op: c.op, ...(c.value !== undefined && c.op !== 'true' && c.op !== 'false' && c.op !== 'trigger' ? { value: num(c.value) } : {}) }));
		/** @type {any} */
		const tr = { from, to, fade: Math.min(3, Math.max(0, num(t.fade, 0.2))), when };
		if (Number.isFinite(t.exitTime)) tr.exitTime = Math.min(1, Math.max(0, num(t.exitTime)));
		transitions.push(tr);
	}
	const entry = ids.has(raw.entry) ? raw.entry : states[0].id;
	return { version: ANIM_GRAPH_VERSION, entry, driver: raw.driver === 'motion' ? 'motion' : 'none', params, states, transitions };
}

/** a fresh run of a graph (where it is, what it has used) @param {any} graph @param {number} t */
export function newRun(graph, t) {
	return { state: graph.entry, entered: t, prev: null, fadeStart: t, fadeDur: 0, used: /** @type {Record<string, number>} */ ({}), seen: /** @type {Record<string, number>} */ ({}) };
}

/** @param {any} c @param {Record<string, any>} params @param {any} run */
function holds(c, params, run) {
	const v = params[c.param];
	switch (c.op) {
		case 'true':
			return !!v;
		case 'false':
			return !v;
		case 'trigger': {
			// a trigger param holds the STAMP it last fired at; it counts once, and only if it fired
			// after this state was entered (an old jump press must not replay on entry)
			const at = Number(v);
			return Number.isFinite(at) && at > (run.used[c.param] ?? -Infinity) && at >= run.entered - 0.05;
		}
		case '>':
			return Number(v) > c.value;
		case '<':
			return Number(v) < c.value;
		case '>=':
			return Number(v) >= c.value;
		case '<=':
			return Number(v) <= c.value;
		case '==':
			return Number(v) === c.value;
		case '!=':
			return Number(v) !== c.value;
	}
	return false;
}

/**
 * One state's clip weights + rates (+ a pinned time for a play-once clip).
 * @param {any} st @param {Record<string, any>} params @param {string[]} clips @param {Record<string, number>} durations @param {number} sinceEntered
 */
export function stateWeights(st, params, clips, durations, sinceEntered) {
	/** @type {Record<string, number>} */
	const weights = {};
	/** @type {Record<string, number>} */
	const rates = {};
	/** @type {Record<string, number>} */
	const times = {};
	if (!st) return { weights, rates, times };
	const k = st.speed ?? 1;
	if (st.blend) {
		const b = st.blend;
		const slot = { idle: clipForSlot(clips, 'idle', b.idle), walk: clipForSlot(clips, 'walk', b.walk), run: clipForSlot(clips, 'run', b.run) };
		const r = blendSpeedWeights(Number(params[b.param]) || 0, { walkSpeed: b.walkSpeed, runSpeed: b.runSpeed, idle: !!slot.idle, walk: !!slot.walk, run: !!slot.run });
		for (const s of /** @type {const} */ (['idle', 'walk', 'run'])) {
			const clip = slot[s];
			if (!clip || !(r.weights[s] > 0)) continue;
			weights[clip] = (weights[clip] ?? 0) + r.weights[s];
			rates[clip] = r.rates[s] * k;
		}
	} else if (st.clip && clips.includes(st.clip)) {
		weights[st.clip] = 1;
		rates[st.clip] = k;
		if (st.loop === false) times[st.clip] = Math.min(Math.max(sinceEntered * k, 0), Math.max((durations[st.clip] ?? 1) - 1e-4, 0));
	}
	return { weights, rates, times };
}

/**
 * Advance a run by one frame: take the first transition whose conditions all hold (from this
 * state, or from '*'), then blend the previous state out over the transition's fade.
 * @param {any} graph @param {any} run (mutated) @param {Record<string, any>} params
 * @param {number} t now (s) @param {string[]} clips the model's clip names @param {Record<string, number>} durations
 * @returns {{weights: Record<string, number>, rates: Record<string, number>, times: Record<string, number>, state: string, entered: boolean}}
 */
export function stepGraph(graph, run, params, t, clips, durations) {
	let entered = false;
	const cur = graph.states.find((/** @type {any} */ s) => s.id === run.state) ?? graph.states[0];
	if (cur.id !== run.state) run.state = cur.id;
	for (const tr of graph.transitions) {
		if (tr.to === run.state || (tr.from !== '*' && tr.from !== run.state)) continue;
		if (tr.exitTime !== undefined && cur.clip) {
			const d = durations[cur.clip] ?? 0;
			if (d > 0 && (t - run.entered) * (cur.speed ?? 1) < tr.exitTime * d) continue;
		}
		if (!tr.when.every((/** @type {any} */ c) => holds(c, params, run))) continue;
		for (const c of tr.when) if (c.op === 'trigger') run.used[c.param] = Number(params[c.param]);
		run.prev = { state: run.state, entered: run.entered };
		run.state = tr.to;
		run.entered = t;
		run.fadeStart = t;
		run.fadeDur = tr.fade;
		entered = true;
		break;
	}
	const now = graph.states.find((/** @type {any} */ s) => s.id === run.state);
	const a = stateWeights(now, params, clips, durations, t - run.entered);
	const k = run.fadeDur > 0 ? Math.min(1, Math.max(0, (t - run.fadeStart) / run.fadeDur)) : 1;
	if (k >= 1 || !run.prev) {
		run.prev = null;
		return { ...a, state: run.state, entered };
	}
	const e = k * k * (3 - 2 * k);
	const prevState = graph.states.find((/** @type {any} */ s) => s.id === run.prev.state);
	const b = stateWeights(prevState, params, clips, durations, t - run.prev.entered);
	/** @type {Record<string, number>} */
	const weights = {};
	for (const [c, w] of Object.entries(b.weights)) weights[c] = (weights[c] ?? 0) + w * (1 - e);
	for (const [c, w] of Object.entries(a.weights)) weights[c] = (weights[c] ?? 0) + w * e;
	return { weights, rates: { ...b.rates, ...a.rates }, times: { ...b.times, ...a.times }, state: run.state, entered };
}

/** the motion params from a body's velocity (m/s): horizontal speed, vertical speed, grounded
 * @param {number[]} vel @param {{groundedFor: number}} memo (mutated: how long it has been level) @param {number} dt */
export function motionParams(vel, memo, dt) {
	const vy = vel[1];
	const level = Math.abs(vy) < 0.35;
	memo.groundedFor = level ? memo.groundedFor + dt : 0;
	// level for longer than a jump's apex lasts (|vy| < 0.35 for ~70 ms at g = 9.8) = on the ground
	return { speed: Math.hypot(vel[0], vel[2]), vy, grounded: memo.groundedFor > 0.1 };
}

/**
 * THE LOCOMOTION PRESET: idle / walk / run as one speed blend, jump and fall, wired to the motion
 * driver. Clips come from the model's own (or assigned motion-kit: motionKit.js fills the gaps) clips by name; a state whose clip
 * is missing keeps its slot empty (it simply shows the previous pose's blend).
 * @param {string[]} clips the model's clip names
 * @returns {any} a normalized graph
 */
export function locomotionPreset(clips) {
	const jump = clips.find((c) => /jump_start|takeoff/i.test(c)) ?? clips.find((c) => /jump(?!.*(idle|loop|land))/i.test(c)) ?? clips.find((c) => /jump/i.test(c)) ?? '';
	const fall = clips.find((c) => /fall|jump_loop|jump_idle|airborne|in_air/i.test(c)) ?? jump;
	return normalizeAnimGraph({
		entry: 'move',
		driver: 'motion',
		params: [
			{ name: 'speed', type: 'float', default: 0 },
			{ name: 'vy', type: 'float', default: 0 },
			{ name: 'grounded', type: 'bool', default: true },
			{ name: 'jump', type: 'trigger' }
		],
		states: [
			{ id: 'move', name: 'Move', blend: { param: 'speed', idle: clipForSlot(clips, 'idle'), walk: clipForSlot(clips, 'walk'), run: clipForSlot(clips, 'run'), walkSpeed: 1.4, runSpeed: 3.5 }, x: 0, y: 0 },
			{ id: 'jump', name: 'Jump', clip: jump, loop: false, x: 1, y: -1 },
			{ id: 'fall', name: 'Fall', clip: fall, x: 2, y: 0 }
		],
		transitions: [
			{ from: 'move', to: 'jump', fade: 0.12, when: [{ param: 'vy', op: '>', value: 1 }] },
			{ from: 'move', to: 'jump', fade: 0.12, when: [{ param: 'jump', op: 'trigger' }] },
			{ from: 'move', to: 'fall', fade: 0.25, when: [{ param: 'grounded', op: 'false' }, { param: 'vy', op: '<', value: -1.5 }] },
			{ from: 'jump', to: 'fall', fade: 0.25, when: [{ param: 'vy', op: '<', value: -0.2 }] },
			{ from: 'jump', to: 'move', fade: 0.2, when: [{ param: 'grounded', op: 'true' }], exitTime: 0.6 },
			{ from: 'fall', to: 'move', fade: 0.2, when: [{ param: 'grounded', op: 'true' }] }
		]
	});
}
