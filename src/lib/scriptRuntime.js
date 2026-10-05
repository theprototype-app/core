import { get } from 'svelte/store';
import { scriptErrors } from '../stores/flowStore';
import { showToast } from '../stores/appStore';
import { instrument } from './loopGuard';
import { lintScript } from './scriptLint';
import { SCRIPT_HELPERS, harvestOutputs } from './scriptIO';

// Compiles and runs user script code for Script nodes and custom node defs.
// Scripts run on EVERY peer independently — they must be pure functions of
// (object, base, data, time) to stay deterministic. Peers are already trusted
// (connection approval); this is collaborative prototyping, not a sandbox.
//
// 27-D (audit C1) adds the two LIVENESS guards that trust does not cover, because a
// trusted author still writes an infinite loop by ACCIDENT — and this runs on every
// peer's main thread inside the shared flow tick, so the cost of that accident is
// everyone's tab, not just the author's:
//   1. every loop is instrumented (`loopGuard`), so a runaway THROWS instead of hanging
//   2. a node that merely runs LONG is timed and paused after a sustained run of slow
//      frames — the loop guard cannot see that one, since it returns between frames
// Neither is a sandbox. They stop a hang, not a hostile script.

/** @type {Map<string, {fn?: Function, error?: string}>} */
const compiled = new Map();

// 34 D3: the three shapes a script compiles to. 'v1' is today's signature, byte-identical
// (a v1 body declaring its own `inputs` must keep compiling, which is why the v2 names are
// not simply appended to it). The two v2 shapes go through the LINT first: a v2 node is new
// code written against the determinism rule, so it is held to it; a v1 node is not, because
// refusing a scene that ran yesterday is a regression nobody asked for.
/** @type {Record<string, string[]>} */
const SIGNATURES = {
	v1: ['object', 'base', 'data', 'time', 'params'],
	// 36 (plan 56.3): `api` (object / raycast / keys / spawn) is appended LAST, so a v2 body
	// compiled before it existed binds exactly the names it did
	effect: ['object', 'base', 'data', 'time', 'params', 'inputs', 'dist', 'lerp', 'clamp', 'api'],
	value: ['inputs', 'time', 'dist', 'lerp', 'clamp', 'api'],
	// 36-fb-code (F5): a built-in's code (builtinCode.js) — the Character Controller's "Player"
	player: ['settings', 'input', 'time', 'dist', 'lerp', 'clamp']
};

/** @param {string} code @param {'v1' | 'effect' | 'value' | 'player'} [shape] */
function compile(code, shape = 'v1') {
	const key = shape === 'v1' ? code : shape + ':' + code;
	let entry = compiled.get(key);
	if (entry) return entry;
	if (compiled.size > 100) compiled.clear(); // stale codes from live editing
	// Guard the loops BEFORE the code becomes a function. Here rather than at the call
	// site because this map is keyed by the CODE STRING: each distinct script is
	// transformed exactly once, and an edit re-instruments it and clears the old badge.
	if (shape !== 'v1') {
		const issues = lintScript(code);
		if (issues.length) {
			const more = issues.length > 1 ? ' (+' + (issues.length - 1) + ' more)' : '';
			entry = { error: 'lint, line ' + issues[0].line + ': ' + issues[0].message + more };
			compiled.set(key, entry);
			return entry;
		}
	}
	const guarded = instrument(code);
	if ('error' in guarded) {
		entry = { error: 'Could not guard this script: ' + guarded.error };
		compiled.set(key, entry);
		return entry;
	}
	try {
		entry = { fn: new Function(...SIGNATURES[shape], '"use strict";\n' + guarded.code) };
	} catch (error) {
		entry = { error: String(error) };
	}
	compiled.set(key, entry);
	return entry;
}

/** One frame's fair share for ONE node: an eighth of a 60Hz frame, with the rest of the
 * tick, physics, the renderer and every other node still to run. */
const SLOW_MS = 8;
/** Consecutive slow frames before a node is paused — about half a second at 60Hz, long
 * enough that a GC pause or a tab waking up cannot trip it. */
const SLOW_FRAMES = 30;
const PAUSED_BADGE = 'paused: too slow';

/** @type {Map<string, {code: string, slow: number, paused: boolean}>} */
const budget = new Map();

// toast each distinct error once per node (the badge stays until it runs clean)
const toasted = new Map();

/** @param {string} nodeId @param {string | null} error */
function reportError(nodeId, error) {
	const current = get(scriptErrors)[nodeId];
	if (error === (current ?? null)) return;
	scriptErrors.update((map) => {
		const next = { ...map };
		if (error) next[nodeId] = error;
		else delete next[nodeId];
		return next;
	});
	if (error && toasted.get(nodeId) !== error) {
		toasted.set(nodeId, error);
		showToast('Script error: ' + error);
	}
}

/**
 * Time one call against the node's budget; records/clears the node's error badge.
 * Returns the call's result, or undefined when it failed, was refused or is paused.
 * @param {string} nodeId @param {string} code @param {{fn?: Function, error?: string}} entry
 * @param {(fn: Function) => any} call
 */
function timed(nodeId, code, entry, call) {
	if (entry.error) {
		reportError(nodeId, entry.error);
		return undefined;
	}
	// Per-node time budget. A SUSTAINED run is what matters: one slow frame is a GC pause
	// or a tab waking up, and pausing a node for that would be its own bug. Keyed by the
	// CODE as well as the node, so editing the script re-arms it — which is the only way
	// back, and the one a user reaches for.
	let b = budget.get(nodeId);
	if (!b || b.code !== (code || '')) {
		b = { code: code || '', slow: 0, paused: false };
		budget.set(nodeId, b);
	}
	if (b.paused) {
		reportError(nodeId, PAUSED_BADGE);
		return undefined;
	}
	const fn = entry.fn;
	if (!fn) {
		reportError(nodeId, 'Script could not be compiled');
		return undefined;
	}
	const started = performance.now();
	try {
		const result = call(fn);
		const ms = performance.now() - started;
		if (ms > SLOW_MS) {
			b.slow++;
			if (b.slow >= SLOW_FRAMES) {
				b.paused = true;
				reportError(nodeId, PAUSED_BADGE);
				return undefined;
			}
		} else b.slow = 0;
		reportError(nodeId, null);
		return result;
	} catch (error) {
		reportError(nodeId, String(error));
		return undefined;
	}
}

/**
 * Run one script frame; records/clears the node's error badge.
 * 34 D3: `inputs` present = a v2 EFFECT (declared sockets, linted, `inputs` + helpers in
 * scope); absent = v1, byte-identical.
 * @param {string} nodeId @param {string} code
 * @param {any} object @param {any} base @param {any} data @param {number} time
 * @param {Record<string, any>} [inputs]
 * @param {any} [api] 36 (56.3): flowRuntime.scriptApi(…, 'effect')
 */
export function runScript(nodeId, code, object, base, data, time, inputs, api) {
	const v2 = inputs !== undefined;
	const entry = compile(code || '', v2 ? 'effect' : 'v1');
	timed(nodeId, code, entry, (fn) =>
		v2
			? fn(object, base, data, time, data, inputs, SCRIPT_HELPERS.dist, SCRIPT_HELPERS.lerp, SCRIPT_HELPERS.clamp, api)
			: fn(object, base, data, time, data)
	);
}

/**
 * 34 D3: run a v2 VALUE script — a pure function of (inputs, time) whose return feeds its
 * declared output handles. Returns the runtime's handle map ({__handles, __default}), or
 * undefined when the script failed (a consumer then keeps its own dialled value, exactly as
 * for an unwired input). A return that is missing a declared output is a badge, not a throw.
 * @param {string} nodeId @param {string} code @param {Record<string, any>} inputs
 * @param {number} time @param {import('./scriptIO').ScriptSocket[]} outputs
 * @param {any} [api] 36 (56.3): flowRuntime.scriptApi(…, 'value')
 */
export function runScriptValue(nodeId, code, inputs, time, outputs, api) {
	const entry = compile(code || '', 'value');
	let problems = /** @type {string[]} */ ([]);
	const value = timed(nodeId, code, entry, (fn) => {
		const harvested = harvestOutputs(
			fn(inputs, time, SCRIPT_HELPERS.dist, SCRIPT_HELPERS.lerp, SCRIPT_HELPERS.clamp, api),
			outputs
		);
		problems = harvested.problems;
		return harvested.value;
	});
	// after timed() cleared the badge for a clean RUN: a run that returned the wrong shape
	// still needs saying
	if (value && problems.length) reportError(nodeId, problems.join('; '));
	return value;
}

/**
 * 36-fb-code (F5): run a built-in node's code — the Character Controller's per-frame "Player"
 * body, `(settings, input, time) -> {mode?, speed?, …}` — under the same lint, loop guard, time
 * budget and error badge as a Script node. Returns what it returned, or undefined when it failed
 * (the caller then keeps the card's settings, exactly as for a script that throws).
 * @param {string} nodeId @param {string} code @param {Record<string, any>} settings
 * @param {Record<string, any>} input @param {number} time
 */
export function runPlayerScript(nodeId, code, settings, input, time) {
	const entry = compile(code || '', 'player');
	return timed(nodeId, code, entry, (fn) => fn(settings, input, time, SCRIPT_HELPERS.dist, SCRIPT_HELPERS.lerp, SCRIPT_HELPERS.clamp));
}

/** a built-in whose code was removed (an undo, a clear): its last badge goes with it
 * @param {string} nodeId */
export function clearScriptError(nodeId) {
	if (get(scriptErrors)[nodeId]) reportError(nodeId, null);
}

/** report a problem with a built-in's RESULT (a wrong key / type) on its badge, after a clean run
 * @param {string} nodeId @param {string[]} problems */
export function reportScriptProblems(nodeId, problems) {
	if (problems.length) reportError(nodeId, problems.join('; '));
}
