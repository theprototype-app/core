// 78-int PL13 (scene panel card G2, owner APPROVED 2026-11-08) — "changed by <peer / agent> · time"
// under the shared Configure Scene section headers. The pure half: imports NOTHING.
//
// The four scene singletons (environment, scenepost, scenephysics, music) each feed several sections,
// so WHICH section an edit touched is read from what changed: a lodBias-only environment edit is the
// Level of detail section, `play` in scenephysics is Play, `levels` is Levels, `pick` is Selection
// outline, the rest of scenephysics is Physics. A key no shared section shows (holdCamera) names none.

/** the message types that carry a shared scene section */
export const SCENE_EDIT_KINDS = Object.freeze(['environment', 'scenepost', 'scenephysics', 'music']);

/** scenephysics top-level keys that belong to a section other than Physics (others: Physics) */
const PHYSICS_KEY_SECTION = Object.freeze({
	play: 'Play',
	levels: 'Levels',
	pick: 'Selection outline',
	holdCamera: null, // Camera, in the This device group: no "changed by" line there
	changedAt: null
});

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The shared sections an edit changed, from the store value before and after it.
 * @param {string} kind a SCENE_EDIT_KINDS entry
 * @param {any} prev @param {any} next
 * @returns {string[]}
 */
export function sectionsOf(kind, prev, next) {
	if (kind === 'music') return same(prev, next) ? [] : ['Music'];
	if (kind === 'scenepost') return same(strip(prev), strip(next)) ? [] : ['Scene look'];
	const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
	/** @type {Set<string>} */
	const out = new Set();
	for (const k of keys) {
		if (k === 'changedAt' || same(prev?.[k], next?.[k])) continue;
		if (kind === 'environment') out.add(k === 'lodBias' ? 'Level of detail' : 'Environment');
		else if (kind === 'scenephysics') {
			const s = Object.prototype.hasOwnProperty.call(PHYSICS_KEY_SECTION, k) ? PHYSICS_KEY_SECTION[/** @type {keyof typeof PHYSICS_KEY_SECTION} */ (k)] : 'Physics';
			if (s) out.add(s);
		}
	}
	return [...out];
}

/** @param {any} v */
function strip(v) {
	if (!v || typeof v !== 'object') return v;
	const { changedAt, ...rest } = v;
	return rest;
}

/**
 * "just now" · "4 min ago" · "2 h ago" · a date for anything older than a day.
 * @param {number} at @param {number} now
 */
export function agoText(at, now) {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 45) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return m + ' min ago';
	const h = Math.round(m / 60);
	if (h < 24) return h + ' h ago';
	return new Date(at).toLocaleDateString();
}

/**
 * The line under a section header, or '' when there is nothing worth saying: your own edit while
 * nobody else is here (or ever was) says nothing, since "changed by you" alone is noise.
 * @param {{name: string, agent?: boolean, self?: boolean, at: number} | undefined} entry
 * @param {{now: number, others: boolean}} ctx `others` = a peer is connected
 */
export function editLine(entry, ctx) {
	if (!entry) return '';
	if (entry.self && !entry.agent && !ctx.others) return '';
	const who = entry.self && !entry.agent ? 'you' : entry.name + (entry.agent && !/\bAI\b/.test(entry.name) ? ' (AI)' : '');
	return 'changed by ' + who + ' · ' + agoText(entry.at, ctx.now);
}

/**
 * Who an edit is by, from what a message says. The peer id is the CONNECTION's (a payload never
 * names its own sender); `by.agent` is the label of an AI acting in that peer's tab.
 * @param {any} by the message's additive `by` field
 * @param {{peerName: string, peerIsAgent: boolean}} peer
 * @returns {{name: string, agent: boolean}}
 */
export function authorOf(by, peer) {
	// an agent PAGE is a peer of its own: its roster name says which agent it is
	if (peer.peerIsAgent) return { name: peer.peerName || 'AI agent', agent: true };
	const label = typeof by?.agent === 'string' ? by.agent.trim().slice(0, 40) : '';
	if (label) return { name: label, agent: true };
	return { name: peer.peerName || 'a peer', agent: !!peer.peerIsAgent };
}
