// 102b-arrange row 2 — TIDY BIG SCENES on two connected peers:
//   1. layers: a layer made on A reaches B (the scenePhysics singleton); putting two boxes on it is
//      ONE wire envelope and ONE undo on both peers;
//   2. hide is THIS screen's: A's boxes hide, B's stay; a serializer's park shows them (saves keep
//      them visible); Play shows them;
//   3. lock: a real viewport click on a locked box selects nothing of it; unlocked it selects;
//   4. select similar (the real Tidy button): the two boxes, not the sphere;
//   5. rename many (the real field + button): "Wall-1", "Wall-2" on both peers, ONE undo (a hyphen:
//      a joiner's full sync is glTF, whose loader turns a space into '_' — pre-existing, see summary);
//   6. randomise: the same poses on both peers, ONE undo;
//   7. a scene saved with layers (kept for the older-release check); B reloads + rejoins: the table,
//      the objects' layers and names come back; a scene with no layers saves no `layers` key.
// Counterfactual on v1.71.0: no layer table, no #tidy-section.
// Run: APP_URL=https://localhost:7090/ npm run e2e -- tidy-layers
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
const SCENE_TYPES = new Set(['objectParameters', 'name', 'move', 'batch', 'scenephysics']);

const obj = (peer, uuid, fn) =>
	peer.page.evaluate(
		({ id, src }) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', id);
			return o ? new Function('o', 'return (' + src + ')(o)')(o) : null;
		},
		{ id: uuid, src: fn.toString() }
	);
const layerOf = (peer, uuid) => obj(peer, uuid, (o) => o.userData.layer ?? null);
const visibleOf = (peer, uuid) => obj(peer, uuid, (o) => o.visible);
const nameOf = (peer, uuid) => obj(peer, uuid, (o) => o.name);
const poseOf = (peer, uuid) => obj(peer, uuid, (o) => [...o.position.toArray(), ...o.rotation.toArray().slice(0, 3), ...o.scale.toArray()].map((n) => Math.round(n * 1e4) / 1e4));
const table = (peer) => peer.page.evaluate(() => new Promise((r) => window.__tp.test.v1.scenePhysics.scenePhysicsState_.subscribe((s) => r(s.layers ?? null))()));
const selection = (peer) => peer.page.evaluate(() => new Promise((r) => window.__tp.test.v1.selectedObjects.subscribe((s) => r([...(s ?? [])]))()));
const undo = (peer) => peer.page.evaluate(() => window.__tp.test.v1.history.undo());
const redo = (peer) => peer.page.evaluate(() => window.__tp.test.v1.history.redo());
const tidy = (peer, fn, ...args) => peer.page.evaluate(({ src, args }) => new Function('t', 'args', 'return (' + src + ')(t, ...args)')(window.__tp.test.v1.tidyActions, args), { src: fn.toString(), args });

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__tp?.test.v1?.tidyActions, null, { timeout: 60000 });
	await h.connect(B, A);

	const bare = await A.page.evaluate(() => window.__tp.test.v1.scenePhysics.scenePhysicsSnapshot()?.layers ?? null);
	h.check(bare === null, 'feature unused: a scene with no layers saves no layers key');

	const [b1, b2, sp] = await A.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const out = [];
		for (const cmd of ['/create Box 1 1 1', '/create Box 1 1 1', '/create Sphere']) {
			w.commandsHandler.sceneCommand(cmd);
			await new Promise((r) => setTimeout(r, 450));
			let g;
			w.objectsGroup.subscribe((v) => (g = v))();
			out.push(g.children[g.children.length - 1].uuid);
		}
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		let p;
		w.peers.subscribe((v) => (p = v))();
		[[-2, 0.5, 0], [0, 0.5, 0], [2, 0.5, 0]].forEach((pos, i) => {
			const o = g.getObjectByProperty('uuid', out[i]);
			o.position.set(...pos);
			o.updateMatrixWorld(true);
			p.send({ type: 'move', uuid: o.uuid, pos, rot: [0, 0, 0], scale: [1, 1, 1] });
		});
		return out;
	});
	await A.page.waitForTimeout(1500);
	await h.eventually(() => nameOf(B, sp), (n) => !!n, 'premise: B has the three objects', 10000);

	console.log('\n=== 1. a layer; two boxes on it: one envelope, one undo ===');
	const id = await tidy(A, (t) => t.addLayer('Walls'));
	await h.eventually(() => table(B), (t) => Array.isArray(t) && t.some((l) => l.id === id && l.name === 'Walls'), 'B: the layer "Walls" arrived', 10000);
	await spyWire(A.page);
	await wire(A.page);
	await tidy(A, (t, ids, id) => t.setObjectsLayer(ids, id), [b1, b2], id);
	await A.page.waitForTimeout(500);
	const sent = (await wire(A.page)).filter((m) => SCENE_TYPES.has(m.type));
	h.check(sent.length === 1 && sent[0].type === 'batch', 'two objects onto a layer = ONE envelope | ' + JSON.stringify(sent));
	for (const u of [b1, b2]) await h.eventually(() => layerOf(B, u), (l) => l === id, 'B: the box is on Walls', 10000);
	h.check((await layerOf(A, sp)) === null, 'the sphere is on no layer');
	await undo(A);
	for (const u of [b1, b2]) await h.eventually(() => layerOf(B, u), (l) => l === null, 'ONE undo: B has the box back on no layer', 10000);
	await redo(A);
	for (const u of [b1, b2]) await h.eventually(() => layerOf(B, u), (l) => l === id, 'redo: back on Walls on B', 10000);

	console.log('\n=== 2. hide is this screen only; saves and Play see everything ===');
	await tidy(A, (t, id) => t.setLayerHidden(id, true), id);
	await A.page.waitForTimeout(400);
	h.check((await visibleOf(A, b1)) === false && (await visibleOf(A, b2)) === false, 'A: the two boxes are hidden');
	h.check((await visibleOf(A, sp)) === true, 'A: the sphere stays');
	await B.page.waitForTimeout(600);
	h.check((await visibleOf(B, b1)) === true && (await visibleOf(B, b2)) === true, 'B: nothing hidden (hide is local)');
	const parked = await A.page.evaluate((ids) => {
		const w = window.__tp.test.v1;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const unpark = w.flowRuntime.parkAnimatedAtBase();
		const during = ids.map((u) => g.getObjectByProperty('uuid', u).visible);
		unpark();
		const after = ids.map((u) => g.getObjectByProperty('uuid', u).visible);
		return { during, after };
	}, [b1, b2]);
	h.check(parked.during.every((v) => v === true) && parked.after.every((v) => v === false), 'a serializer\'s park shows them, then they hide again | ' + JSON.stringify(parked));
	await A.page.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	await A.page.waitForTimeout(300);
	h.check((await visibleOf(A, b1)) === true, 'Play shows a hidden layer');
	await A.page.evaluate(() => window.__tp.test.v1.isLocked.set(null));
	await A.page.waitForTimeout(300);
	h.check((await visibleOf(A, b1)) === false, 'back in the editor it hides again');
	await tidy(A, (t, id) => t.setLayerHidden(id, false), id);
	await A.page.waitForTimeout(300);
	h.check((await visibleOf(A, b1)) === true, 'Show brings them back');

	console.log('\n=== 3. lock: a viewport click passes through ===');
	await tidy(A, (t, id) => t.updateLayer(id, { locked: true }), id);
	await h.eventually(() => table(B), (t) => t?.find((l) => l.id === id)?.locked === true, 'B: the layer is locked too (scene data)', 10000);
	const clickOn = async (uuid) => {
		await A.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
		await A.page.waitForTimeout(300);
		const px = await A.page.evaluate((u) => {
			const w = window.__tp.test.v1;
			let g, cam;
			w.objectsGroup.subscribe((v) => (g = v))();
			w.globalCamera.subscribe((v) => (cam = v))();
			const o = g.getObjectByProperty('uuid', u);
			const p = o.getWorldPosition(new w.THREE.Vector3()).project(cam);
			let renderer;
			w.globalRenderer.subscribe((v) => (renderer = v))();
			const r = renderer.domElement.getBoundingClientRect();
			return [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
		}, uuid);
		await A.page.mouse.click(px[0], px[1]);
		await A.page.waitForTimeout(700);
		return selection(A);
	};
	const lockedSel = await clickOn(b1);
	h.check(!lockedSel.includes(b1), 'a click on a box of the locked layer does not select it | ' + JSON.stringify(lockedSel));
	await tidy(A, (t, id) => t.updateLayer(id, { locked: false }), id);
	await A.page.waitForTimeout(300);
	const openSel = await clickOn(b1);
	h.check(openSel.includes(b1), 'unlocked, the same click selects it | ' + JSON.stringify(openSel));

	console.log('\n=== 4. select similar (the real button) ===');
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.applySelectionSet([u], true), b1);
	await A.page.waitForSelector('#tidy-similar-shape', { timeout: 15000 }).catch(() => {});
	await A.page.locator('#tidy-similar-shape').scrollIntoViewIfNeeded();
	await A.page.locator('#tidy-similar-shape').click();
	await A.page.waitForTimeout(500);
	const sim = await selection(A);
	h.check(sim.length === 2 && sim.includes(b1) && sim.includes(b2) && !sim.includes(sp), 'Same shape selects the two boxes, not the sphere | ' + JSON.stringify(sim));

	console.log('\n=== 5. rename many (the real field and button) ===');
	await A.page.evaluate((ids) => window.__tp.test.v1.objectActions.applySelectionSet(ids, true), [b1, b2]);
	await A.page.waitForSelector('#tidy-rename-pattern', { timeout: 10000 }).catch(() => {});
	await A.page.locator('#tidy-rename-pattern').fill('Wall-{n}');
	await A.page.waitForTimeout(200);
	h.check(/Wall-1, Wall-2/.test((await A.page.locator('#tidy-rename-preview').textContent()) ?? ''), 'the preview reads "Wall-1, Wall-2"');
	const names0 = [await nameOf(A, b1), await nameOf(A, b2)];
	await A.page.locator('#tidy-rename').click();
	await A.page.waitForTimeout(500);
	for (const [u, n] of [[b1, 'Wall-1'], [b2, 'Wall-2']]) await h.eventually(() => nameOf(B, u), (v) => v === n, `B: renamed "${n}"`, 10000);
	await undo(A);
	await h.eventually(async () => [await nameOf(B, b1), await nameOf(B, b2)], (v) => JSON.stringify(v) === JSON.stringify(names0), 'ONE undo puts both names back on B', 10000);
	await redo(A);
	await h.eventually(() => nameOf(B, b2), (v) => v === 'Wall-2', 'redo: renamed again on B', 10000);

	console.log('\n=== 6. randomise ===');
	const p0 = [await poseOf(A, b1), await poseOf(A, b2)];
	await tidy(A, (t, ids) => t.randomise(ids, { rot: [0, 90, 0], scale: [0.5, 1.5], offset: [0.5, 0, 0.5], seed: 3 }), [b1, b2]);
	const pa = [await poseOf(A, b1), await poseOf(A, b2)];
	h.check(JSON.stringify(pa) !== JSON.stringify(p0), 'A: the boxes turned, resized and moved');
	await h.eventually(async () => [await poseOf(B, b1), await poseOf(B, b2)], (pb) => JSON.stringify(pb) === JSON.stringify(pa), 'B: the same poses', 10000);
	await undo(A);
	await h.eventually(async () => [await poseOf(B, b1), await poseOf(B, b2)], (pb) => JSON.stringify(pb) === JSON.stringify(p0), 'ONE undo restores both on B', 10000);

	console.log('\n=== 7. saved with layers; B reloads and rejoins ===');
	const bytes = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const zip = await s.sessions.exportSessionZip(s.sessions.buildSessionPayload('tidy-layers'), { assets: true, packs: false, flow: true });
		return Array.from(zip);
	});
	const out = require('path').resolve(__dirname, '../../test-results/102b-arrange');
	require('fs').mkdirSync(out, { recursive: true });
	require('fs').writeFileSync(out + '/lane-saved-layers.tpscene', Buffer.from(bytes));
	h.check(bytes.length > 1000, 'saved test-results/102b-arrange/lane-saved-layers.tpscene | ' + bytes.length);
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
	await h.eventually(() => table(B), (t) => Array.isArray(t) && t.some((l) => l.id === id), 'B after reload: the layer table is back', 60000);
	await h.eventually(() => layerOf(B, b1), (l) => l === id, 'B after reload: the box is on its layer', 20000);
	await h.eventually(() => nameOf(B, b2), (v) => v === 'Wall-2', 'B after reload: the names are back', 20000);

	await h.finish(browser);
});
