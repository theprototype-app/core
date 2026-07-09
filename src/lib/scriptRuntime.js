import { get } from 'svelte/store';
import { scriptErrors } from '../stores/flowStore';
import { showToast } from '../stores/appStore';

// Compiles and runs user script code for Script nodes and custom node defs.
// Scripts run on EVERY peer independently — they must be pure functions of
// (object, base, data, time) to stay deterministic. Peers are already trusted
// (connection approval); this is collaborative prototyping, not a sandbox.

/** @type {Map<string, {fn?: Function, error?: string}>} */
const compiled = new Map();

/** @param {string} code */
function compile(code) {
	let entry = compiled.get(code);
	if (entry) return entry;
	if (compiled.size > 100) compiled.clear(); // stale codes from live editing
	try {
		entry = {
			fn: new Function(
				'object',
				'base',
				'data',
				'time',
				'params',
				'"use strict";\n' + code
			)
		};
	} catch (error) {
		entry = { error: String(error) };
	}
	compiled.set(code, entry);
	return entry;
}

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
	try {
		entry.fn(object, base, data, time, data);
		reportError(nodeId, null);
	} catch (error) {
		reportError(nodeId, String(error));
	}
}
