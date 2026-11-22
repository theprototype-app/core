// 102b-arrange row 1 — the Array tool on two connected peers through the real Inspector:
//   1. "Make an array" on a box: ONE objectParameters message, both peers draw the copies
//      (one InstancedMesh per mesh = one draw call for the whole array), no object is added;
//   2. count / shape edits: both peers follow, ONE undo puts the previous array back on both;
//   3. the copies sit where the record says on both peers (same poses), circle + grid;
//   4. Make real objects: every copy becomes an object on both peers, ONE wire envelope,
//      ONE undo takes them all away and brings the array back;
//   5. a scene saved with an array (kept for the older-release check) and B reloading + rejoining
//      draws the array again; a scene with no array draws nothing (feature unused = no change).
// Counterfactual on v1.71.0: there is no #array-section and no `array` record.
// Run: APP_URL=https://localhost:7090/ npm run e2e -- array-tool
const h = require('./helpers.cjs');

async function spyWire(page) {
	await page.evaluate(() => {
		let peer;
		window.__tp.test.v1.peers.subscribe((x) => (peer = x))();
		window.__wire = [];
		for (const conn of Object.values(peer.connections)) {
			if (conn.__spied) continue;
			const send = conn.send.bind(conn);
			conn.send = (m) => {
				window.__wire.push(m?.type === 'batch' ? { type: 'batch', items: m.items.map((i) => i.type) } : { type: m?.type, parameter: m?.parameter });
				return send(m);
			};
			conn.__spied = true;
		}
	});
}
const wire = (page) => page.evaluate(() => (window.__wire = window.__wire ?? []).splice(0));
const SCENE_TYPES = new Set(['objectParameters', 'duplicate', 'move', 'batch', 'create', 'object', 'delete']);
const sceneMsgs = (list) => list.filter((m) => SCENE_TYPES.has(m.type));

const drawn = (peer, uuid) => peer.page.evaluate((id) => window.__tp.test.v1.arrayRuntime.arraysDebug().copies[id] ?? 0, uuid);
const draws = (peer) => peer.page.evaluate(() => window.__tp.test.v1.arrayRuntime.arraysDebug().draws);
const record = (peer, uuid) =>
	peer.page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', id)?.userData?.array ?? null;
	}, uuid);
const childCount = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
const posesOf = (peer, uuid) =>
	peer.page.evaluate((id) => {
		const w = window.__tp.test.v1;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		return o ? w.arrayRuntime.copyPosesOf(o, g).map((p) => p.position.map((n) => Math.round(n * 1000) / 1000)) : null;
	}, uuid);
const undo = (peer) => peer.page.evaluate(() => window.__tp.test.v1.history.undo());
const sameArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__tp?.test.v1?.arrayRuntime, null, { timeout: 60000 });
	await h.connect(B, A);

	const uuid = await A.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 500));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	await A.page.waitForTimeout(1500);
	await h.eventually(() => childCount(B), (n) => n >= 1, 'premise: B has the box', 10000);
	const kidsA0 = await childCount(A);
	const kidsB0 = await childCount(B);
	h.check((await draws(A)) === 0 && (await draws(B)) === 0, 'feature unused: no array copies drawn on either peer');

	console.log('\n=== 1. Make an array (the real Inspector button) ===');
	await A.page.evaluate((id) => window.__tp.test.v1.objectActions.applySelectionSet([id], true), uuid);
	await A.page.waitForSelector('#array-start', { timeout: 20000 }).catch(() => {});
	h.check(await A.page.locator('#array-start').isVisible().catch(() => false), 'the Inspector shows the Array section with "Make an array"');
	await spyWire(A.page);
	await wire(A.page);
	await A.page.locator('#array-start').scrollIntoViewIfNeeded();
	await A.page.locator('#array-start').click();
	await A.page.waitForTimeout(600);
	const sent1 = sceneMsgs(await wire(A.page));
	h.check(sent1.length === 1 && sent1[0].type === 'objectParameters' && sent1[0].parameter === 'array', 'ONE objectParameters message for the whole array' + ' | ' + JSON.stringify(sent1));
	const recA = await record(A, uuid);
	h.check(recA?.mode === 'line' && recA?.count === 5, 'A: the object holds a 5-in-a-line record' + ' | ' + JSON.stringify(recA));
	await h.eventually(() => record(B, uuid), (r) => !!r && r.count === 5, 'B: the record arrived', 10000);
	for (const [p, n] of [[A, 'A'], [B, 'B']]) {
		await h.eventually(() => drawn(p, uuid), (c) => c === 4, `${n}: draws 4 copies`, 10000);
		h.check((await draws(p)) === 1, `${n}: the whole array is ONE draw call (one mesh in a box)`);
	}
	h.check((await childCount(A)) === kidsA0 && (await childCount(B)) === kidsB0, 'no object was added on either peer (the copies are drawn, not objects)');
	await h.eventually(() => A.page.locator('#array-summary').textContent(), (t) => /5 in a line/.test(t ?? ''), 'the section says "5 in a line"', 4000);

	console.log('\n=== 2. edits follow on both peers; ONE undo puts the last array back ===');
	await A.page.evaluate((id) => window.__tp.test.v1.arrayActions.setArray(id, { count: 12 }), uuid);
	for (const [p, n] of [[A, 'A'], [B, 'B']]) await h.eventually(() => drawn(p, uuid), (c) => c === 11, `${n}: count 12 -> 11 copies`, 10000);
	await undo(A);
	for (const [p, n] of [[A, 'A'], [B, 'B']]) await h.eventually(() => drawn(p, uuid), (c) => c === 4, `${n}: ONE undo -> back to 4 copies`, 10000);
	// the Shape control (a real click on the Segmented's Grid)
	await A.page.locator('#array-mode').getByText('Grid', { exact: true }).click();
	for (const [p, n] of [[A, 'A'], [B, 'B']]) await h.eventually(() => drawn(p, uuid), (c) => c === 8, `${n}: Grid 3 x 1 x 3 -> 8 copies`, 10000);

	console.log('\n=== 3. the copies stand in the same places on both peers ===');
	await A.page.evaluate((id) => window.__tp.test.v1.arrayActions.setArray(id, { mode: 'circle', count: 6, radius: 3, arc: 360 }), uuid);
	await h.eventually(() => drawn(B, uuid), (c) => c === 5, 'B: circle of 6 -> 5 copies', 10000);
	const pa = await posesOf(A, uuid);
	await h.eventually(() => posesOf(B, uuid), (pb) => sameArr(pa, pb), 'circle: B places every copy where A does', 10000);
	const box = await A.page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', id).position.toArray();
	}, uuid);
	const centre = [box[0] - 3, box[2]];
	h.check(pa.every((p) => Math.abs(Math.hypot(p[0] - centre[0], p[2] - centre[1]) - 3) < 0.01), 'circle: every copy is 3 m from the centre' + ' | ' + JSON.stringify(pa));

	console.log('\n=== 4. Make real objects: one envelope, one undo ===');
	await A.page.evaluate((id) => window.__tp.test.v1.arrayActions.setArray(id, { mode: 'line', count: 4, step: [2, 0, 0] }), uuid);
	await h.eventually(() => drawn(B, uuid), (c) => c === 3, 'B: a line of 4 again (3 copies)', 10000);
	await A.page.evaluate((id) => window.__tp.test.v1.objectActions.applySelectionSet([id], true), uuid);
	await A.page.waitForSelector('#array-make-real', { timeout: 10000 }).catch(() => {});
	await spyWire(A.page);
	await wire(A.page);
	await A.page.locator('#array-make-real').scrollIntoViewIfNeeded();
	await A.page.locator('#array-make-real').click();
	await A.page.waitForTimeout(800);
	const sent4 = sceneMsgs(await wire(A.page));
	h.check(sent4.length === 1 && sent4[0].type === 'batch', 'Make real objects left as ONE wire envelope' + ' | ' + JSON.stringify(sent4));
	h.check((await childCount(A)) === kidsA0 + 3, 'A: 3 new objects' + ' | ' + String(await childCount(A)));
	await h.eventually(() => childCount(B), (n) => n === kidsB0 + 3, 'B: the same 3 new objects', 10000);
	h.check((await record(A, uuid)) === null && (await drawn(A, uuid)) === 0, 'A: the record is gone, nothing drawn any more');
	const xs = await A.page.evaluate((k) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		return g.children.slice(k).map((o) => Math.round(o.position.x * 1000) / 1000);
	}, kidsA0);
	h.check(sameArr(xs, [box[0] + 2, box[0] + 4, box[0] + 6].map((n) => Math.round(n * 1000) / 1000)), 'the objects stand where the copies were (2 m apart)' + ' | ' + JSON.stringify(xs));
	await undo(A);
	await h.eventually(() => childCount(A), (n) => n === kidsA0, 'A: ONE undo takes all 3 away', 10000);
	await h.eventually(() => childCount(B), (n) => n === kidsB0, 'B: and on the other peer', 10000);
	await h.eventually(() => drawn(B, uuid), (c) => c === 3, 'B: the array is back (3 copies drawn)', 10000);

	console.log('\n=== 5. a saved array; B reloads and rejoins ===');
	const bytes = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const zip = await s.sessions.exportSessionZip(s.sessions.buildSessionPayload('array-tool'), { assets: true, packs: false, flow: true });
		return Array.from(zip);
	});
	const out = require('path').resolve(__dirname, '../../test-results/102b-arrange');
	require('fs').mkdirSync(out, { recursive: true });
	require('fs').writeFileSync(out + '/lane-saved-array.tpscene', Buffer.from(bytes));
	h.check(bytes.length > 1000, 'saved test-results/102b-arrange/lane-saved-array.tpscene' + ' | ' + String(bytes.length));
	await h.freshReload(B);
	// a joiner's reload REJOINS by itself (no restore question, no dial input): wait for that, and
	// only a page that does not rejoin answers the restore and dials (the text-object pattern)
	const rejoined = await B.page
		.waitForFunction(() => { let p; window.__tp.test.v1.peers.subscribe((v) => (p = v))(); return (p?.openedPeers?.length ?? p?.openedPeers?.size ?? 0) > 0; }, null, { timeout: 30000, polling: 250 })
		.then(() => true)
		.catch(() => false);
	console.log('B rejoined after its reload by itself:', rejoined);
	if (!rejoined) {
		await h.answerRestore(B, 'dismiss').catch(() => {});
		await h.connect(B, A);
	}
	await h.eventually(() => record(B, uuid), (r) => !!r && r.count === 4, 'B after reload: the record came back with the object', 60000);
	await h.eventually(() => drawn(B, uuid), (c) => c === 3, 'B after reload: draws the 3 copies again', 20000);

	await h.finish(browser);
});
