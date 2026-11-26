// 89 — WHICH AI APP is using this tab. The connector is not Claude-only any more (ChatGPT and other MCP clients sign in
// to the same server), so the tab's words name the app: "ChatGPT connected · this tab", "ChatGPT (connector)" in the
// log, "ChatGPT asks this tab to join…". The name is the Worker's TRUSTED one, set per grant from its exact registered
// callback (worker-mcp describeRedirect / appOf) — never the client's self-chosen name, which anyone can pick.
//   · `app` absent  → a Worker from before 89: it only ever had Claude, so the words stay exactly what they were
//   · `app` ''      → a client whose callback is not a known one (a loopback CLI, an inspector): "AI app"
// A leaf (no imports), so the connector, the store and the confirm gate share it without loading anything.

/** a Worker before 89 sends no app name: every connection then was Claude's */
export const FALLBACK_APP = 'Claude';
/** a connection whose callback the Worker could not name */
export const UNKNOWN_APP = 'AI app';
/** what a trusted name may look like (the Worker sends 'Claude' / 'ChatGPT'; anything odd reads as unknown) */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,39}$/;

/** The app name of one grant / the ready frame's connection. @param {{app?: unknown} | null | undefined} g */
export function appNameOf(g) {
	if (!g || typeof g.app !== 'string') return FALLBACK_APP;
	return SAFE_NAME.test(g.app) ? g.app : UNKNOWN_APP;
}

/**
 * Who the tab is talking to: the grant `grantId` names (a call's), else the link's own (`connection`, the most recently
 * used grant when it linked), else the most recently used of `connections`, else Claude.
 * @param {any} s a relay state / ready frame: `{connection?: {app?}, connections?: {id, app?, lastUsed?}[]}`
 * @param {string | null} [grantId]
 */
export function whoOf(s, grantId = null) {
	const list = Array.isArray(s?.connections) ? s.connections : [];
	const byId = grantId ? list.find((/** @type {any} */ g) => g.id === grantId) : null;
	if (byId) return appNameOf(byId);
	if (s?.connection) return appNameOf(s.connection);
	const recent = [...list].sort((/** @type {any} */ a, /** @type {any} */ b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))[0];
	return recent ? appNameOf(recent) : FALLBACK_APP;
}

/** The fixed-shape label of the connector's lines and undo steps ("Claude (connector)"). @param {string} who */
export const connectorLabelFor = (who) => (who || FALLBACK_APP) + ' (connector)';
