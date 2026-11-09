// 78-int PL13 — who last changed each shared Configure Scene section, and when. LOCAL (a view of
// the edits this tab saw arrive or make; never saved, never sent as its own message). A LEAF: it
// imports only svelte/store and its pure core, so peerHandler, the AI tool runner and the panel all
// reach it without a cycle.
//
// HOW AN EDIT IS ATTRIBUTED. Each tracked store is subscribed and keeps the value at the last
// attribution (`base`); the sections an edit touched are sceneEditByCore.sectionsOf(base, now). Then:
//   · a LOCAL edit is confirmed by its live send (PeerConnection.send), which also stamps an additive
//     `by` on the message — `{}` for the person, `{agent: '<label>'}` while an AI tool runs in this tab;
//   · a REMOTE edit is confirmed right after its applier ran, IF the message carries `by`. Handshake
//     and full-state replies never do (they re-state a scene, nobody just changed it), and neither does
//     an older peer's edit — both simply leave the line as it was.
import { writable } from 'svelte/store';
import { sectionsOf, authorOf } from './sceneEditByCore.js';

/** section label -> {name, agent, self, at} @type {import('svelte/store').Writable<Record<string, {name: string, agent: boolean, self: boolean, at: number}>>} */
export const sceneSectionEdits = writable({});

/** a change no send or live message claims within this long was a re-statement (a load, a travel) @type {number} */
const SETTLE_MS = 10000;

/** @type {Map<string, {cur: any, base: any, ready: boolean, timer: any}>} */
const tracked = new Map();

/**
 * Follow one scene singleton store. Idempotent per kind. `base` is the value at the last attribution: a
 * live edit is the difference between it and now. (A time window measured from the store change failed
 * on a loaded scene: applyEnvironment between the change and the send can take seconds on a slow GPU.)
 * @param {string} kind @param {import('svelte/store').Readable<any>} store
 */
export function trackSceneStore(kind, store) {
	if (tracked.has(kind)) return;
	const t = { cur: undefined, base: undefined, ready: false, timer: /** @type {any} */ (null) };
	tracked.set(kind, t);
	store.subscribe((v) => {
		t.cur = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
		if (!t.ready) {
			t.base = t.cur;
			t.ready = true;
			return;
		}
		clearTimeout(t.timer);
		t.timer = setTimeout(() => (t.base = t.cur), SETTLE_MS);
	});
}

let aiDepth = 0;
let aiLabel = '';

/** an AI tool started running in this tab (the connector, the assistant, an agent page) @param {string} label */
export function beginAiEdit(label) {
	aiDepth++;
	aiLabel = String(label || 'AI');
}
export function endAiEdit() {
	aiDepth = Math.max(0, aiDepth - 1);
}

/** @param {string} kind @param {{name: string, agent: boolean, self: boolean}} who */
function confirm(kind, who) {
	const t = tracked.get(kind);
	if (!t) return;
	const sections = sectionsOf(kind, t.base, t.cur);
	t.base = t.cur;
	clearTimeout(t.timer);
	if (!sections.length) return;
	const at = Date.now();
	sceneSectionEdits.update((m) => {
		const out = { ...m };
		for (const s of sections) out[s] = { ...who, at };
		return out;
	});
}

/**
 * A live LOCAL send of a scene singleton: record the sections it changed as ours (or the AI's) and
 * return the `by` field the message carries. `null` = not a tracked edit.
 * @param {any} data the outgoing message
 */
export function noteLocalSceneEdit(data) {
	const kind = data?.type;
	if (!tracked.has(kind) || (kind === 'scenepost' && data.key)) return null;
	const agent = aiDepth > 0;
	confirm(kind, { name: agent ? aiLabel : 'you', agent, self: true });
	return agent ? { agent: aiLabel } : {};
}

/**
 * A remote scene singleton just applied: attribute it when the sender marked it a live edit.
 * @param {any} data @param {{peerName: string, peerIsAgent: boolean}} peer
 */
export function noteRemoteSceneEdit(data, peer) {
	const kind = data?.type;
	const t = tracked.get(kind);
	if (!t) return;
	if (kind === 'scenepost' && data.key) return;
	if (!data?.by || typeof data.by !== 'object') {
		t.base = t.cur; // a re-statement: nobody just changed it
		return;
	}
	confirm(kind, { ...authorOf(data.by, peer), self: false });
}
