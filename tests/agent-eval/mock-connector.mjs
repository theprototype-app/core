#!/usr/bin/env node
// Roadmap 85 eval set — a stand-in for the claude.ai connector: lists a Worker catalog (cloud
// worker-mcp/catalog/tools.json shape) through the Worker's OWN policy module, answers from one fixed
// scene, and logs every call (JSONL) so run.mjs can score tool choice. Nothing reaches an app.
//   node mock-connector.mjs <worker tools.json> <worker src/catalog.js> <log.jsonl>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [catalogFile, policyFile, logFile] = process.argv.slice(2);
const req = createRequire(path.join(HERE, '..', '..', 'tools', 'agent', 'package.json'));
const { Server } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/index.js')).href);
const { StdioServerTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href);
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/types.js')).href);
const policy = await import(pathToFileURL(policyFile).href);

const catalog = policy.compileCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
const scene = JSON.parse(fs.readFileSync(path.join(HERE, 'scene.json'), 'utf8'));
const resolve = (/** @type {string} */ name, /** @type {any} */ args) =>
	typeof policy.resolveCall === 'function' ? policy.resolveCall(catalog, name, args) : { tool: name, args, def: catalog.byName.get(name) };

let made = 0;
/** @param {string} tool @param {any} args */
function answer(tool, args) {
	switch (tool) {
		case 'list_scene':
			return scene.list_scene;
		case 'status':
			return scene.status;
		case 'where_are_users':
			return scene.where_are_users;
		case 'screenshot':
			return { note: 'a picture of the scene from iso: the floor, the table with the lamp on it, the crate and the ball beside it, the door' };
		case 'what_can_you_do':
			return { say: 'I can build in your open theprototype tab.' };
		case 'describe_node_types':
			return { types: [{ type: 'spin', inputs: ['object'], params: { speed: 'number (turns per second)', axis: 'x|y|z' } }, { type: 'objectselector', outputs: ['object'], params: { uuid: 'string' } }] };
		case 'list_materials':
		case 'get_material':
			return { materials: scene.list_scene.objects.map((/** @type {any} */ o) => ({ uuid: o.uuid, name: o.name, type: 'MeshStandardMaterial', color: o.color, roughness: 0.8, metalness: 0, maps: [] })) };
		case 'describe_shader_nodes':
			return { groups: { Input: ['time', 'uv', 'color'], Math: ['sin', 'multiply', 'add'], Output: ['surface (albedo, emissive, roughness, metalness, opacity)'] } };
		case 'get_post':
			return { enabled: false, effects: [] };
		case 'set_post':
			if (!args?.confirmId) return { needsConfirm: true, confirmId: 'c-1', summary: 'post effects for the whole scene', note: 'Repeat the call with confirmId (and wait up to 60 s) after telling the person the host was asked.' };
			return { ok: true, effects: [{ kind: 'bloom' }] };
		case 'undo_last':
			return { undone: [{ text: 'changed the floor colour' }] };
		default: {
			const id = 'new-' + ++made;
			return { ok: true, created: [{ uuid: id }], updated: [] };
		}
	}
}

const server = new Server({ name: 'theprototype-eval', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.tools }));
server.setRequestHandler(CallToolRequestSchema, async (/** @type {any} */ r) => {
	const name = r.params.name;
	const args = r.params.arguments ?? {};
	const call = catalog.byName.has(name) ? resolve(name, args) : { error: 'Unknown tool: ' + name };
	const row = { t: Date.now(), tool: name, action: typeof args.action === 'string' ? args.action : undefined, fine: call.tool, error: call.error };
	fs.appendFileSync(logFile, JSON.stringify(row) + '\n');
	if (call.error) return { content: [{ type: 'text', text: call.error }], isError: true };
	return { content: [{ type: 'text', text: JSON.stringify(answer(call.tool, call.args)) }] };
});
await server.connect(new StdioServerTransport());
