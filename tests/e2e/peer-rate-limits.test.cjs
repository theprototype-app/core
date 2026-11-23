// 71 TR7 — PER-PEER EDIT AND CHAT LIMITS, two real peers. A floods B (B hosts, so A is limited):
//   1 chat: 60 at once, B keeps the burst and drops the rest; B's toast names A; A is told to slow down
//   2 it refills: a message after a pause arrives
//   3 ordinary work is untouched: 200 new objects in one go all land (an agent batch, a paste)
//   4 edits: past the burst they stop, and B's toast says so
//   5 counterfactual: Off passes everything
//   6 the session host is exempt: B floods A, nothing is dropped
//   7 the row in Settings ▸ Connection sets it and it survives
const h = require('./helpers.cjs');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
const sendN = (peer, make, n) => inPage(peer, `for (let i = 0; i < arg.n; i++) pc.broadcast(eval(arg.make)(i)); return arg.n;`, { make: String(make), n });
const chatCount = (peer, tag) => inPage(peer, `let v; s.messages.subscribe((x) => (v = x))(); return (v || []).filter((m) => String(m.text).startsWith(arg)).length;`, tag);
const objects = (peer) => inPage(peer, `let g; s.objectsGroup.subscribe((v) => (g = v))(); return g.children.length;`);
const toast = (peer, re) => peer.page.evaluate((r) => [...document.querySelectorAll('.tp-toast')].some((t) => new RegExp(r).test(t.textContent || '')), re);
const box = (base) => `(i) => ({ type: 'create', command: '/create box', uuid: '${base}' + String(i).padStart(4, '0') + '-0000-4000-8000-000000000000' })`;

h.run(async () => {
	const browser = await h.launch();
	const B = await h.setupPage(browser, 'B');
	const A = await h.setupPageQuiet(browser, 'A', [B]);
	await h.connect(A, B, 2000); // A dials, B approves: B is the session host for A
	const hostOfA = await inPage(A, `let v; s.connectionState.sessionHost.subscribe((x) => (v = x))(); return v;`);
	h.check(hostOfA === B.id, `setup: B hosts (${hostOfA})`);

	// ---- 1 chat
	const chat = (tag) => `(i) => ({ type: 'sent', message: '${tag}' + i, sender: 'A', id: '${tag}' + i, at: Date.now() })`;
	await sendN(A, chat('flood-'), 60);
	await h.eventually(() => chatCount(B, 'flood-'), (n) => n >= 12, '1.1 the burst of chat arrives');
	await B.page.waitForTimeout(1500);
	const got = await chatCount(B, 'flood-');
	h.check(got >= 12 && got <= 15, `1.2 and the rest of 60 is dropped (${got})`);
	h.check(await toast(B, 'is sending too many chat messages'), '1.3 the receiver is told who');
	await h.eventually(() => toast(A, 'very fast'), (v) => v === true, '1.4 the sender is told to slow down');

	// ---- 2 it refills
	await A.page.waitForTimeout(3000);
	await sendN(A, chat('after-'), 1);
	await h.eventually(() => chatCount(B, 'after-'), (n) => n === 1, '2.1 after a pause a message arrives');

	// ---- 3 an ordinary big batch
	const before = await objects(B);
	await sendN(A, box('aaaaaaaa'.slice(0, 4)), 200);
	await h.eventually(() => objects(B), (n) => n === before + 200, '3.1 200 new objects in one go all land', 30000);

	// ---- 4 edits past the burst, on Strict. Renames, because they are cheap: B takes tens of ms to build each new
	// object, so a flood of creates reaches its gate slower than Strict's refill and proves nothing.
	const target = 'aaaa0000-0000-4000-8000-000000000000';
	const rename = `(i) => ({ type: 'name', uuid: '${target}', name: 'flood-' + i })`;
	// 71-rooms (re-check on 1.74): count the renames B APPLIES (a setter on the target, test-only). The old
	// measure — "the last name to land is short of #999" — is a coin flip on 1.74, where the flood reaches B
	// over ~0.5 s: Strict's 20/s refill admits a few late renames, and one of them may be #999 itself.
	const COUNT = `const o = (() => { let g; s.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByProperty('uuid', arg); })();
		let v = o.name; window.__renames = []; Object.defineProperty(o, 'name', { configurable: true, get: () => v, set: (x) => { v = x; window.__renames.push(x); } }); return true;`;
	const applied = () => B.page.evaluate(() => window.__renames ?? []);
	h.check(await inPage(B, COUNT, target), '4.0 B counts the renames it applies');
	await inPage(B, `s.peerRateGate.peerRateLimits.set('strict');`);
	const tSend = Date.now();
	await sendN(A, rename, 1000);
	const sendMs = Date.now() - tSend;
	await h.eventually(() => toast(B, 'is sending too many edits'), (v) => v === true, '4.1 the receiver is told', 15000);
	await B.page.waitForTimeout(1500);
	const strictApplied = await applied();
	// the burst (120) plus the refill (20/s) over however long the flood took to be applied — measured 146..323 of
	// 1000 on the Deck — so the bound is "most of it stopped", not an exact number
	h.check(strictApplied.length >= 119 && strictApplied.length <= 500, `4.2 Strict stops most of the flood: ${strictApplied.length} of 1000 applied (sent in ${sendMs} ms)`);
	h.check(strictApplied[0] === 'flood-0' && strictApplied.slice(0, 119).every((n, k) => n === 'flood-' + k), '4.3 …the first 119 in order (the burst)');

	// ---- 5 Off passes everything
	await inPage(B, `s.peerRateGate.peerRateLimits.set('off'); window.__renames = [];`);
	await A.page.waitForTimeout(100);
	await sendN(A, chat('free-'), 60);
	await sendN(A, rename, 1000);
	await h.eventually(() => applied().then((a) => a.length), (n) => n === 1000, '5.0 with limits off all 1000 renames are applied', 30000);
	const offApplied = await applied();
	const inOrder = offApplied.every((n, k) => n === 'flood-' + k);
	h.check(inOrder, `5.0b …in the order they were sent (${inOrder ? 'yes' : 'first out of order at #' + offApplied.findIndex((n, k) => n !== 'flood-' + k)})`);
	await h.eventually(() => chatCount(B, 'free-'), (n) => n === 60, '5.1 with limits off all 60 arrive', 15000);
	await inPage(B, `s.peerRateGate.peerRateLimits.set('normal');`);

	// ---- 6 the host is exempt
	await sendN(B, chat('host-'), 60);
	await h.eventually(() => chatCount(A, 'host-'), (n) => n === 60, '6.1 the session host is not limited', 15000);

	// ---- 7 the row
	await inPage(B, `s.settingsSection.set('connection'); s.settingsOpen.set(true);`);
	await B.page.locator('#row-peer-rate-limits').waitFor({ state: 'visible', timeout: 15000 });
	await B.page.locator('#peer-rate-limits-strict').click();
	await h.eventually(() => B.page.evaluate(() => localStorage.getItem('connect:rateLimits')), (v) => v === 'strict', '7.1 the row sets it, on this device');

	await h.finish(browser);
});
