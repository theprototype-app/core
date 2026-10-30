// Roadmap 86 T4 (+ 56 C19) — THE STATIC TOOL CATALOG, one builder for every MCP surface that must list
// tools before a page is up: the Claude connector's Worker (claude.ai reads tools/list ONCE, at chat
// start, and ignores list_changed) and `serve --static-tools`. Pure: no SDK, no browser.
//
// The host half is whatever the app's `tpAgent.tools()` answers (core `scripts/agent-tool-catalog.mjs`
// loads the app's own modules to get it), mapped by mcpTools.js exactly as a live session maps it, plus
// the bridge tools a tab answers itself. Nobody hand-writes a tool. The instructions (86 T3) are built
// from the same list, so a line about a tool appears only while that tool exists.

import { mapHostTools, bridgeTools } from './mcpTools.js';

/** Bump when the catalog's SHAPE changes (not when tools change). 2 = titles + annotations. */
export const CATALOG_FORMAT = 2;

/**
 * Per tool: a human title, whether it only reads, and whether an edit may overwrite or remove what is
 * there (MCP `destructiveHint`; false = only adds). The Claude connector directory requires a title and
 * a read-only / destructive hint on EVERY tool. Everything an agent does is undoable, but the hints say
 * what a call does, not whether it can be taken back. A tool missing here is treated as a destructive
 * edit (fail closed) with a title made from its name.
 */
export const TOOL_ANNOTATIONS = /** @type {Record<string, {title: string, read?: true, destructive?: boolean, openWorld?: true}>} */ ({
	list_scene: { title: 'Read the scene', read: true },
	describe_node_types: { title: 'Look up flow node types', read: true },
	what_can_you_do: { title: 'What can you do here', read: true },
	status: { title: 'Session status', read: true },
	screenshot: { title: 'Take a picture of the scene', read: true },
	wait_for_edit: { title: 'Wait for someone to edit', read: true },
	pending_offers: { title: 'List questions the app is asking', read: true },
	create_objects: { title: 'Add objects', destructive: false },
	create_flow_nodes: { title: 'Add behaviour (flow) nodes', destructive: false },
	create_behaviour: { title: 'Add a code behaviour', destructive: false },
	create_joints: { title: 'Add physics joints', destructive: false },
	group_objects: { title: 'Group objects', destructive: false },
	generate_mesh: { title: 'Generate a 3D model', destructive: false, openWorld: true },
	update_objects: { title: 'Change objects', destructive: true },
	update_flow_nodes: { title: 'Change or remove flow nodes', destructive: true },
	edit_behaviour: { title: 'Edit a code behaviour', destructive: true },
	set_physics: { title: 'Set physics', destructive: true },
	control_simulation: { title: 'Run or stop the simulation', destructive: true },
	delete_objects: { title: 'Delete objects', destructive: true },
	clear_scene: { title: 'Clear the scene', destructive: true },
	install_modules: { title: 'Install modules', destructive: false, openWorld: true },
	accept_offer: { title: 'Answer a question the app asks', destructive: true },
	connect: { title: 'Join a session', destructive: false, openWorld: true }
});

/** a title from a tool name: `create_objects` → `Create objects` @param {string} name */
const titleOf = (name) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/_/g, ' ');

/**
 * A catalog tool with `title` + `annotations` (MCP 2025-06-18 shapes).
 * @param {{name: string, description: string, inputSchema: any}} t
 */
export function annotate(t) {
	const a = TOOL_ANNOTATIONS[t.name];
	const title = a?.title ?? titleOf(t.name);
	/** @type {Record<string, any>} */
	const annotations = { title, readOnlyHint: !!a?.read };
	if (!a?.read) annotations.destructiveHint = a?.destructive ?? true;
	annotations.openWorldHint = !!a?.openWorld;
	return { name: t.name, title, description: t.description, inputSchema: t.inputSchema, annotations };
}

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
 * @returns {{format: number, generator: Record<string, any>, instructions: string, tools: {name: string, title: string, description: string, inputSchema: any, annotations: Record<string, any>}[]}}
 */
export function buildCatalog(hostTools, opts = {}) {
	if (!Array.isArray(hostTools) || !hostTools.length) throw new Error('the host tool list is empty');
	const mapped = mapHostTools(hostTools);
	// the bridge tools a page answers itself; `connect` is the agent CLI's (the Worker drops it, serve keeps it)
	const tools = [...mapped.tools, ...bridgeTools('browser')].map(annotate);
	return {
		format: CATALOG_FORMAT,
		generator: {
			source: 'tpAgent.tools() via core scripts/agent-tool-catalog.cjs, mapped by tools/agent/src/catalog.js',
			hostTools: hostTools.length,
			dropped: mapped.dropped,
			...(opts.provenance ?? {})
		},
		instructions: connectorInstructions(tools.map((t) => t.name)),
		tools
	};
}
