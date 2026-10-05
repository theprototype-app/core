// 36 (G1, phase 4): a Script node's sockets FOLLOW ITS CODE. "Edits re-derive the node": a v2
// script that starts reading `inputs.power` or returns `{ allow, score }` grows those sockets
// when the code is saved, so the node on the canvas always shows what the code actually uses.
//
// ADDITIVE ONLY. A declared socket the code no longer mentions stays — it may be wired, and a
// removal strands wires (scriptSockets prunes them and broadcasts the delete); that stays an
// explicit act in the Script panel. New inputs type as 'number' (the flowSockets fallback) and
// new outputs as 'number'; the panel changes a type.
//
// A leaf over loopGuard's scanner (strings and comments masked, so `"inputs.x"` in a string or
// a commented-out `return {}` adds nothing).
import { codeMask } from './loopGuard.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** @param {string} masked @param {number} open index of a `{` @returns {number} its match, or -1 */
function matchBrace(masked, open) {
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === '{' || ch === '(' || ch === '[') depth++;
		else if (ch === '}' || ch === ')' || ch === ']') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * The input names read as `inputs.<name>` / `inputs['<name>']` and the keys of every returned
 * object literal, in first-use order.
 * @param {string} code @returns {{ inputs: string[], outputs: string[] }}
 */
export function socketsUsedBy(code) {
	const src = String(code ?? '');
	const masked = codeMask(src) ?? src;
	/** @type {string[]} */ const inputs = [];
	/** @type {string[]} */ const outputs = [];
	const push = (/** @type {string[]} */ list, /** @type {string} */ name) => {
		if (IDENT.test(name) && !list.includes(name)) list.push(name);
	};
	for (const m of masked.matchAll(/(?<![\w$.])inputs\s*\.\s*([A-Za-z_$][\w$]*)/g)) push(inputs, m[1]);
	// bracket access with a literal: the string is masked, so read it from the source text
	for (const m of masked.matchAll(/(?<![\w$.])inputs\s*\[/g)) {
		const at = (m.index ?? 0) + m[0].length;
		const lit = src.slice(at).match(/^\s*(['"])([A-Za-z_$][\w$]*)\1\s*\]/);
		if (lit) push(inputs, lit[2]);
	}
	for (const m of masked.matchAll(/(?<![\w$])return\s*\{/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = matchBrace(masked, open);
		if (close < 0) continue;
		// split the literal's body at TOP-LEVEL commas
		const body = masked.slice(open + 1, close);
		let depth = 0;
		let start = 0;
		const parts = [];
		for (let i = 0; i <= body.length; i++) {
			const ch = body[i];
			if (ch === '{' || ch === '(' || ch === '[') depth++;
			else if (ch === '}' || ch === ')' || ch === ']') depth--;
			else if ((ch === ',' && depth === 0) || i === body.length) {
				parts.push(body.slice(start, i));
				start = i + 1;
			}
		}
		for (const part of parts) {
			const t = part.trim();
			if (!t || t.startsWith('...')) continue;
			const key = t.match(/^([A-Za-z_$][\w$]*)\s*(:|$|\()/);
			if (key) push(outputs, key[1]);
		}
	}
	return { inputs, outputs };
}

/**
 * The socket lists after following the code: the declared ones, plus a 'number' socket for every
 * name the code uses that is not declared. `changed` false = nothing to write.
 * @param {string} code
 * @param {{name: string, type: string, value?: any}[] | null} declaredInputs
 * @param {{name: string, type: string}[]} declaredOutputs
 * @param {Set<string>} [reserved] names a socket may not take (scriptIO's RESERVED)
 */
export function followCode(code, declaredInputs, declaredOutputs, reserved = new Set()) {
	const used = socketsUsedBy(code);
	const ins = [...(declaredInputs ?? [])];
	const outs = [...(declaredOutputs ?? [])];
	let changed = false;
	for (const name of used.inputs)
		if (!reserved.has(name) && !ins.some((s) => s.name === name)) {
			ins.push({ name, type: 'number' });
			changed = true;
		}
	for (const name of used.outputs)
		if (!reserved.has(name) && !outs.some((s) => s.name === name)) {
			outs.push({ name, type: 'number' });
			changed = true;
		}
	return { inputs: ins, outputs: outs, changed };
}
