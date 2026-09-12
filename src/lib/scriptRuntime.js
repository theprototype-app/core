import { get } from 'svelte/store';
import { scriptErrors } from '../stores/flowStore';
import { showToast } from '../stores/appStore';
import { instrument } from './loopGuard';

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

/** @param {string} code */
function compile(code) {
	let entry = compiled.get(code);
	if (entry) return entry;
	if (compiled.size > 100) compiled.clear(); // stale codes from live editing
	// Guard the loops BEFORE the code becomes a function. Here rather than at the call
	// site because this map is keyed by the CODE STRING: each distinct script is
	// transformed exactly once, and an edit re-instruments it and clears the old badge.
	const guarded = instrument(code);
	if ('error' in guarded) {
		entry = { error: 'Could not guard this script: ' + guarded.error };
		compiled.set(code, entry);
		return entry;
	}
	try {
		entry = {
			fn: new Function(
				'object',
				'base',
				'data',
				'time',
				'params',
				'"use strict";\n' + guarded.code
			)
		};
	} catch (error) {
		entry = { error: String(error) };
	}
	compiled.set(code, entry);
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
 * Run one script frame; records/clears the node's error badge.
 * @param {string} nodeId @param {string} code
 * @param {any} object @param {any} base @param {any} data @param {number} time
 */
export function runScript(nodeId, code, object, base, data, time) {
	const entry = compile(code || '');
	if (entry.error) {
		reportError(nodeId, entry.error);
		return;
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
		return;
	}
	const fn = entry.fn;
	if (!fn) {
		reportError(nodeId, 'Script could not be compiled');
		return;
	}
	const started = performance.now();
	try {
		fn(object, base, data, time, data);
		const ms = performance.now() - started;
		if (ms > SLOW_MS) {
			b.slow++;
			if (b.slow >= SLOW_FRAMES) {
				b.paused = true;
				reportError(nodeId, PAUSED_BADGE);
				return;
			}
		} else b.slow = 0;
		reportError(nodeId, null);
	} catch (error) {
		reportError(nodeId, String(error));
	}
}
