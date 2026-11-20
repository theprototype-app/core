#!/usr/bin/env node
// Roadmap 2.0 N3a — THE CONNECTOR STAND-IN for the results eval. `claude -p` spawns it as its only MCP server.
//
// It lists ONE Worker catalog (cloud worker-mcp/catalog/tools.json, compiled by the Worker's OWN catalog.js), and
// runs each call the way the Worker's connection.js does: resolveCall (a family → one fine tool) → the TAB → the
// tab's frame → relay.js toMcpResult → withoutExcluded → withFamilyNames. The tab is a REAL app page the eval
// harness drives (results.mjs): the call goes over a localhost bridge, and the harness hands it to the page's own
// connector dispatcher through the fake-relay seam (tests/e2e/connectorFake.cjs). So the model sees the exact
// listing and answers claude.ai sees, and the scene it builds is real.
//
//   node connector.mjs <worker tools.json> <worker src/catalog.js> <worker src/relay.js> <bridge url> <log.jsonl>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [catalogFile, policyFile, relayFile, bridge, logFile] = process.argv.slice(2);
const req = createRequire(path.join(HERE, '..', 'package.json'));
const { Server } = await import(
	pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/index.js')).href
);
const { StdioServerTransport } = await import(
	pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href
);
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
	pathToFileURL(req.resolve('@modelcontextprotocol/sdk/types.js')).href
);
const policy = await import(pathToFileURL(path.resolve(policyFile)).href);
const relay = await import(pathToFileURL(path.resolve(relayFile)).href);

const catalog = policy.compileCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
const toolError = (/** @type {string} */ text) => ({
	content: [{ type: 'text', text }],
	isError: true
});

/** one fine call → the harness → the tab's frame @param {string} tool @param {any} args */
async function toTab(tool, args) {
	const timeoutMs = typeof relay.timeoutFor === 'function' ? relay.timeoutFor(tool) : 120000;
	try {
		const r = await fetch(bridge, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tool, args, timeoutMs })
		});
		return await r.json();
	} catch (e) {
		return {
			type: 'error',
			error: {
				code: 'gone',
				message:
					'The theprototype tab is not connected (' +
					String(/** @type {any} */ (e)?.message ?? e) +
					').'
			}
		};
	}
}

const server = new Server(
	{ name: 'theprototype', version: '0.0.0' },
	{ capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.tools }));
server.setRequestHandler(CallToolRequestSchema, async (/** @type {any} */ r) => {
	const name = r.params.name;
	const args = r.params.arguments ?? {};
	const t0 = Date.now();
	/** @type {any} */
	let result;
	/** @type {any} */
	let fine = null;
	if (!catalog.byName.has(name)) result = toolError('Unknown tool: ' + name);
	else {
		const call = policy.resolveCall(catalog, name, args);
		if ('error' in call) result = toolError(call.error);
		else {
			fine = call.tool;
			const frame = await toTab(call.tool, call.args);
			result = relay.toMcpResult(frame);
		}
	}
	result = policy.withFamilyNames(catalog, policy.withoutExcluded(name, result));
	const text = result?.content?.find((/** @type {any} */ c) => c.type === 'text')?.text ?? '';
	const row = {
		t: t0,
		ms: Date.now() - t0,
		tool: name,
		action: typeof args.action === 'string' ? args.action : undefined,
		fine,
		args,
		error: result?.isError ? text.slice(0, 400) : undefined,
		bytes: JSON.stringify(result).length,
		answer: text.slice(0, 60000)
	};
	fs.appendFileSync(logFile, JSON.stringify(row) + '\n');
	return result;
});
await server.connect(new StdioServerTransport());
