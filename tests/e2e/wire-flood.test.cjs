// 101 F4 — PER-PEER INBOUND LIMITS: heavy legit loads pass untouched, a flood is throttled.
//
//   1  the heavy LEGIT loads a session really carries, A receiving from B, with the shipped limits:
//      a late join into the biggest template, a 24 MB asset share (the sharing cap is 25 MB), 500
//      creates, a 500-object batch move (WIRE_BATCH_MAX) and a 5 s grab stream at 60 Hz — 0 drops,
//      and the peaks they reach are printed (the STATUS numbers came from this + the suites)
//   2  an `object` over the size cap is dropped and counted; the link stays up
//   3  a FLOODING peer (limits lowered on A so a headless sender can exceed them): its excess is
//      dropped and counted, ONE toast, the link stays open, A's frame time stays within its own
//      idle spread, and B's next ordinary edit lands
//
// The governor is held on a synthetic clock 1e9 ms ahead (governorForTest), so the frames the
// flood measures cannot change the quality level underneath the measurement.
// Run: APP_URL=https://theprototype.app:7020/ node tests/e2e/wire-flood.test.cjs
const fs = require('fs');
const path = require('path');
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
const peaks = (peer) => inPage(peer, 'return s.wireProto.budget.peaks()');
const notes = (peer) => inPage(peer, 'let v = []; s.notifications.subscribe((x) => (v = x))(); return v.map((n) => String(n.text));');

/** median + p10/p90 of rAF deltas over `ms` @param {any} peer @param {number} ms */
const frameStats = (peer, ms) =>
	peer.page.evaluate(
		(dur) =>
			new Promise((resolve) => {
				const d = [];
				let last = performance.now();
				const end = last + dur;
				const tick = (t) => {
					d.push(t - last);
					last = t;
					if (t < end) requestAnimationFrame(tick);
					else {
						d.sort((a, b) => a - b);
						const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
						resolve({ n: d.length, p10: q(0.1), med: q(0.5), p90: q(0.9) });
					}
				};
				requestAnimationFrame(tick);
			}),
		ms
	);

const biggestTemplate = () => {
	const dir = path.join(__dirname, '../../static/templates');
	const all = fs.readdirSync(dir).map((d) => path.join(dir, d, 'scene.tpscene')).filter((p) => fs.existsSync(p));
	return all.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
};

h.run(async () => {
	const browser = await h.launch();
	const B = await h.setupPage(browser, 'B');
	// ---- 1. heavy legit loads ------------------------------------------------------------------
	console.log('\n=== 1. heavy legit loads, shipped limits ===');
	const tpl = biggestTemplate();
	console.log('  template ' + path.basename(path.dirname(tpl)) + ' (' + fs.statSync(tpl).size + ' bytes)');
	await inPage(B, 'const p = await s.sessions.readSessionZip(new Uint8Array(arg).buffer); await s.sessions.applySession(p, { backup: false });', Array.from(fs.readFileSync(tpl)));
	await B.page.waitForTimeout(2000);
	const A = await h.setupPageQuiet(browser, 'A', [B]);
	for (const p of [A, B]) await inPage(p, 's.qualityGovernor.governorForTest.setLevel(s.qualityGovernor.governorForTest.level(), 1e9)');
	const limits = await inPage(A, 'return { ...s.wireProto.budget.limits }');
	console.log('  limits ' + JSON.stringify(limits));
	await h.connect(A, B);
	await h.eventually(() => inPage(A, 'let g; s.objectsGroup.subscribe((v) => (g = v))(); return g.children.length'), (n) => n > 3, 'A has the template (late join)', 60000);
	// a 24 MB file, pushed to A over the sliced asset protocol
	const hash = await inPage(B, `
		const n = 24 * 1024 * 1024; const buf = new Uint8Array(n);
		for (let i = 0; i < n; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(n, i + 65536)));
		const item = await s.explorer.addItemFromBytes(buf.buffer, 'flood-test.bin');
		await s.assetShare.sendAsset(item.hash);
		return item.hash;`);
	await h.eventually(() => inPage(A, 'return !!s.explorer.itemByHash(arg)', hash), Boolean, 'A received the 24 MB asset whole', 120000);
	// 500 creates, then one 500-object batch move, then a 5 s grab stream
	const uuids = await inPage(B, `
		const before = new Set(); let g; s.objectsGroup.subscribe((v) => (g = v))(); for (const c of g.children) before.add(c.uuid);
		for (let i = 0; i < 500; i++) s.commandsHandler.sceneCommand('/create Box 0.2 0.2 0.2');
		await new Promise((r) => setTimeout(r, 1500));
		return g.children.filter((c) => !before.has(c.uuid)).map((c) => c.uuid);`);
	h.check(uuids.length >= 450, `premise: B made ~500 boxes (${uuids.length})`);
	await h.eventually(() => inPage(A, 'let g; s.objectsGroup.subscribe((v) => (g = v))(); return arg.filter((u) => g.getObjectByProperty("uuid", u)).length', uuids), (n) => n >= uuids.length, 'A has every box', 90000);
	await inPage(B, 's.wireProto.withWireBatch(() => { arg.forEach((u, i) => pc.send({ type: "move", uuid: u, pos: [i % 25, 1, Math.floor(i / 25)], rot: [0, 0, 0], scale: [1, 1, 1] })); });', uuids);
	await inPage(B, `
		const u = arg[0]; const t0 = performance.now();
		while (performance.now() - t0 < 5000) {
			const k = (performance.now() - t0) / 1000;
			pc.send({ type: 'move', uuid: u, pos: [Math.sin(k), 1, Math.cos(k)], rot: [0, k, 0], scale: [1, 1, 1] }, { fast: true });
			await new Promise((r) => setTimeout(r, 16));
		}`, uuids);
	await A.page.waitForTimeout(3000);
	const legit = await peaks(A);
	console.log('  PEAKS on A (from B): ' + JSON.stringify({ maxMsgs: legit.maxMsgs, maxBytes: legit.maxBytes, maxObject: legit.maxObject, dropped: legit.dropped }));
	h.check(legit.dropped === 0, `0 legit messages dropped (${legit.dropped})`);
	h.check(legit.maxMsgs * 4 <= limits.msgsPerSec, `msgs/s limit is >= 4x the peak (${legit.maxMsgs} x4 <= ${limits.msgsPerSec})`);
	h.check(legit.maxBytes * 4 <= limits.bytesPerSec, `bytes/s limit is >= 4x the peak (${legit.maxBytes} x4 <= ${limits.bytesPerSec})`);
	h.check(legit.maxObject * 4 <= limits.objectBytes, `object cap is >= 4x the largest object here (${legit.maxObject} x4 <= ${limits.objectBytes})`);
	h.check(!(await notes(A)).some((t) => /sending faster/.test(t)), 'no throttle toast');

	// ---- 2. the object size cap ------------------------------------------------------------------
	console.log('\n=== 2. the object size cap ===');
	await inPage(A, 's.wireProto.budget.limits.objectBytes = 200000');
	await inPage(B, `pc.send({ type: 'object', element: { metadata: { version: 4.6, type: 'Object' }, object: { uuid: 'big-0bj', type: 'Mesh', name: 'big' }, images: [{ uuid: 'i', url: 'data:image/png;base64,' + 'A'.repeat(400000) }] } })`);
	await h.eventually(() => peaks(A), (p) => p.perPeer?.[B.id]?.capped === 1, 'the oversized object is dropped and counted', 20000);
	h.check(!(await inPage(A, 'let g; s.objectsGroup.subscribe((v) => (g = v))(); return !!g.getObjectByProperty("uuid", "big-0bj")')), 'it never reached the scene');
	h.check(await inPage(A, 'return pc.openedPeers.has(arg)', B.id), 'the link stays up');
	await inPage(A, 'Object.assign(s.wireProto.budget.limits, arg)', limits);

	// ---- 3. a flooding peer -------------------------------------------------------------------------
	console.log('\n=== 3. a flooding peer ===');
	const idle = await frameStats(A, 4000);
	console.log('  A idle frames ' + JSON.stringify(idle));
	await inPage(A, 's.wireProto.budget.limits.msgsPerSec = 300; s.wireProto.budget.limits.bytesPerSec = 4 * 1024 * 1024');
	const before = (await peaks(A)).perPeer?.[B.id]?.dropped ?? 0;
	const flooding = inPage(B, `
		const t0 = performance.now(); let n = 0;
		while (performance.now() - t0 < 6000) {
			for (let i = 0; i < 200; i++) { pc.send({ type: 'linkaway', hidden: false }); n++; }
			await new Promise((r) => setTimeout(r, 10));
		}
		return n;`);
	await A.page.waitForTimeout(1500);
	const flood = await frameStats(A, 4000);
	const sent = await flooding;
	console.log('  A frames during the flood ' + JSON.stringify(flood) + ', B sent ' + sent);
	await A.page.waitForTimeout(2000);
	const after = await peaks(A);
	const dropped = (after.perPeer?.[B.id]?.dropped ?? 0) - before;
	h.check(dropped > 0, `the flood's excess is dropped and counted (${dropped} of ${sent})`);
	const toasts = (await notes(A)).filter((t) => /sending faster than this session can take/.test(t));
	h.check(toasts.length === 1, `ONE throttled toast (${toasts.length})`);
	h.check(await inPage(A, 'return pc.openedPeers.has(arg)', B.id), 'never a disconnect: the link is still open');
	const errs = await inPage(A, 'return s.wireErrors.wireErrors().filter((e) => e.peerId === arg && e.type.startsWith("budget:"))', B.id);
	h.check(errs.some((e) => e.type === 'budget:msgs' && e.count > 0), 'the drops are in the per-peer wire table (Diagnostics)');
	const spread = Math.max(idle.p90 - idle.p10, idle.med * 0.25, 8);
	h.check(flood.med <= idle.med + spread, `A stays responsive: median frame ${flood.med.toFixed(1)} ms vs idle ${idle.med.toFixed(1)} ms (spread ${spread.toFixed(1)})`);
	await inPage(A, 'Object.assign(s.wireProto.budget.limits, arg)', limits);
	await A.page.waitForTimeout(1200);
	await inPage(B, 'pc.send({ type: "move", uuid: arg, pos: [7, 3, 7], rot: [0, 0, 0], scale: [1, 1, 1] })', uuids[1]);
	await h.eventually(() => inPage(A, 'let g; s.objectsGroup.subscribe((v) => (g = v))(); const o = g.getObjectByProperty("uuid", arg); return o ? o.position.x : null', uuids[1]), (x) => Math.abs(x - 7) < 0.01, "B's next ordinary edit lands on A", 15000);

	await h.finish(browser);
});
