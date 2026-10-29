// Roadmap 86 T4 (+ 56 C19) — THE STATIC TOOL CATALOG, one builder for every MCP surface that must list
// tools before a page is up: the Claude connector's Worker (claude.ai reads tools/list ONCE, at chat
// start, and ignores list_changed) and `serve --static-tools`. Pure: no SDK, no browser.
//
// The host half is whatever the app's `tpAgent.tools()` answers (core `scripts/agent-tool-catalog.mjs`
// loads the app's own modules to get it), mapped by mcpTools.js exactly as a live session maps it, plus
// the bridge tools a tab answers itself. Nobody hand-writes a tool. The instructions (86 T3) are built
// from the same list, so a line about a tool appears only while that tool exists.

import { mapHostTools, bridgeTools } from './mcpTools.js';

/** Bump when the catalog's SHAPE changes (not when tools change). */
export const CATALOG_FORMAT = 1;

/**
 * The server instructions for a voice-first client (claude.ai chat, phone and voice mode). Short,
 * spoken-style, and only about tools in `names`.
 * @param {string[]} names the tool names the client will see
 * @returns {string}
 */
export function connectorInstructions(names) {
	const has = new Set(names);
	const lines = [
		'You are building in the person\'s own open theprototype.app tab: a live, shared 3D scene. Every change shows for everyone in the session and can be undone.',
		'This may be a VOICE conversation: answer in one or two short spoken sentences and say what changed in plain words ("Added three trees by the fire"). Never read out uuids, lists of numbers or JSON.',
		'If a tool says the tab is closed or not connected, tell the person to open theprototype.app and press Connect Claude, then wait; do not retry in a loop.'
	];
	if (has.has('status')) lines.push('Call status first: it says whether you may edit (a viewer can only look).');
	if (has.has('list_scene')) lines.push('Call list_scene before editing so you use real uuids; batch many objects into one call.');
	if (has.has('where_are_users'))
		lines.push('For "in front of me", "here" or "this", call where_are_users and build at the spots it gives, facing the person.');
	if (has.has('attach_to_user')) lines.push('For "give me a flashlight" or another prop, make the object, then attach_to_user to the person who asked.');
	if (has.has('create_flow_nodes'))
		lines.push(
			'Motion and interaction are flow nodes (create_flow_nodes)' + (has.has('describe_node_types') ? '; call describe_node_types before wiring edges.' : '.')
		);
	if (has.has('screenshot')) lines.push('Use screenshot to check a result when it matters, not after every step.');
	if (has.has('what_can_you_do')) lines.push('When asked what you can do here, call what_can_you_do and say its "say" line.');
	return lines.join('\n');
}

/**
 * Host tools (tpAgent.tools()'s shape) → the static catalog.
 * @param {any[]} hostTools
 * @param {{provenance?: Record<string, any>}} [opts]
 * @returns {{format: number, generator: Record<string, any>, instructions: string, tools: {name: string, description: string, inputSchema: any}[]}}
 */
export function buildCatalog(hostTools, opts = {}) {
	if (!Array.isArray(hostTools) || !hostTools.length) throw new Error('the host tool list is empty');
	const mapped = mapHostTools(hostTools);
	// the bridge tools a page answers itself; `connect` is the agent CLI's (the Worker drops it, serve keeps it)
	const tools = [...mapped.tools, ...bridgeTools('browser')];
	return {
		format: CATALOG_FORMAT,
		generator: {
			source: 'tpAgent.tools() via core scripts/agent-tool-catalog.mjs, mapped by tools/agent/src/catalog.js',
			hostTools: hostTools.length,
			dropped: mapped.dropped,
			...(opts.provenance ?? {})
		},
		instructions: connectorInstructions(tools.map((t) => t.name)),
		tools
	};
}
