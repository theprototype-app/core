// Roadmap 104 — the person's tools by NAME, and which calls only read: the few hundred bytes the connector
// dispatcher needs on every call, apart from the schemas (personTools.js) so nothing else rides along.

// 107-ui-state: ui_state + scene_stats (the connector's run {ui, stats})
export const PERSON_TOOL_NAMES = /** @type {const} */ (['files', 'show', 'scene', 'ui_state', 'scene_stats']);

/** tools that only read on these arguments (a read-scoped connector and a viewer may call them) @param {string} name @param {any} args */
export function personToolReads(name, args) {
	const action = String(args?.action ?? '');
	if (name === 'files') return action === 'list' || action === 'read';
	if (name === 'scene') return action === 'list';
	// 107-panels: the panel registry with each panel's state
	if (name === 'show') return action === 'panels';
	if (name === 'ui_state') return true; // 107-ui-state
	if (name === 'scene_stats') return action !== 'target'; // 107-ui-state: target changes the person's Statistics view
	return false;
}
