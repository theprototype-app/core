// 36 (U10, 36-games-graphs) — A BEHAVIOUR NODE'S SOCKETS, read from its code: `inputs` are event
// sockets in, `outputs` are a state field's VALUE (typed by its initial literal) or an EVENT
// (`this.emit`). A LEAF over analyze.js, memoized by the code text (a card and every connection
// check read it, and the same text gives the same sockets on every peer).

import { analyze } from './analyze.js';

/** @typedef {{name: string, type: string, kind?: 'value' | 'event'}} BehaviourSocket */

/** code -> its sockets @type {Map<string, {inputs: BehaviourSocket[], outputs: BehaviourSocket[]}>} */
const memo = new Map();

/** @param {string} code @returns {{inputs: BehaviourSocket[], outputs: BehaviourSocket[]}} */
export function behaviourSockets(code) {
	const key = String(code ?? '');
	const hit = memo.get(key);
	if (hit) return hit;
	const model = analyze(key);
	const out = {
		inputs: (model.inputs ?? []).map((/** @type {string} */ name) => ({ name, type: 'event' })),
		outputs: (model.outputs ?? []).map((/** @type {any} */ o) => ({ name: o.name, type: o.type, kind: o.kind }))
	};
	if (memo.size > 64) memo.clear(); // stale texts from live editing
	memo.set(key, out);
	return out;
}
