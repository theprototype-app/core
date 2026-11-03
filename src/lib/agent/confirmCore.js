// Roadmap 85 (rule 7) — ASK BEFORE CHANGING THE WHOLE SCENE'S LOOK, the pure half (imports nothing).
//
// A scene-wide look change (post stack, scene-default shader, and later the environment tools of
// 85-scene) changes what the OWNER made, so an agent asks first. This is a courtesy between people who
// already share a scene, NOT a security boundary: an editor's page can send the same messages by hand,
// and every receiver treats them as it treats any editor's. What it buys is that an agent acting on a
// sentence nobody re-read does not repaint somebody's scene unasked.

/** how long a question stays open (ms) */
export const CONFIRM_TTL_MS = 10 * 60 * 1000;
/** how long one call may wait for the answer (seconds) */
export const CONFIRM_MAX_WAIT_S = 60;
/** open questions one asker may hold on a host */
export const CONFIRM_MAX_PENDING = 3;
/** longest one-line summary a prompt shows */
export const CONFIRM_SUMMARY_MAX = 160;

/**
 * Who decides this call. An agent's page and the connector act on someone else's sentence, so they ask;
 * the in-app assistant in a tab that owns the scene is the person using their own panel.
 * @param {{agentPage: boolean, connector: boolean, host: string | null, amAdmin: boolean}} facts
 *   `host`: the peer that approved us (null = this tab hosts, or is alone)
 * @returns {'apply' | 'local' | 'ask'} apply now · a prompt in this tab · ask the host and the admins
 */
export function confirmRoute(facts) {
	if (facts.agentPage) return facts.host ? 'ask' : 'apply'; // an agent page with no host has no owner to ask
	if (facts.host && !facts.amAdmin) return 'ask';
	return facts.connector ? 'local' : 'apply';
}

/**
 * Whom to ask: the host and every admin, never the asker or another agent.
 * @param {{host: string | null, me: string, open: string[], roleOf?: (id: string) => any, isAgent?: (id: string) => boolean}} facts
 * @returns {string[]}
 */
export function confirmTargets(facts) {
	const out = new Set();
	const open = new Set(facts.open);
	if (facts.host && open.has(facts.host) && facts.host !== facts.me) out.add(facts.host);
	for (const id of facts.open) {
		if (id === facts.me || facts.isAgent?.(id)) continue;
		if (facts.roleOf?.(id) === 'admin') out.add(id);
	}
	return [...out];
}

/**
 * The asked peer's verdict on showing a prompt at all.
 * @param {{role: string | null, pending: number, summary: any}} facts
 * @returns {string | null} the refusal, or null to show it
 */
export function askRefusal(facts) {
	if (facts.role === 'viewer') return 'view-only peers cannot change the look of this scene';
	if (facts.pending >= CONFIRM_MAX_PENDING) return 'too many questions are already waiting for an answer';
	if (typeof facts.summary !== 'string' || !facts.summary.trim()) return 'no summary to show';
	return null;
}

/** one line, capped, no control characters (it lands in a toast) @param {any} text */
export function cleanSummary(text) {
	const line = String(text ?? '')
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.trim();
	return line.length > CONFIRM_SUMMARY_MAX ? line.slice(0, CONFIRM_SUMMARY_MAX - 1) + '…' : line;
}
