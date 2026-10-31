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
	const nameOn = (peer) => inPage(peer, `let g; s.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByProperty('uuid', arg)?.name ?? null;`, target);
	await inPage(B, `s.peerRateGate.peerRateLimits.set('strict');`);
	await sendN(A, rename, 1000);
	await h.eventually(() => toast(B, 'is sending too many edits'), (v) => v === true, '4.1 the receiver is told', 15000);
	await B.page.waitForTimeout(1500);
	const landed = Number(String(await nameOn(B)).replace('flood-', ''));
	h.check(landed >= 119 && landed < 999, `4.2 the flood stopped short on Strict: the last of 1000 to land was #${landed}`);

	// ---- 5 Off passes everything
	await inPage(B, `s.peerRateGate.peerRateLimits.set('off');`);
	await A.page.waitForTimeout(100);
	await sendN(A, chat('free-'), 60);
	await sendN(A, rename, 1000);
	await h.eventually(() => nameOn(B), (n) => n === 'flood-999', '5.0 with limits off the whole flood of edits lands', 30000);
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
