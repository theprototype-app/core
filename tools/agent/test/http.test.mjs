// `serve --port` (roadmap 56 C18/C19): the HTTP transport over a bridge with no engine: the full catalog
// before a join, the join-first answer, a reconnecting client, and loopback-only.
// Run: node test/http.test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBridgeServer, catalogHostTools } from '../src/mcpServer.js';
import { listenHttp, loopbackRequest } from '../src/httpServer.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
	console.log((cond ? 'PASS ' : 'FAIL ') + name);
	if (cond) pass++;
	else fail++;
};

const catalog = catalogHostTools();
check('the catalog has the host tools, not the connector-only ones', catalog.some((t) => t.name === 'create_objects') && !catalog.some((t) => t.name === 'join_session' || t.name === 'where_are_users'));

const bridge = createBridgeServer({ kind: 'browser', staticTools: catalog, createEngine: () => { throw new Error('no engine in this test'); } });
const http = await listenHttp(bridge, 0);
const port = http.address().port;
const url = new URL(`http://127.0.0.1:${port}/mcp`);

const open = async () => {
	const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
	await client.connect(new StreamableHTTPClientTransport(url));
	return client;
};
const first = await open();
const names = (await first.listTools()).tools.map((t) => t.name);
check('tools/list before the join = the full catalog', ['create_objects', 'set_physics', 'animate_parts', 'connect', 'status', 'wait_for_message'].every((n) => names.includes(n)));
check('a tool name appears once', new Set(names).size === names.length);
const called = await first.callTool({ name: 'create_objects', arguments: { objects: [] } });
check('a scene tool before the join says to join first', called.isError && called.content[0].text.includes('join first'));

const second = await open();
check('a new client takes over', (await second.listTools()).tools.length === names.length);

const refused = async (headers) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' })).status;
check('a browser page on another origin is refused', (await refused({ origin: 'https://evil.example' })) === 403);
check('rebinding: another Host is refused', loopbackRequest({ host: 'evil.example:1234' }) === false);
check('a plain local client passes', loopbackRequest({ host: '127.0.0.1:1234' }) === true);
check('a local page passes', loopbackRequest({ host: 'localhost:1234', origin: 'http://localhost:5173' }) === true);
check('a bad Origin is refused', loopbackRequest({ host: '127.0.0.1:1', origin: 'null' }) === false);
check('wrong path', (await fetch(`http://127.0.0.1:${port}/other`)).status === 404);

await second.close();
await first.close().catch(() => {});
http.closeAllConnections?.();
http.close();
await bridge.shutdown();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
