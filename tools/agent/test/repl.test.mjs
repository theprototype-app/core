// REPL mode, roadmap 56 C3/C4/C6: app messages are user turns, replies stream into the window, terminal
// lines show "via terminal", Stop ends the turn. A fake engine + the stub OpenAI-compatible endpoint (SSE).
// Run: node test/repl.test.mjs
import { createReplSession } from '../src/repl.js';
import { runChat, chatOnce } from '../src/llmClient.js';
import { startStubLlm } from './fixtures/stubLlm.mjs';

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

class FakeEngine {
	constructor() {
		this.kind = 'browser';
		this.calls = [];
		this.chats = [];
		this.inbox = [];
		this.cancelAfter = Infinity;
	}
	async tools() {
		return [{ type: 'function', function: { name: 'create_objects', description: 'Create', parameters: { type: 'object', properties: { objects: { type: 'array' } } } } }];
	}
	async systemPrompt() {
		return 'You build in theprototype.app.';
	}
	async exec(name, args) {
		this.calls.push([name, args]);
		if (this.calls.length > this.cancelAfter) return { error: 'cancelled', cancelled: true };
		return { created: (args.objects || []).map((_, i) => ({ uuid: 'u' + i })) };
	}
	async chat(method, ...args) {
		this.chats.push([method, ...args]);
		if (method === 'nextMessage') {
			if (this.inbox.length) return this.inbox.shift();
			await tick(20);
			return null;
		}
		return { ok: true, id: 'rep' };
	}
}
const replies = (e, pred) => e.chats.filter((c) => c[0] === 'reply' && pred(c[1])).map((c) => c[1]);
const textOf = (list) => list.map((r) => r.delta || '').join('');

const llm = await startStubLlm();
const cfg = { apiUrl: llm.url, apiKey: '', model: 'stub-1' };

// --- the client itself ---
let streamed = '';
const one = await chatOnce(cfg, [{ role: 'user', content: 'hello there' }], [], (t) => (streamed += t));
check('chatOnce streams SSE content', one.content === 'You said: hello there' && streamed === one.content);
const calls = await chatOnce(cfg, [{ role: 'user', content: 'plant trees' }], [{ name: 'create_objects', parameters: {} }], () => {});
check('chatOnce reassembles a tool call split over chunks', calls.toolCalls.length === 1 && JSON.parse(calls.toolCalls[0].function.arguments).objects.length === 3);
const plain = await chatOnce(cfg, [{ role: 'user', content: 'plant trees' }], [{ name: 'create_objects', parameters: {} }]);
check('without onDelta: the plain JSON path still works', plain.toolCalls[0].function.name === 'create_objects');
const msgs = [{ role: 'user', content: 'say hi' }];
await runChat({ cfg, messages: msgs, tools: [], executeTool: () => ({}) });
check('runChat keeps the final assistant reply in the transcript', msgs.at(-1).role === 'assistant' && /say hi/.test(msgs.at(-1).content));

// --- an app message is a user turn ---
const e = new FakeEngine();
let out = '';
const s = createReplSession({ engine: e, cfg, out: (t) => (out += t), log: () => {}, flushMs: 5 });
await s.appTurn({ id: 'r1', chatId: 'c1', from: 'host1', name: 'Alex', role: 'editor', text: 'add three trees around the fire', at: 1 });
check('the model built through exec', e.calls.length === 1 && e.calls[0][0] === 'create_objects' && e.calls[0][1].objects.length === 3);
const r1 = replies(e, (r) => r.replyTo === 'r1');
check('the reply streams to the requester, in its chat', r1.length >= 1 && r1.every((r) => r.to === 'host1' && r.chatId === 'c1'));
check('the streamed text adds up, and the last push is final', textOf(r1) === 'Planted three trees around the fire.' && r1.at(-1).final === true && r1.slice(0, -1).every((r) => !r.final));
check('the terminal shows the app turn too', /\[app\] Alex \(editor\): add three trees/.test(out) && /create_objects/.test(out));
check('the user turn names the sender and role', s.history.some((m) => m.role === 'user' && /Alex \(editor\) in the app/.test(m.content)));

// --- a terminal line: echoed via cli, then answered via cli ---
await s.terminal('make the fire bigger please');
const firstCli = e.chats.find((c) => c[0] === 'reply' && c[1].prompt);
check('a terminal line is posted to the app as a terminal turn', firstCli && firstCli[1].prompt === 'make the fire bigger please' && firstCli[1].via === 'cli');
const cli = replies(e, (r) => r.via === 'cli' && !r.prompt);
check('its answer streams via cli', /You said: make the fire bigger please/.test(textOf(cli)) && cli.at(-1).final === true);
check('one transcript for both windows', s.history.filter((m) => m.role === 'user').length === 2);

// --- a viewer + images ---
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const nReq = llm.requests.length;
await s.appTurn({ id: 'r2', chatId: 'c1', from: 'view1', name: 'Vic', role: 'viewer', text: 'what is this?', images: [], at: 2 });
check('a viewer turn tells the model edits are refused', /VIEWER/.test(s.history.filter((m) => m.role === 'user').at(-1).content));
await s.appTurn({ id: 'r3', chatId: 'c1', from: 'host1', name: 'Alex', role: 'editor', text: 'look at this', images: [{ mimeType: 'image/png', data: PNG }], at: 3 });
const imgReq = llm.requests.slice(nReq).find((q) => q.messages.some((m) => Array.isArray(m.content)));
check('images go to the model as image_url parts (data URLs)', !!imgReq && imgReq.messages.at(-1).content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));

// --- a model without vision ---
const blind = await startStubLlm({ noVision: true });
const e2 = new FakeEngine();
const s2 = createReplSession({ engine: e2, cfg: { ...cfg, apiUrl: blind.url }, out: () => {}, log: () => {}, flushMs: 5 });
await s2.appTurn({ id: 'b1', chatId: 'c1', from: 'host1', role: 'editor', text: 'look', images: [{ mimeType: 'image/png', data: PNG }], at: 1 });
check('a text-only model: retried without the images, and says so', /cannot see images/.test(s2.history.filter((m) => m.role === 'user').at(-1).content) && replies(e2, (r) => r.final).length === 1);
await blind.close();

// --- Stop: the next exec answers cancelled → the turn ends ---
const e3 = new FakeEngine();
e3.cancelAfter = 1;
const s3 = createReplSession({ engine: e3, cfg, out: () => {}, log: () => {}, flushMs: 5 });
const before = llm.requests.length;
const res = await s3.appTurn({ id: 's1', chatId: 'c1', from: 'host1', role: 'editor', text: 'slow build, stop me', at: 1 });
check('Stop: the turn ends as stopped', res === 'stopped');
check('Stop: no more model calls after the cancelled exec', llm.requests.length - before === 1 && e3.calls.length === 2);
check('Stop: the reply ends final with (stopped)', /\(stopped\)/.test(textOf(replies(e3, (r) => r.replyTo === 's1'))) && replies(e3, (r) => r.replyTo === 's1').at(-1).final);

// --- the app loop: picks up messages with no terminal input, labels the agent REPL ---
const e4 = new FakeEngine();
const s4 = createReplSession({ engine: e4, cfg, out: () => {}, log: () => {}, flushMs: 5, appWaitMs: 50 });
e4.inbox.push({ id: 'L1', chatId: 'c2', from: 'host1', role: 'editor', text: 'hello agent', at: 1 });
const loop = s4.appLoop();
for (let i = 0; i < 100 && !replies(e4, (r) => r.replyTo === 'L1' && r.final).length; i++) await tick(20);
check('the loop labels the agent (mode repl + model)', e4.chats.some((c) => c[0] === 'chatStatus' && c[2]?.mode === 'repl' && c[2]?.model === 'stub-1'));
check('an app message is answered with no terminal input', /You said: hello agent/.test(textOf(replies(e4, (r) => r.replyTo === 'L1'))));
check('waits carry a token', e4.chats.some((c) => c[0] === 'nextMessage' && /^r/.test(c[2])));
s4.stop();
await loop;

// --- a terminal line while a wait is armed: the wait is released ---
const e5 = new FakeEngine();
const s5 = createReplSession({ engine: e5, cfg, out: () => {}, log: () => {}, flushMs: 5, appWaitMs: 2000 });
const loop5 = s5.appLoop();
await tick(30);
await s5.terminal('hi');
check('a terminal line releases the armed app wait', e5.chats.some((c) => c[0] === 'abortWait'));
s5.stop();
await Promise.race([loop5, tick(200)]);

await llm.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
