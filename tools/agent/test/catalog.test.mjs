// The static tool catalog (roadmap 86 T4 + 56 C19) and its voice instructions (86 T3). Pure: no browser.
// Run: node test/catalog.test.mjs
import fs from 'node:fs';
import { buildCatalog, connectorInstructions, annotate, guidanceGaps, withGuidance, CATALOG_FORMAT } from '../src/catalog.js';
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
check('join_session (86-fix N2) is listed as an edit that asks the person', c.tools.some((t) => t.name === 'join_session' && t.annotations.destructiveHint === true && /presses Join/.test(t.description)));

// the committed catalog (written by core scripts/agent-tool-catalog.cjs) parses and has the instructions
const committed = JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'));
check('catalog.json carries tools + instructions', committed.tools.length > 10 && committed.instructions === connectorInstructions(committed.tools.map((t) => t.name)));
check('catalog.json: no guidance only in the instructions', guidanceGaps(committed).length === 0);
check('catalog.json tools all carry titles + hints', committed.tools.every((t) => t.title && t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
check('catalog.json lists describe_node_types and what_can_you_do', ['describe_node_types', 'what_can_you_do'].every((n) => committed.tools.some((t) => t.name === n)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
