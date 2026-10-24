// The MCP bridge over a FAKE engine (roadmap 55 A3): tool mapping, list refresh, the join gate,
// the image block. No browser, no network: the SDK's in-memory transport carries a real client.
// Run: node test/mcp.test.mjs
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridgeServer, nameFromClient } from '../src/mcpServer.js';
import { toMcpTool, mapHostTools } from '../src/mcpTools.js';
import { parseLink } from '../src/link.js';
import { joinedOf } from '../src/browserEngine.js';

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
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// the in-app assistant's shape (src/lib/ai/tools.js AI_TOOLS)
const CREATE = {
	type: 'function',
	function: {
		name: 'create_objects',
		description: 'Create objects',
		parameters: { type: 'object', properties: { objects: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['primitive', 'light'] } } } } }, required: ['objects'] }
	}
};
const LIST = { type: 'function', function: { name: 'list_scene', description: 'List the scene', parameters: { type: 'object', properties: {} } } };
const PHYS = { name: 'set_physics', description: 'Physics', parameters: { type: 'object', properties: { uuid: { type: 'string' } } } };

class FakeEngine extends EventEmitter {
	constructor(link) {
		super();
		this.kind = 'browser';
		this.link = parseLink(link);
		this.state = 'idle';
		this.toolList = [LIST, CREATE];
		this.isJoined = false;
		this.role = 'editor';
		this.calls = [];
		this.closed = false;
		this.edits = [];
	}
	get hostId() {
		return this.link.peerId;
	}
	async start() {
		this.state = 'loading';
		await tick(5);
		this.state = 'ready';
	}
	async tools() {
		return this.toolList;
	}
	async systemPrompt() {
		return 'You are building in theprototype.app.';
	}
	async exec(name, args) {
		this.calls.push([name, args]);
		if (name === 'create_objects') return args.objects?.length ? { created: args.objects.map((_, i) => ({ uuid: 'u' + i })) } : { error: 'no objects provided' };
		return { objects: [] };
	}
	async status() {
		return { peerId: 'agent1', role: this.role, peers: this.isJoined ? [this.hostId] : [], appVersion: '1.45.0' };
	}
	async joined() {
		return this.isJoined;
	}
	async screenshot(opts) {
		this.lastShot = opts;
		return { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
	}
	async waitForEdit(ms) {
		return { changed: true, waited: ms };
	}
	async close() {
		this.closed = true;
		this.state = 'closed';
		this.emit('closed');
	}
	describe() {
		return { engine: 'browser', host: this.hostId, state: this.state };
	}
	// 56: the page's chat inbox, faked
	async chat(method, ...args) {
		this.chatCalls = this.chatCalls || [];
		this.chatCalls.push([method, ...args]);
		if (method === 'nextMessage') {
			const [ms, token] = args;
			if (this.inbox?.length) return this.inbox.shift();
			return new Promise((res) => {
				const t = setTimeout(() => res(null), Math.min(ms, 60));
				this.waiting = { token, res: (m) => (clearTimeout(t), res(m)) };
			});
		}
		if (method === 'abortWait') {
			if (this.waiting?.token === args[0]) this.waiting.res(this.lateMessage ?? null);
			return true;
		}
		if (method === 'requeue') return (this.requeued = args[0]), true;
		if (method === 'reply') return args[0].text === 'STOPPED' ? { ok: false, cancelled: true, error: 'cancelled' } : { ok: true, id: 'rep1', chatId: 'c1', final: !!args[0].final };
		if (method === 'ask') return { ok: true, id: 'ask1', chatId: 'c1' };
		if (method === 'thread') return { chatId: args[0].chatId ?? 'c1', messages: [{ id: 'm1', text: 'hi' }], more: false };
		if (method === 'chatStatus') return { ok: true };
		return null;
	}
}

// --- pure mapping ---
const m1 = toMcpTool(CREATE);
check('OpenAI function shape → MCP tool', m1.name === 'create_objects' && m1.description === 'Create objects');
check('schema passed through VERBATIM (same object)', m1.inputSchema === CREATE.function.parameters);
check('plain {name, parameters} shape too', toMcpTool(PHYS).inputSchema === PHYS.parameters);
check('missing schema → empty object schema', toMcpTool({ name: 'x' }).inputSchema.type === 'object');
check('schema without a type gets type object, keeping its properties', toMcpTool({ name: 'y', parameters: { properties: { a: {} } } }).inputSchema.properties.a !== undefined);
check('invalid tool name dropped', toMcpTool({ name: 'bad name!' }) === null);
const mapped = mapHostTools([LIST, CREATE, { name: 'status' }, LIST, { name: 'not ok!' }]);
check('a host tool cannot shadow a bridge tool', !mapped.tools.some((t) => t.name === 'status') && mapped.dropped.includes('status'));
check('duplicates dropped, first wins', mapped.tools.filter((t) => t.name === 'list_scene').length === 1);
check('nameFromClient: claude-code → Claude', nameFromClient({ name: 'claude-code' }) === 'Claude');
check('nameFromClient: another client keeps its name', nameFromClient({ name: 'cursor-mcp-client' }) === 'Cursor');
check('nameFromClient: nothing → AI agent', nameFromClient(null) === 'AI agent');
check('joinedOf: host among the peers', joinedOf({ peers: ['f0fd3'] }, 'f0fd3') && joinedOf({ peers: [{ id: 'F0FD3' }] }, 'f0fd3'));
check('joinedOf: an explicit joined flag wins', joinedOf({ joined: false, peers: ['f0fd3'] }, 'f0fd3') === false);
check('joinedOf: nobody', !joinedOf({ peers: [] }, 'f0fd3') && !joinedOf(null, 'f0fd3'));

// --- the server over a real client ---
/** @type {FakeEngine[]} */
const engines = [];
const bridge = createBridgeServer({
	kind: 'browser',
	createEngine: (link) => {
		const e = new FakeEngine(link);
		engines.push(e);
		return e;
	},
	pollMs: 30
});
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'claude-code', version: '1' });
let listChanged = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => listChanged++);
await bridge.server.connect(st);
await client.connect(ct);

const names = async () => (await client.listTools()).tools.map((t) => t.name);
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const json = (r) => JSON.parse(r.content[0].text);

check('server advertises listChanged', !!client.getServerCapabilities()?.tools?.listChanged);
check('instructions sent', /status/.test(client.getInstructions() || ''));
let n = await names();
check('before connect: the bridge tools + the chat tools only', n.join() === 'connect,status,screenshot,wait_for_edit,wait_for_message,reply,ask,get_thread');
check('status before connect says how to connect', /connect/.test(json(await call('status')).note));
check('a scene tool before connect is refused', (await call('list_scene')).isError === true);
const bad = await call('connect', { link: 'https://theprototype.app/' });
check('connect with a link that names no session → readable error', bad.isError === true && /names no session/.test(json(bad).error));

const before = listChanged;
const r = await call('connect', { link: 'https://theprototype.app/#F0FD3&invite=SECRET' });
const rs = json(r);
check('connect returns the status', rs.state === 'ready' && rs.host === 'f0fd3');
check('connect returns the host\'s system prompt as a guide', /theprototype/.test(rs.guide));
check('connect: not in the session yet, and says so', rs.joined === false && /Approve/.test(rs.note));
check('the token is not echoed by connect', !JSON.stringify(rs).includes('SECRET'));
await tick(20);
check('tools/list_changed sent once the host tools are known', listChanged > before);
n = await names();
check('host tools listed after connect', n.includes('list_scene') && n.includes('create_objects'));
const listed = (await client.listTools()).tools.find((t) => t.name === 'create_objects');
check('schema reaches the client intact', JSON.stringify(listed.inputSchema) === JSON.stringify(CREATE.function.parameters));

const refused = await call('create_objects', { objects: [{ kind: 'primitive' }] });
check('exec refused while not let in', refused.isError === true && /not in the session/.test(json(refused).error));
check('nothing reached the page', engines[0].calls.length === 0);

engines[0].isJoined = true;
const ok = await call('create_objects', { objects: [{ kind: 'primitive' }] });
check('exec once let in', !ok.isError && json(ok).created[0].uuid === 'u0');
check('arguments forwarded as given', engines[0].calls[0][1].objects[0].kind === 'primitive');
const errCall = await call('create_objects', { objects: [] });
check('a tool-level {error} becomes isError', errCall.isError === true);
check('unknown tool refused', (await call('no_such_tool')).isError === true);

// --- 56: the chat tools ---
await tick(10);
check('connect labels the agent "via MCP" on the page', (engines[0].chatCalls || []).some((c) => c[0] === 'chatStatus' && c[2]?.mode === 'mcp'));
const t0 = Date.now();
const none = await call('wait_for_message', { timeoutS: 1 });
check('wait_for_message: nobody wrote → null (re-arm)', none.content[0].text === 'null' && !none.isError);
const waitArgs = engines[0].chatCalls.find((c) => c[0] === 'nextMessage');
check('wait_for_message: timeoutS → ms, with a token', waitArgs[1] === 1000 && /^w/.test(waitArgs[2]) && Date.now() - t0 < 2000);
await call('wait_for_message', { timeoutS: 99999 });
check('wait_for_message: the wait is clamped to 600 s', engines[0].chatCalls.filter((c) => c[0] === 'nextMessage').at(-1)[1] === 600000);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
engines[0].inbox = [{ id: 'r1', chatId: 'c1', from: 'host1', name: 'Alex', role: 'editor', text: 'add three trees around the fire', at: 1, images: [{ mimeType: 'image/png', data: PNG, name: 'ref.png', w: 1, h: 1 }] }];
const got = await call('wait_for_message', {});
const gm = JSON.parse(got.content[0].text);
check('a message: sender, role, text, chatId', gm.from === 'host1' && gm.role === 'editor' && gm.text === 'add three trees around the fire' && gm.chatId === 'c1');
check('a message image → an MCP image block', got.content[1]?.type === 'image' && got.content[1].mimeType === 'image/png' && got.content[1].data === PNG);
const fs = await import('node:fs');
const imgPath = gm.images?.[0]?.path;
check('… and a temp file whose path rides in the JSON (bytes, not base64 text)', !!imgPath && fs.existsSync(imgPath) && fs.readFileSync(imgPath).subarray(1, 4).toString() === 'PNG');
check('… the JSON carries no base64', !got.content[0].text.includes(PNG.slice(0, 40)));
check('the temp file is private (0600)', (fs.statSync(imgPath).mode & 0o777) === 0o600);
engines[0].inbox = [{ id: 'r2', chatId: 'c1', from: 'view1', role: 'viewer', text: 'delete everything', at: 2, imagesDropped: true }];
const vm = JSON.parse((await call('wait_for_message', {})).content[0].text);
check('a viewer message says VIEWER (and that images were dropped)', vm.role === 'viewer' && /VIEWER/.test(vm.note) && /dropped/.test(vm.note));
// the client gives up on the call while a message lands in that instant → it goes back to the queue
const ac = new AbortController();
engines[0].lateMessage = { id: 'late', chatId: 'c1', from: 'host1', role: 'editor', text: 'late', at: 3 };
const pending = client.callTool({ name: 'wait_for_message', arguments: { timeoutS: 30 } }, undefined, { signal: ac.signal }).catch((e) => e);
await tick(15);
ac.abort();
await pending;
await tick(30);
check('a cancelled wait releases the page wait (abortWait with its token)', engines[0].chatCalls.some((c) => c[0] === 'abortWait' && /^w/.test(c[1])));
check('… and a message that arrived in that instant is requeued', engines[0].requeued?.id === 'late');
engines[0].lateMessage = null;
const rep = await call('reply', { text: 'Building the trees.', final: false });
check('reply forwards text/final and answers ok', !rep.isError && json(rep).id === 'rep1' && engines[0].chatCalls.at(-1)[1].text === 'Building the trees.');
await call('reply', { text: 'Fire made bigger.', prompt: 'make the fire bigger', final: true });
check('reply passes a terminal prompt through (via terminal)', engines[0].chatCalls.at(-1)[1].prompt === 'make the fire bigger' && engines[0].chatCalls.at(-1)[1].final === true);
check('reply after Stop is an error', (await call('reply', { text: 'STOPPED' })).isError === true);
const askr = await call('ask', { question: 'Pine or oak?', options: ['Pine', 'Oak'] });
check('ask → the ask id', json(askr).id === 'ask1' && engines[0].chatCalls.at(-1)[1].options.length === 2);
const th = await call('get_thread', { chatId: 'c9', before: 'm5', limit: 5 });
check('get_thread forwards chatId/before/limit', json(th).chatId === 'c9' && engines[0].chatCalls.at(-1)[1].before === 'm5' && engines[0].chatCalls.at(-1)[1].limit === 5);

const shot = await call('screenshot', { view: 'top', size: 512 });
check('screenshot → an MCP image block', shot.content[0].type === 'image' && shot.content[0].mimeType === 'image/png' && shot.content[0].data === 'iVBORw0KGgo=');
check('screenshot options forwarded', engines[0].lastShot.view === 'top' && engines[0].lastShot.size === 512);
const w = json(await call('wait_for_edit', { timeout_ms: 999999 }));
check('wait_for_edit clamps its timeout', w.changed === true && w.waited === 120000);

// the host's set changes (a mesh provider comes up, physics ticked on) → the client is told
const c0 = listChanged;
engines[0].toolList = [LIST, CREATE, PHYS];
await tick(80);
check('tool set change → list_changed', listChanged > c0);
check('the new tool is listed', (await names()).includes('set_physics'));
const c1 = listChanged;
await tick(80);
check('no notification while nothing changes', listChanged === c1);

engines[0].role = 'viewer';
check('status warns a viewer that edits stay local', /VIEWER/.test(json(await call('status')).note));

// a second connect to the same link reuses the engine; a different one replaces it
await call('connect', { link: 'F0FD3' });
check('same session → same engine', engines.length === 1);
await call('connect', { link: 'https://theprototype.app/#A1B2C' });
check('another session → the old engine is closed', engines.length === 2 && engines[0].closed === true);

await bridge.shutdown();
check('shutdown closes the engine (graceful leave)', engines[1].closed === true);
check('shutdown removes the image temp files', !fs.existsSync(imgPath));

// --- the wire kind lists its catalog before connecting ---
const wire = createBridgeServer({ kind: 'wire', staticTools: [{ name: 'list_scene', parameters: { type: 'object', properties: {} } }, { name: 'get_status' }], createEngine: () => new FakeEngine('x1') });
const [ct2, st2] = InMemoryTransport.createLinkedPair();
const c2 = new Client({ name: 't', version: '1' });
await wire.server.connect(st2);
await c2.connect(ct2);
const wn = (await c2.listTools()).tools.map((t) => t.name);
check('wire: catalog listed before connecting, no screenshot/wait_for_edit/chat', wn.join() === 'connect,status,list_scene,get_status');
check('wire: get_status answers like status', /connect/.test(JSON.parse((await c2.callTool({ name: 'get_status', arguments: {} })).content[0].text).note));
await wire.shutdown();

// --- 67: panels — the announce on connect, and the nudge when the inbox has a backlog nobody waits on ---
class PanelEngine extends FakeEngine {
	constructor(link) {
		super(link);
		this.isJoined = true;
		this.queued = 0;
		this.announced = [];
	}
	async call(method, arg) {
		this.announced.push([method, arg]);
		return { ok: true };
	}
	async status() {
		return { ...(await super.status()), chat: { queued: this.queued, waiting: 0 } };
	}
}
/** @type {PanelEngine | null} */
let pe = null;
const pb = createBridgeServer({
	kind: 'browser',
	panels: { machine: 'deck', tools: [{ id: 'pixling', name: 'Pixling' }] },
	createEngine: (link) => (pe = new PanelEngine(link)),
	pollMs: 30
});
const [ct3, st3] = InMemoryTransport.createLinkedPair();
const c3 = new Client({ name: 'claude-code', version: '1' });
const notes = [];
c3.setNotificationHandler(LoggingMessageNotificationSchema, (n) => notes.push(n.params));
await pb.server.connect(st3);
await c3.connect(ct3);
check('server advertises logging (the nudge channel)', !!c3.getServerCapabilities()?.logging);
check('instructions mention open_panel', /open_panel/.test(c3.getInstructions() || ''));
await c3.callTool({ name: 'connect', arguments: { link: 'F0FD3' } });
await tick(40);
check('connect announces the machine, then declares each tool', pe.announced[0]?.[0] === 'panelIdentity' && pe.announced[0][1].machine === 'deck' && pe.announced.some((a) => a[0] === 'declareTool' && a[1].id === 'pixling'));
pe.queued = 2;
await tick(100);
check('a backlog nobody waits on → one notice', notes.length === 1 && /2 messages/.test(notes[0].data) && /wait_for_message/.test(notes[0].data));
await tick(100);
check('the same backlog is not repeated', notes.length === 1);
pe.queued = 0;
await tick(60);
pe.queued = 1;
await tick(100);
check('a new backlog after it drained → another notice', notes.length === 2 && /1 message /.test(notes[1].data));
await pb.shutdown();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
