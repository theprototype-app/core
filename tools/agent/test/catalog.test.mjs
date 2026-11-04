// The static tool catalog (roadmap 86 T4 + 56 C19) and its voice instructions (86 T3). Pure: no browser.
// Run: node test/catalog.test.mjs
import fs from 'node:fs';
import { buildCatalog, connectorInstructions, annotate, guidanceGaps, withGuidance, CATALOG_FORMAT, CONNECTOR_FAMILIES, CONNECTOR_STANDALONE, connectorView, resolveFamilyCall, sayFamilyNames, sayToolNames, familyNames } from '../src/catalog.js';
import { BRIDGE_TOOL_NAMES } from '../src/mcpTools.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
	if (cond) {
		pass++;
		console.log('PASS ' + name);
	} else {
		fail++;
		console.log('FAIL ' + name);
	}
};

const host = [
	{ type: 'function', function: { name: 'list_scene', description: 'look', parameters: { type: 'object', properties: {} } } },
	{ type: 'function', function: { name: 'create_objects', description: 'make', parameters: { type: 'object', properties: { objects: { type: 'array' } } } } },
	{ type: 'function', function: { name: 'status', description: 'a host tool shadowing a bridge tool', parameters: {} } },
	{ type: 'function', function: { name: 'bad name!', description: 'dropped' } }
];
const c = buildCatalog(host, { provenance: { coreRef: 'v9.9.9' } });
check('format is stamped', c.format === CATALOG_FORMAT);
check('host tools first, schemas verbatim', c.tools[1].name === 'create_objects' && c.tools[1].inputSchema.properties.objects.type === 'array');
check('the bridge tools follow (connect, status, screenshot, wait_for_edit)', BRIDGE_TOOL_NAMES.every((n) => c.tools.some((t) => t.name === n)));
check('a host tool shadowing a bridge tool and an invalid name are dropped and reported', c.generator.dropped.includes('status') && c.generator.dropped.includes('bad name!'));
check('provenance is kept', c.generator.coreRef === 'v9.9.9' && c.generator.hostTools === 4);
let threw = false;
try {
	buildCatalog([]);
} catch {
	threw = true;
}
check('an empty host list is refused (a broken capture must not publish an empty catalog)', threw);

// the connector directory: every tool has a title and a read-only or destructive hint
check('every tool has a title and readOnlyHint (+ destructiveHint on edits)', c.tools.every((t) => t.title && t.annotations.title === t.title && typeof t.annotations.readOnlyHint === 'boolean' && (t.annotations.readOnlyHint || typeof t.annotations.destructiveHint === 'boolean')));
check('list_scene reads, create_objects only adds, delete_objects destroys', annotate({ name: 'list_scene' }).annotations.readOnlyHint === true && annotate({ name: 'create_objects' }).annotations.destructiveHint === false && annotate({ name: 'delete_objects' }).annotations.destructiveHint === true);
const unknown = annotate({ name: 'brand_new_tool', description: '', inputSchema: {} });
check('an unlisted tool fails closed: a destructive edit with a title from its name', unknown.title === 'Brand new tool' && unknown.annotations.readOnlyHint === false && unknown.annotations.destructiveHint === true);

// T3: the instructions speak only about tools that exist
const base = connectorInstructions(['status', 'list_scene', 'create_objects']);
check('voice rules are always there', /VOICE/.test(base) && /Never read out uuids/.test(base) && /Connect Claude/.test(base));
check('no line about a missing tool', !/where_are_users|describe_node_types|screenshot|what_can_you_do|attach_to_user/.test(base));
const full = connectorInstructions(['status', 'list_scene', 'create_flow_nodes', 'describe_node_types', 'where_are_users', 'attach_to_user', 'screenshot', 'what_can_you_do']);
check('spatial (85 S1) and prop (85 P1) lines appear once the tools land', /where_are_users/.test(full) && /flashlight/.test(full));
check('describe_node_types is named beside flow nodes', /describe_node_types before wiring/.test(full));
check('the instructions stay short (< 1500 chars)', full.length < 1500);

// 86-fix B4: claude.ai drops server instructions — every instruction line lives in a tool description too
check('every instruction line is in some tool description (built catalog)', guidanceGaps(c).length === 0);
const edits = c.tools.filter((t) => !t.annotations.readOnlyHint);
check('every edit tool says to take a screenshot after the change', edits.length > 0 && edits.every((t) => /Take a screenshot after each change to check your work\./.test(t.description)));
check('read tools do not carry the screenshot line', c.tools.filter((t) => t.annotations.readOnlyHint).every((t) => !/Take a screenshot after each change/.test(t.description)));
check('status says to call it first and carries the voice rules', /Call status first/.test(c.tools.find((t) => t.name === 'status').description) && /VOICE/.test(c.tools.find((t) => t.name === 'status').description));
check('a tool keeps its own text first', c.tools.find((t) => t.name === 'create_objects').description.startsWith('make'));
check('a line only the instructions carry is a gap (the check catalog:agent --check runs)', guidanceGaps({ instructions: 'Say hello.\n' + c.instructions, tools: c.tools }).join() === 'Say hello.');
check('withGuidance never repeats a line a description already holds', withGuidance([{ name: 'status', description: 'Call status first: it says whether you may edit (a viewer can only look).', annotations: { readOnlyHint: true } }])[0].description.split('Call status first').length === 2);
check('where_are_users (86-fix) is listed read-only and names the person you act as', c.tools.some((t) => t.name === 'where_are_users' && t.annotations.readOnlyHint === true && /"you": true/.test(t.description) && /in front of me/.test(t.description)));
check('status says you act as the person in their own tab', /You act as this person in their own tab/.test(c.tools.find((t) => t.name === 'status').description));
check('join_session (86-fix N2) is listed as an edit that asks the person', c.tools.some((t) => t.name === 'join_session' && t.annotations.destructiveHint === true && /presses Join/.test(t.description)));

// 85a TB: the connector's families (owner tool budget 2026-11-01)
{
	const fine = (name, extra = {}) => annotate({ name, description: 'about ' + name + ', see set_pivot', inputSchema: { type: 'object', properties: { x: { type: 'number' } } }, ...extra });
	const plain = [fine('list_scene'), fine('create_lathe'), fine('set_pivot'), fine('get_material'), fine('set_material'), fine('undo_last'), fine('import_file')];
	const v = connectorView(plain, ['import_file']);
	const names = v.tools.map((t) => t.name);
	check('TB: family members are replaced by their family, standalone + excluded tools stay', names.join() === 'list_scene,create_shape,edit_shape,set_look,undo_last,import_file');
	check('TB: a family lists only the actions whose tool exists', JSON.stringify(v.families.create_shape) === '{"lathe":"create_lathe"}' && Object.keys(v.families.set_look).join() === 'material,get_material');
	const look = v.tools.find((t) => t.name === 'set_look');
	check('TB: the action is required and an enum; each action carries its tool\'s own schema', look.inputSchema.required.join() === 'action' && look.inputSchema.properties.action.enum.join() === 'material,get_material' && look.inputSchema.properties.material.properties.x.type === 'number');
	check('TB: fine names inside a family say the connector\'s way', /edit_shape \{action: 'pivot'\}/.test(look.inputSchema.properties.material.description) && !/\bset_pivot\b/.test(look.inputSchema.properties.material.description));
	check('TB: a family is an edit; read-only only when every action is (it never is)', look.annotations.readOnlyHint === false && typeof look.annotations.destructiveHint === 'boolean');
	check('TB: the connector view has its own instructions and no guidance gap', typeof v.instructions === 'string' && guidanceGaps(v).length === 0);
	let stray = '';
	try {
		connectorView([...plain, fine('brand_new_tool')], ['import_file']);
	} catch (e) {
		stray = String(e.message);
	}
	check('TB: a tool in no family, not standalone and not excluded fails the generator (a new name needs an owner row)', /brand_new_tool/.test(stray));
	const fam = { set_look: { material: 'set_material', get_material: 'get_material' } };
	check('TB resolve: {action, <action>: {...}} → the fine tool with the inner fields', JSON.stringify(resolveFamilyCall(fam, 'set_look', { action: 'material', material: { objects: ['a'], color: '#f00' } })) === '{"tool":"set_material","args":{"objects":["a"],"color":"#f00"}}');
	check(
		'mcp-diorama2 17: a repeat with confirmId / wait beside the action object keeps them (the host\'s Allow reaches the call)',
		JSON.stringify(resolveFamilyCall(fam, 'set_look', { action: 'material', material: { color: '#f00' }, confirmId: 'c1', wait: 30 }).args) === '{"color":"#f00","confirmId":"c1","wait":30}'
	);
	check('TB resolve: flattened fields still work', JSON.stringify(resolveFamilyCall(fam, 'set_look', { action: 'get_material', uuid: 'u' })) === '{"tool":"get_material","args":{"uuid":"u"}}');
	check('TB resolve: an unknown action names the ones there are', /one of material, get_material/.test(resolveFamilyCall(fam, 'set_look', { action: 'paint' }).error ?? ''));
	check('TB resolve: not a family = null', resolveFamilyCall(fam, 'list_scene', {}) === null);
	// mcp-shapes: create_shape {shapes: [...]} = the batch tool, no action
	{
		const withBatch = connectorView([...plain, fine('create_mesh'), fine('create_shapes', { inputSchema: { type: 'object', properties: { shapes: { type: 'array', maxItems: 50 } }, required: ['shapes'] } })], ['import_file']);
		const shape = withBatch.tools.find((t) => t.name === 'create_shape');
		check('batch: the family map carries the batch key, create_shapes is not listed on its own', JSON.stringify(withBatch.families.create_shape) === '{"lathe":"create_lathe","mesh":"create_mesh","shapes":"create_shapes"}' && !withBatch.tools.some((t) => t.name === 'create_shapes'));
		check('batch: shapes is a top-level list, not an action, and action is then optional', shape.inputSchema.properties.shapes.type === 'array' && shape.inputSchema.properties.shapes.maxItems === 50 && !shape.inputSchema.properties.action.enum.includes('shapes') && shape.inputSchema.required === undefined && /Many at once/.test(shape.description));
		const bf = withBatch.families;
		check('batch resolve: {shapes: [...]} with no action → create_shapes', JSON.stringify(resolveFamilyCall(bf, 'create_shape', { shapes: [{ action: 'mesh' }] })) === '{"tool":"create_shapes","args":{"shapes":[{"action":"mesh"}]}}');
		check('batch resolve: the single form is unchanged', JSON.stringify(resolveFamilyCall(bf, 'create_shape', { action: 'mesh', mesh: { vertices: [] } })) === '{"tool":"create_mesh","args":{"vertices":[]}}');
		check('batch: create_shapes is said the connector\'s way', sayFamilyNames('use create_shapes or create_mesh') === "use create_shape {shapes: […]} or create_shape {action: 'mesh'}");
		check('batch: a family with a batch keeps the other families required:[action]', withBatch.tools.find((t) => t.name === 'set_look').inputSchema.required.join() === 'action');
	}
	check('TB: the 22 published tools + undo_last are standalone', ['list_scene', 'create_objects', 'update_objects', 'delete_objects', 'group_objects', 'clear_scene', 'animate_parts', 'create_flow_nodes', 'update_flow_nodes', 'describe_node_types', 'create_behaviour', 'edit_behaviour', 'set_physics', 'create_joints', 'control_simulation', 'what_can_you_do', 'save_scene', 'status', 'screenshot', 'wait_for_edit', 'join_session', 'where_are_users', 'undo_last'].every((n) => CONNECTOR_STANDALONE.includes(n)));
	check('TB: no tool is in two families, and none is also standalone', (() => {
		const all = Object.values(CONNECTOR_FAMILIES).flatMap((f) => Object.values(f.actions));
		return new Set(all).size === all.length && !all.some((t) => CONNECTOR_STANDALONE.includes(t));
	})());
	check('TB: sayFamilyNames leaves other words alone', sayFamilyNames('use set_material, not set_materials or list_scene') === "use set_look {action: 'material'}, not set_materials or list_scene");
	// mcp-diorama2 item 4: the 1.60 rewrite replaced English words that are also tool names and JSON keys
	check('diorama2: a one-word tool name in prose stays a word', sayFamilyNames('Build a campfire with logs and a warm light; scatter rocks on the terrain by the water, keep it as a prefab') === 'Build a campfire with logs and a warm light; scatter rocks on the terrain by the water, keep it as a prefab');
	check('diorama2: a one-word tool name written as code is rewritten', sayFamilyNames('read `logs` for the error') === "read `run {action: 'logs'}` for the error");
	check('diorama2: a JSON key and a JSON value that IS the name are data', sayFamilyNames('{"logs":[],"tool":"create_mesh","note":"use set_geometry"}') === '{"logs":[],"tool":"create_mesh","note":"use edit_shape {action: \'params\'}"}');
	check('diorama2: the longest name wins (create_shapes, not create_shape + s)', sayToolNames('create_shapes', new Map([['create_shape', 'A'], ['create_shapes', 'B']])) === 'B');
}

// mcp-diorama2 item 4 — THE GUARD: no one-word family member ever turns up rewritten in the committed connector text
// outside backticks (the "as a assets {action: 'prefab'}" / "the effects {action: 'terrain'}'s centre" corruption)
{
	const words = [...familyNames()].filter(([fine]) => !fine.includes('_'));
	const texts = [];
	const walk = (x) => (typeof x === 'string' ? texts.push(x) : x && typeof x === 'object' ? Object.values(x).forEach(walk) : null);
	walk(JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')).connector?.tools ?? []);
	const bad = [];
	for (const t of texts) for (const [, say] of words) for (let i = t.indexOf(say); i >= 0; i = t.indexOf(say, i + 1)) if (t[i - 1] !== '`') bad.push(t.slice(Math.max(0, i - 30), i + say.length + 10));
	check('diorama2: no English word in the connector catalog was rewritten into a tool reference' + (bad.length ? ' — ' + bad.slice(0, 3).join(' | ') : ''), words.length > 3 && bad.length === 0);
}

// the committed catalog (written by core scripts/agent-tool-catalog.cjs) parses and has the instructions
const committed = JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'));
check('catalog.json carries tools + instructions', committed.tools.length > 10 && committed.instructions === connectorInstructions(committed.tools.map((t) => t.name)));
check('catalog.json: no guidance only in the instructions', guidanceGaps(committed).length === 0);
check('catalog.json tools all carry titles + hints', committed.tools.every((t) => t.title && t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
check('catalog.json lists describe_node_types and what_can_you_do', ['describe_node_types', 'what_can_you_do'].every((n) => committed.tools.some((t) => t.name === n)));

check('catalog.json carries the connector view: the 5 new names of 1.56 and every family action runnable', (() => {
	const v = committed.connector;
	const names = v.tools.map((t) => t.name);
	const fine = new Set(committed.tools.map((t) => t.name));
	return ['create_shape', 'edit_shape', 'set_look', 'assets', 'undo_last'].every((n) => names.includes(n)) && Object.values(v.families).every((a) => Object.values(a).every((t) => fine.has(t))) && guidanceGaps(v).length === 0;
})());

check('catalog.json: 85-scene adds hud + game_setup and set_look {sky, light, environment}', (() => {
	const v = committed.connector;
	const f = v.families;
	return (
		f.hud?.create === 'create_hud' && f.hud?.list === 'list_hud' && f.hud?.update === 'edit_hud' && f.hud?.panel === 'hud_panel' &&
		f.game_setup?.spawn === 'place_spawn' && f.game_setup?.play_camera === 'set_play_camera' &&
		f.set_look?.sky === 'set_sky' && f.set_look?.light === 'set_light' && f.set_look?.environment === 'get_environment'
	);
})());

// 85b (1.60): `run` joins; playtest stays agent-page only (B4b) — out of the family, left out by the Worker; no run {play, stop}
check('catalog.json: the run family = inspect / validate / logs, playtest left out of the connector', (() => {
	const run = committed.connector.families.run ?? {};
	return run.inspect === 'inspect_runtime' && run.validate === 'validate_scene' && run.logs === 'logs' && !('playtest' in run) && !('play' in run) && (committed.connectorExcluded ?? []).includes('playtest');
})());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
