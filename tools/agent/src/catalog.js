// Roadmap 86 T4 (+ 56 C19) — THE STATIC TOOL CATALOG, one builder for every MCP surface that must list
// tools before a page is up: the Claude connector's Worker (claude.ai reads tools/list ONCE, at chat
// start, and ignores list_changed) and `serve --static-tools`. Pure: no SDK, no browser.
//
// The host half is whatever the app's `tpAgent.tools()` answers (core `scripts/agent-tool-catalog.mjs`
// loads the app's own modules to get it), mapped by mcpTools.js exactly as a live session maps it, plus
// the bridge tools a tab answers itself. Nobody hand-writes a tool. The instructions (86 T3) are built
// from the same list, so a line about a tool appears only while that tool exists.

import { mapHostTools, bridgeTools, connectorOnlyTools } from './mcpTools.js';

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
	save_scene: { title: 'Save the scene', destructive: false },
	import_model: { title: 'Import a 3D model', destructive: false },
	import_file: { title: 'Import a file', destructive: false },
	update_objects: { title: 'Change objects', destructive: true },
	update_flow_nodes: { title: 'Change or remove flow nodes', destructive: true },
	edit_behaviour: { title: 'Edit a code behaviour', destructive: true },
	set_physics: { title: 'Set physics', destructive: true },
	control_simulation: { title: 'Run or stop the simulation', destructive: true },
	delete_objects: { title: 'Delete objects', destructive: true },
	clear_scene: { title: 'Clear the scene', destructive: true },
	create_lathe: { title: 'Make a lathed shape', destructive: false },
	create_tube: { title: 'Make a tube along a path', destructive: false },
	extrude_shape: { title: 'Extrude an outline', destructive: false },
	create_mesh: { title: 'Make a mesh from data', destructive: false },
	set_geometry: { title: 'Reshape objects', destructive: true },
	edit_mesh: { title: 'Edit a mesh', destructive: true },
	set_material: { title: 'Change materials and textures', destructive: true, openWorld: true },
	list_materials: { title: 'Read materials', read: true },
	get_material: { title: 'Read one material', read: true },
	create_shader: { title: 'Give objects a shader', destructive: true },
	edit_shader: { title: 'Edit a shader', destructive: true },
	assign_shader: { title: 'Copy or remove a shader', destructive: true },
	describe_shader_nodes: { title: 'Look up shader node types', read: true },
	set_post: { title: 'Change the post effects', destructive: true },
	get_post: { title: 'Read the post effects', read: true },
	create_post_graph: { title: 'Add a custom post effect', destructive: false },
	uv_unwrap: { title: 'Unwrap UVs', destructive: true },
	set_uv: { title: 'Set texture tiling or face mapping', destructive: true },
	undo_last: { title: 'Undo your last change', destructive: true },
	set_pivot: { title: 'Set the point an object turns about', destructive: true },
	create_pivot: { title: 'Make a pivot group', destructive: false },
	add_image: { title: 'Add an image to the library', destructive: false, openWorld: true },
	install_modules: { title: 'Install modules', destructive: false, openWorld: true },
	accept_offer: { title: 'Answer a question the app asks', destructive: true },
	connect: { title: 'Join a session', destructive: false, openWorld: true },
	// 86-fix N2: the connector's join — the person confirms in the tab; joining may replace what the tab shows
	join_session: { title: 'Join a session (asks the person)', destructive: true, openWorld: true },
	where_are_users: { title: 'Where the people are', read: true },
	// 85b 85-world
	search_assets: { title: 'Find assets', read: true, openWorld: true },
	place_asset: { title: 'Place an asset', destructive: false, openWorld: true },
	prefab: { title: 'Save or place a prefab', destructive: false },
	create_particles: { title: 'Add particles', destructive: true },
	scatter: { title: 'Scatter over a surface', destructive: true },
	terrain: { title: 'Make or shape terrain', destructive: true },
	water: { title: 'Add or change water', destructive: true },
	place_sound: { title: 'Place a sound', destructive: false, openWorld: true },
	set_music: { title: 'Set the background music', destructive: true, openWorld: true },
	update_mesh: { title: 'Change a mesh made from data', destructive: true }
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

/** every edit tool: the catalog's non-read tools @type {'EDITS'} */
const EDITS = 'EDITS';

/**
 * 86-fix B4 — THE GUIDANCE, ONE TABLE. claude.ai drops a server's `instructions`, so every line that matters
 * lives in the DESCRIPTION of the tools it is about (`on`); the instructions are the same lines for the
 * clients that do read them. `when` = the tool that must exist for the line to appear at all (default: the
 * first of `on`). `guidanceGaps` (catalog:agent --check, the unit test) fails on an instruction line no
 * description carries.
 * @type {{line: string, on: (string|'EDITS')[], when?: string}[]}
 */
export const GUIDANCE = [
	{
		line: 'You are building in the person\'s own open theprototype.app tab: a live, shared 3D scene. Every change shows for everyone in the session and can be undone.',
		on: ['status', 'what_can_you_do']
	},
	{
		line: 'This may be a VOICE conversation: answer in one or two short spoken sentences and say what changed in plain words ("Added three trees by the fire"). Never read out uuids, lists of numbers or JSON.',
		on: ['status', 'what_can_you_do', 'create_objects']
	},
	{
		line: 'If a tool says the tab is closed or not connected, tell the person to open theprototype.app and press Connect Claude, then wait; do not retry in a loop.',
		on: ['status', 'list_scene']
	},
	{ line: 'Call status first: it says whether you may edit (a viewer can only look).', on: ['status'] },
	{ line: 'When the person says "undo that" or "take that back", call undo_last; if it refuses, say who changed what.', on: ['undo_last'] },
	{
		line: 'You act as this person in their own tab: status "you" is them (their peer id, name and role); the other users are everyone else.',
		on: ['status', 'where_are_users'],
		when: 'join_session'
	},
	{ line: 'Call list_scene before editing so you use real uuids; batch many objects into one call.', on: ['list_scene', 'create_objects', 'update_objects'] },
	{
		line: 'For "in front of me", "here" or "this", call where_are_users and build at the spots it gives, facing the person.',
		on: ['where_are_users', 'create_objects']
	},
	{ line: 'For "give me a flashlight" or another prop, make the object, then attach_to_user to the person who asked.', on: ['attach_to_user'] },
	{
		line: 'Motion and interaction are flow nodes (create_flow_nodes); call describe_node_types before wiring edges.',
		on: ['create_flow_nodes', 'describe_node_types'],
		when: 'describe_node_types'
	},
	{ line: 'Motion and interaction are flow nodes (create_flow_nodes).', on: ['create_flow_nodes'], when: '!describe_node_types' },
	{ line: 'Take a screenshot after each change to check your work.', on: [EDITS], when: 'screenshot' },
	{ line: 'When asked what you can do here, call what_can_you_do and say its "say" line.', on: ['what_can_you_do'] }
];

/** @param {{line: string, on: string[], when?: string}} g @param {Set<string>} has */
function applies(g, has) {
	const when = g.when ?? g.on.find((n) => n !== EDITS) ?? '';
	return when.startsWith('!') ? has.has(g.on[0]) && !has.has(when.slice(1)) : has.has(when);
}

/**
 * The server instructions for a voice-first client (claude.ai chat, phone and voice mode). Short,
 * spoken-style, and only about tools in `names` — the GUIDANCE lines, verbatim.
 * @param {string[]} names the tool names the client will see
 * @returns {string}
 */
export function connectorInstructions(names) {
	const has = new Set(names);
	return GUIDANCE.filter((g) => applies(g, has))
		.map((g) => g.line)
		.join('\n');
}

/**
 * The GUIDANCE lines appended to each tool's description (86-fix B4: claude.ai reads descriptions, not
 * instructions). A tool's own text comes first; each line once.
 * @template {{name: string, description: string, annotations?: any}} T @param {T[]} tools @returns {T[]}
 */
export function withGuidance(tools) {
	const has = new Set(tools.map((t) => t.name));
	return tools.map((t) => {
		const isEdit = !(t.annotations?.readOnlyHint === true);
		const lines = GUIDANCE.filter((g) => applies(g, has) && (g.on.includes(t.name) || (isEdit && g.on.includes(EDITS)))).map((g) => g.line);
		const own = String(t.description ?? '').trim();
		return lines.length ? { ...t, description: [own, ...lines.filter((l) => !own.includes(l))].filter(Boolean).join('\n') } : t;
	});
}

/**
 * Instruction lines no tool description carries — the check `catalog:agent --check` runs (86-fix B4).
 * @param {{instructions?: string, tools: {description: string}[]}} catalog @returns {string[]}
 */
export function guidanceGaps(catalog) {
	const lines = String(catalog.instructions ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
	return lines.filter((l) => !catalog.tools.some((t) => String(t.description ?? '').includes(l)));
}

/**
 * Host tools (tpAgent.tools()'s shape) → the static catalog.
 * @param {any[]} hostTools
 * @param {{provenance?: Record<string, any>, connectorExcluded?: string[]}} [opts]
 * @returns {{format: number, generator: Record<string, any>, instructions: string, tools: {name: string, title: string, description: string, inputSchema: any, annotations: Record<string, any>}[]}}
 */
export function buildCatalog(hostTools, opts = {}) {
	if (!Array.isArray(hostTools) || !hostTools.length) throw new Error('the host tool list is empty');
	const mapped = mapHostTools(hostTools);
	// the bridge tools a page answers itself; `connect` is the agent CLI's (the Worker drops it, serve keeps it)
	const plain = [...mapped.tools, ...bridgeTools('browser'), ...connectorOnlyTools()].map(annotate);
	const tools = withGuidance(plain);
	const connector = opts.connectorExcluded ? connectorView(plain, opts.connectorExcluded) : undefined;
	return {
		format: CATALOG_FORMAT,
		generator: {
			source: 'tpAgent.tools() via core scripts/agent-tool-catalog.cjs, mapped by tools/agent/src/catalog.js',
			hostTools: hostTools.length,
			dropped: mapped.dropped,
			...(opts.provenance ?? {})
		},
		instructions: connectorInstructions(tools.map((t) => t.name)),
		// mcp-fix: what the connector leaves out, on purpose (core's CONNECTOR_BLOCKED_TOOLS); the Worker checks against it
		...(opts.connectorExcluded ? { connectorExcluded: [...opts.connectorExcluded].sort() } : {}),
		tools,
		// 85a TB: what the claude.ai connector lists — the same tools, with the 85 ones grouped into families
		...(connector ? { connector } : {})
	};
}

/**
 * 85a TB — THE CONNECTOR'S TOOL FAMILIES (owner tool budget 2026-11-01, roadmap 85's table). The claude.ai
 * connector stays at about 40 tools and its 22 published tools never change, so new work joins as ONE tool per
 * family with an `action` field. Grouping happens ONLY here (and in the Worker, which turns `{action, <action>:
 * {...}}` back into the fine tool before relaying): the tab, local agents and `serve` keep the fine names.
 * `actions` maps an action to the fine tool it runs. The action's fields go in an object named after the action,
 * which carries the fine tool's own schema and description, so nothing about a tool is lost by grouping it.
 * mcp-shapes: a family may also have a BATCH — `batch: {key, tool}` — called as `{<key>: [...]}` with no action
 * (create_shape {shapes: [{action, mesh: {...}}, ...]}); the families map carries it as action `<key>`.
 * 85b (85-world) built edit_shape `update` (G6b update_mesh), assets search / place / prefab and the effects family.
 * Reserved, not built yet: set_look environment / sky / light (85-scene, 85b), create_shape from_image (73's
 * image-to-3D is generate_mesh, which the connector leaves out).
 * @type {Readonly<Record<string, {title: string, summary: string, actions: Record<string, string>, batch?: {key: string, tool: string}}>>}
 */
export const CONNECTOR_FAMILIES = Object.freeze({
	create_shape: {
		title: 'Make a shape',
		summary:
			'Make shapes the basic objects cannot: a lathe (a vase, a bowl, a lamp from a profile turned around an axis), a tube along a path (a rail, a pipe, a cable), an extruded outline (a sign, a star, a wall with a hole), or a mesh from your own vertices (anything else).',
		actions: { lathe: 'create_lathe', tube: 'create_tube', extrude: 'extrude_shape', mesh: 'create_mesh' },
		batch: { key: 'shapes', tool: 'create_shapes' }
	},
	edit_shape: {
		title: 'Reshape or model objects',
		summary:
			'Change the shape of objects that exist: params = new size / segments / type in place, mesh = model faces and vertices (extrude, inset, bevel, subdivide, weld, smooth, dissolve, make a face), update = new vertices / faces for a mesh made from data (replace it, or patch a range), pivot = the point an object turns about, pivot_group = a group at a joint so several parts swing together.',
		actions: { params: 'set_geometry', mesh: 'edit_mesh', update: 'update_mesh', pivot: 'set_pivot', pivot_group: 'create_pivot' }
	},
	set_look: {
		title: 'Materials, shaders, UVs and post effects',
		summary:
			'How things look: material = colour, roughness, metal, glow, see-through and textures (a library image, a CC0 material by name or an https image); list_materials / get_material read them; shader / edit_shader / assign_shader / shader_nodes = node shaders on objects; post / get_post / post_graph = the scene\'s post effects (bloom, colour grade, vignette; the host is asked first); unwrap / uv = texture mapping and tiling.',
		actions: {
			material: 'set_material',
			list_materials: 'list_materials',
			get_material: 'get_material',
			shader: 'create_shader',
			edit_shader: 'edit_shader',
			assign_shader: 'assign_shader',
			shader_nodes: 'describe_shader_nodes',
			post: 'set_post',
			get_post: 'get_post',
			post_graph: 'create_post_graph',
			unwrap: 'uv_unwrap',
			uv: 'set_uv'
		}
	},
	assets: {
		title: 'Images and assets',
		summary:
			'Assets to build with: search = find models, prefabs, sounds, images, CC0 materials and HDRIs by words (library, packs, Poly Haven); place = put a found model or prefab into the scene; prefab = keep objects as a reusable prefab, or place copies of one; image = put an image into the library (an https URL, base64 data, or a canvas you describe) and get its hash for textures.',
		actions: { search: 'search_assets', place: 'place_asset', prefab: 'prefab', image: 'add_image' }
	},
	// 85b (1.60, the tool budget's effects row)
	effects: {
		title: 'Terrain, scatter, water, particles and sound',
		summary:
			'The world around the build: terrain = make or shape ground (noise hills, sculpt, paint layers); scatter = many trees, rocks or flowers over a terrain or mesh, with slope / height rules; water = a pool, lake or ocean, or make an object water; particles = fire, smoke, sparkles, fireflies, rain, snow … by preset; sound = a positional sound (looping, or on click / enter); music = the scene\'s background track.',
		actions: { terrain: 'terrain', scatter: 'scatter', water: 'water', particles: 'create_particles', sound: 'place_sound', music: 'set_music' }
	}
});

/** Connector tools that are not in a family: the 22 published ones + undo_last (1.56). A tool in none of these,
 * no family and not left out on purpose fails the generator: a new connector name needs an owner row. */
export const CONNECTOR_STANDALONE = Object.freeze([
	'list_scene',
	'create_objects',
	'update_objects',
	'delete_objects',
	'group_objects',
	'clear_scene',
	'animate_parts',
	'create_flow_nodes',
	'update_flow_nodes',
	'describe_node_types',
	'create_behaviour',
	'edit_behaviour',
	'set_physics',
	'create_joints',
	'control_simulation',
	'what_can_you_do',
	'save_scene',
	'status',
	'screenshot',
	'wait_for_edit',
	'join_session',
	'where_are_users',
	'undo_last',
	// left out by the Worker's own policy (generate_mesh), kept listed so the Worker's EXCLUDED_TOOLS stays the scope call
	'generate_mesh'
]);

/** fine tool → `family {action}` wording, for text the connector's model reads @returns {Map<string, string>} */
export function familyNames() {
	const out = new Map();
	for (const [family, f] of Object.entries(CONNECTOR_FAMILIES)) {
		for (const [action, tool] of Object.entries(f.actions)) out.set(tool, family + " {action: '" + action + "'}");
		if (f.batch) out.set(f.batch.tool, family + ' {' + f.batch.key + ': […]}');
	}
	return out;
}

/** a text with every fine family-member name said the connector's way @param {string} text */
export function sayFamilyNames(text) {
	const names = familyNames();
	return names.size ? String(text).replace(new RegExp('\\b(' + [...names.keys()].join('|') + ')\\b', 'g'), (m) => names.get(m) ?? m) : String(text);
}

/**
 * The connector's view of the catalog: standalone tools as they are, family members replaced by their family
 * (at the first member's place). Throws when a tool is in no list — the budget rule.
 * @param {{name: string, title: string, description: string, inputSchema: any, annotations: Record<string, any>}[]} plain annotated, before guidance
 * @param {string[]} excluded core's CONNECTOR_BLOCKED_TOOLS
 */
export function connectorView(plain, excluded) {
	const byName = new Map(plain.map((t) => [t.name, t]));
	const familyOf = new Map();
	for (const [family, f] of Object.entries(CONNECTOR_FAMILIES)) for (const tool of [...Object.values(f.actions), ...(f.batch ? [f.batch.tool] : [])]) familyOf.set(tool, family);
	const stray = plain.map((t) => t.name).filter((n) => !CONNECTOR_STANDALONE.includes(n) && !familyOf.has(n) && !excluded.includes(n));
	if (stray.length)
		throw new Error('tools with no place in the connector (tools/agent/src/catalog.js CONNECTOR_FAMILIES / CONNECTOR_STANDALONE / CONNECTOR_BLOCKED_TOOLS): ' + stray.join(', '));
	/** @type {any[]} */
	const list = [];
	/** @type {Record<string, Record<string, string>>} */
	const families = {};
	let placed = false;
	for (const t of plain) {
		if (!familyOf.has(t.name)) {
			list.push(t);
			continue;
		}
		if (placed) continue;
		// every family at the place of the first member, in the table's order
		placed = true;
		for (const [family, f] of Object.entries(CONNECTOR_FAMILIES)) {
			const actions = Object.entries(f.actions).filter(([, tool]) => byName.has(tool));
			if (!actions.length) continue;
			const batch = f.batch && byName.has(f.batch.tool) ? f.batch : null;
			families[family] = { ...Object.fromEntries(actions), ...(batch ? { [batch.key]: batch.tool } : {}) };
			list.push(
				familyTool(
					family,
					f,
					actions.map(([action, tool]) => [action, /** @type {any} */ (byName.get(tool))]),
					batch ? { key: batch.key, tool: /** @type {any} */ (byName.get(batch.tool)) } : null
				)
			);
		}
	}
	const tools = withGuidance(list);
	return { instructions: connectorInstructions(tools.map((t) => t.name)), families, tools };
}

/**
 * One family as one MCP tool. `{action, <action>: {...}}`; the per-action object has the fine tool's own schema.
 * A batch (mcp-shapes) adds its list at the top level — `{<key>: [...]}`, no action — so `action` is then optional.
 * @param {string} family @param {{title: string, summary: string}} f @param {[string, any][]} actions
 * @param {{key: string, tool: any} | null} [batch]
 */
function familyTool(family, f, actions, batch = null) {
	/** @type {Record<string, any>} */
	const properties = {
		action: { type: 'string', enum: actions.map(([a]) => a), description: 'What to do. Put its fields in the object named after the action.' }
	};
	for (const [action, t] of actions) properties[action] = { ...t.inputSchema, description: sayFamilyNames(t.description) };
	const example = actions[0][0];
	let description =
		f.summary + '\nCall it as {"action": "' + example + '", "' + example + '": {…its fields…}}; each action\'s fields and limits are in its object below.';
	if (batch) {
		const list = batch.tool.inputSchema?.properties?.[batch.key];
		properties[batch.key] = { ...(list ?? { type: 'array' }), description: sayFamilyNames(batch.tool.description) };
		description += '\nMany at once: {"' + batch.key + '": [{"action": "' + example + '", "' + example + '": {…}}, …]} with no action — one call, one undo step.';
	}
	const all = batch ? [...actions, [batch.key, batch.tool]] : actions;
	const edits = all.filter(([, t]) => !t.annotations.readOnlyHint);
	const annotations = {
		title: f.title,
		readOnlyHint: false,
		destructiveHint: edits.some(([, t]) => t.annotations.destructiveHint !== false),
		openWorldHint: all.some(([, t]) => t.annotations.openWorldHint === true)
	};
	return { name: family, title: f.title, description, inputSchema: { type: 'object', properties, ...(batch ? {} : { required: ['action'] }) }, annotations };
}

/**
 * The Worker's half, kept here so core's unit tests cover it with the same tables: a family call → the fine tool
 * and its arguments. A missing per-action object falls back to the call's other fields (a model that flattened them).
 * @param {Record<string, Record<string, string>>} families @param {string} name @param {any} args
 * @returns {{tool: string, args: any} | {error: string} | null} null = not a family
 */
export function resolveFamilyCall(families, name, args) {
	const actions = families?.[name];
	if (!actions) return null;
	// mcp-shapes: a batch is called with its list and no action (create_shape {shapes: [...]})
	const batchKey = typeof args?.action !== 'string' ? Object.keys(actions).find((k) => Array.isArray(args?.[k])) : undefined;
	if (batchKey) return { tool: actions[batchKey], args: { [batchKey]: args[batchKey] } };
	const action = typeof args?.action === 'string' ? args.action : '';
	const tool = actions[action];
	if (!tool) return { error: name + ' needs an action: one of ' + Object.keys(actions).join(', ') + '.' };
	const inner = args[action];
	if (inner && typeof inner === 'object' && !Array.isArray(inner)) return { tool, args: inner };
	const { action: _a, ...rest } = args;
	for (const a of Object.keys(actions)) delete rest[a];
	return { tool, args: rest };
}

/**
 * mcp-fix: the tab's list and the catalog must agree. Fails on a tool a connector tab answers that the catalog neither
 * lists nor leaves out on purpose, and on a listed tool no connector tab can answer. `tabTools` comes from a real
 * createConnectorAgent(); `conditional` = tools the tab offers only sometimes (status.missingTools says why).
 * @param {{tabTools: string[], own: string[], conditional?: string[], catalogTools: string[], excluded: string[]}} facts
 * @returns {string[]} the problems, in words
 */
export function connectorToolGaps(facts) {
	const { tabTools, own, conditional = [], catalogTools, excluded } = facts;
	const out = new Set(excluded);
	const listed = new Set(catalogTools.filter((n) => !out.has(n)));
	const answered = new Set([...tabTools, ...own, ...conditional].filter((n) => !out.has(n)));
	return [
		...[...answered].filter((n) => !listed.has(n)).map((n) => n + ': a connector tab answers it, but it is neither in the catalog nor in CONNECTOR_BLOCKED_TOOLS'),
		...[...listed].filter((n) => !answered.has(n)).map((n) => n + ': in the catalog, but no connector tab answers it')
	];
}
