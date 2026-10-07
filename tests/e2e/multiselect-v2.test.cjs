// 37 R1 — MULTI-SELECT v2. The Inspector edits a whole selection: rows the members disagree
// on show a mixed state (a dash, an indeterminate checkbox), an edit lands on every member as
// ONE replicated batch (a single `{type:'batch'}` envelope on the wire) and ONE undo step;
// the pivot point (Median / Active / Individual) is on the toolbar as well as the Inspector;
// and dragging a selected row in the object list carries the whole selection onto a group
// (into it) or any other object (parented to it).
const h = require('./helpers.cjs');

/** read a store's current value in the page */
const store = (page, name) => page.evaluate((n) => { let v; window.__stores[n].subscribe((x) => (v = x))(); return v; }, name);
const objOf = (page, uuid, read) =>
	page.evaluate(
		({ u, src }) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const o = g.getObjectByProperty('uuid', u);
			return o ? new Function('o', 'return (' + src + ')(o)')(o) : null;
		},
		{ u: uuid, src: read.toString() }
	);
const worldPos = (page, uuid) =>
	objOf(page, uuid, (o) => { o.updateMatrixWorld(true); const p = o.getWorldPosition(new o.position.constructor()); return p.toArray().map((n) => Math.round(n * 1000) / 1000); });
const near = (a, b, eps = 0.02) => !!a && !!b && a.every((n, i) => Math.abs(n - b[i]) < eps);
const fmt = (v) => (v ? '[' + v.map((n) => Number(n).toFixed(2)).join(', ') + ']' : 'null');

/** wrap every open conn's send on `page` so the suite can read what left the machine */
async function spyWire(page) {
	await page.evaluate(() => {
		let peer;
		window.__stores.peers.subscribe((x) => (peer = x))();
		window.__wire = [];
		for (const conn of Object.values(peer.connections)) {
			if (conn.__spied) continue;
			const send = conn.send.bind(conn);
			conn.send = (m) => {
				window.__wire.push(m?.type === 'batch' ? { type: 'batch', items: m.items.map((i) => i.type) } : { type: m?.type });
				return send(m);
			};
			conn.__spied = true;
		}
	});
}
const wire = (page) => page.evaluate(() => (window.__wire = window.__wire ?? []).splice(0));
/** HTML5 drag from one object-list row to another through the rows' REAL handlers: one
 * DataTransfer shared by dragstart / dragover / drop, as a browser does. (Playwright's dragTo
 * timed out here: the object list is a tabbable window that can sit behind the Inspector's tab.) */
const dragRow = (page, from, to) =>
	page.evaluate(({ from, to }) => {
		const src = document.getElementById(from);
		const dst = document.getElementById(to);
		if (!src || !dst) return 'missing row ' + (!src ? from : to);
		const dt = new DataTransfer();
		const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
		fire(src, 'dragstart');
		fire(dst, 'dragenter');
		const accepted = !fire(dst, 'dragover'); // preventDefault = "you may drop here"
		fire(dst, 'drop');
		fire(src, 'dragend');
		return accepted ? 'ok' : 'refused';
	}, { from, to });
const undoDepth = (page) => page.evaluate(() => { let v; window.__stores.history.undoStack.subscribe((x) => (v = x))(); return v.length; });

h.run(async () => {
	const browser = await h.launch();
	const open = { 'inspector:sec:Transform': 'open', 'inspector:sec:Material': 'open', 'inspector:sec:Object': 'open' };
	const A = await h.setupPage(browser, 'A', { storage: open, context: { viewport: { width: 1400, height: 900 } } });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	// the `modules` handshake carrying wb:1 may land after connect() returns
	await h.eventually(
		() => A.page.evaluate(() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); return [...p.wireBatchPeers]; }),
		(caps) => caps.includes(B.id),
		'premise: B advertised the batch envelope (wb:1) in its handshake',
		30000
	);

	// three boxes; A makes them DISAGREE locally (shadow, roughness, colour)
	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const a = s.addObjects.spawnAtPoint('/create Box 1 1 1', [1, 0, 0]);
		const b = s.addObjects.spawnAtPoint('/create Box 1 1 1', [3, 0, 0]);
		const c = s.addObjects.spawnAtPoint('/create Box 1 1 1', [5, 0, 0]);
		return { a: a.uuid, b: b.uuid, c: c.uuid };
	});
	await h.eventually(() => objOf(B.page, ids.c, (o) => o.uuid), (u) => !!u, 'B has the three boxes', 30000);
	await A.page.evaluate(({ a, b, c }) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const A_ = g.getObjectByProperty('uuid', a);
		A_.castShadow = false;
		g.getObjectByProperty('uuid', b).castShadow = false; // two of three differ: the tick changes TWO
		A_.material.roughness = 0.1;
		A_.material.color.set('#ff0000');
		s.objectActions.selectObject(a, true);
		s.objectActions.selectObject(b, false, true);
		s.objectActions.selectObject(c, false, true);
	}, ids);
	await A.page.waitForSelector('#selection-multi-banner', { timeout: 15000 });
	await A.page.waitForTimeout(400);

	// ---- 1. MIXED STATE ------------------------------------------------------------
	// (38 R5: these rows are Toggles now — aria-pressed "mixed" is the old indeterminate box)
	const cast = await A.page.evaluate(() => { const i = document.querySelector('#inspector-cast-shadow'); return i ? (i.type === 'checkbox' ? { checked: i.checked, ind: i.indeterminate } : { checked: i.getAttribute('aria-pressed') === 'true', ind: i.getAttribute('aria-pressed') === 'mixed' }) : null; });
	h.check(!!cast && cast.ind && !cast.checked, `1.1 Cast shadow reads INDETERMINATE for a set that disagrees (${JSON.stringify(cast)})`);
	const recv = await A.page.evaluate(() => { const i = document.querySelector('#inspector-receive-shadow'); return i ? (i.type === 'checkbox' ? { checked: i.checked, ind: i.indeterminate } : { checked: i.getAttribute('aria-pressed') === 'true', ind: i.getAttribute('aria-pressed') === 'mixed' }) : null; });
	h.check(!!recv && !recv.ind, `1.2 ...and Receive (they all agree) is a plain checkbox (${JSON.stringify(recv)})`);
	// the slider's number box (a DragRow labelled like its row) renders the dash
	const rough = await A.page.evaluate(() => [...document.querySelectorAll('input[aria-label="Roughness"]')].map((i) => i.value));
	h.check(rough.includes('—'), `1.3 Roughness shows the em-dash (${JSON.stringify(rough)})`);
	const colorNote = await A.page.locator('#material-color-mixed').count();
	h.check(colorNote === 1, '1.4 the colour picker says the colours differ');
	const matType = await A.page.evaluate(() => document.querySelector('#select-material')?.textContent?.trim());
	h.check(!!matType && !matType.includes('—'), `1.5 Material type (shared) shows its value (${matType})`);

	// ---- 2. ONE EDIT = ONE BATCH ON THE WIRE + ONE UNDO, B AGREES ----------------------
	await spyWire(A.page);
	await wire(A.page);
	const depth0 = await undoDepth(A.page);
	await A.page.locator('#inspector-cast-shadow').click();
	await A.page.waitForTimeout(400);
	const sent = (await wire(A.page)).filter((m) => m.type !== 'camera' && m.type !== 'vrhands' && m.type !== 'ping');
	const batches = sent.filter((m) => m.type === 'batch');
	h.check(
		batches.length === 1 && batches[0].items.length === 2 && batches[0].items.every((t) => t === 'objectParameters') && !sent.some((m) => m.type === 'objectParameters'),
		`2.1 ticking Cast shadow sent ONE batch with the two members that changed (${JSON.stringify(sent)})`
	);
	const castA = await Promise.all([ids.a, ids.b, ids.c].map((u) => objOf(A.page, u, (o) => o.castShadow)));
	h.check(castA.every(Boolean), `2.2 every member casts on A (${castA})`);
	await h.eventually(() => Promise.all([ids.a, ids.b, ids.c].map((u) => objOf(B.page, u, (o) => o.castShadow))), (v) => v.every(Boolean), '2.3 B applied the whole set', 10000);
	h.check((await undoDepth(A.page)) === depth0 + 1, '2.4 the set edit is ONE undo entry');
	await wire(A.page);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	const undoSent = (await wire(A.page)).filter((m) => m.type === 'batch' || m.type === 'objectParameters');
	h.check(undoSent.length === 1 && undoSent[0].type === 'batch', `2.5 the UNDO also replicates as one batch (${JSON.stringify(undoSent)})`);
	const castUndone = await Promise.all([ids.a, ids.b, ids.c].map((u) => objOf(A.page, u, (o) => o.castShadow)));
	h.check(castUndone.join() === 'false,false,true', `2.6 one undo restores each member's OWN value (${castUndone})`);
	await h.eventually(() => Promise.all([ids.a, ids.b, ids.c].map((u) => objOf(B.page, u, (o) => o.castShadow))), (v) => v.join() === 'false,false,true', '2.7 B follows the undo', 10000);

	// a slider edit on the set: roughness 0.6 lands everywhere, one batch, B agrees
	await wire(A.page);
	await A.page.evaluate(() => window.__stores.objectActions && null);
	const roughRow = A.page.locator('.ui-row', { hasText: 'Roughness' }).locator('input').first();
	if (await roughRow.count()) {
		await roughRow.click();
		await roughRow.fill('0.6');
		await roughRow.press('Enter');
		await A.page.waitForTimeout(400);
		const r = await Promise.all([ids.a, ids.b, ids.c].map((u) => objOf(A.page, u, (o) => o.material.roughness)));
		h.check(r.every((v) => Math.abs(v - 0.6) < 1e-6), `2.8 typing 0.6 into the dashed Roughness sets all three (${r})`);
		await h.eventually(() => Promise.all([ids.a, ids.b, ids.c].map((u) => objOf(B.page, u, (o) => o.material.roughness))), (v) => v.every((x) => Math.abs(x - 0.6) < 1e-6), '2.9 B agrees', 10000);
		const rs = (await wire(A.page)).filter((m) => m.type === 'batch' || m.type === 'objectParameters');
		h.check(rs.some((m) => m.type === 'batch' && m.items.length === 3), `2.10 ...as a batch of three (${JSON.stringify(rs)})`);
	} else h.check(false, '2.8 the Roughness row has a typeable field');

	// ---- 3. PIVOT MODES (Inspector rows drive the set about the pivot) -----------------
	// two boxes at x=1 and x=3; a typed Y rotation of 90° turns them about the pivot
	await A.page.evaluate(({ a, b }) => {
		const s = window.__stores;
		s.objectActions.selectObject(a, true);
		s.objectActions.selectObject(b, false, true);
	}, ids);
	await A.page.waitForSelector('#inspector-rotation .dn-input', { timeout: 15000 });
	const expected = { median: [[2, 0, 1], [2, 0, -1]], active: [[3, 0, 2], [3, 0, 0]], individual: [[1, 0, 0], [3, 0, 0]] };
	for (const mode of ['median', 'active', 'individual']) {
		await A.page.evaluate((m) => window.__stores.multiTransform.pivotMode.set(m), mode);
		await A.page.waitForTimeout(300);
		const seat = await A.page.evaluate(() => window.__stores.multiTransform.multiPivot()?.position.toArray().map((n) => Math.round(n * 1000) / 1000));
		const seatWant = mode === 'active' ? [3, 0, 0] : [2, 0, 0];
		h.check(near(seat, seatWant), `3.${mode} the gizmo seats at the ${mode} pivot (${fmt(seat)})`);
		const yRow = A.page.locator('#inspector-rotation .dn-input').nth(1);
		await yRow.click();
		await yRow.fill('90'); // applies LIVE (DragRow 16-Q3); origin-rows' pattern, no Enter
		await A.page.waitForTimeout(800);
		const pa = await worldPos(A.page, ids.a);
		const pb = await worldPos(A.page, ids.b);
		const rotB = await objOf(A.page, ids.b, (o) => Math.round(o.rotation.y * 1000) / 1000);
		h.check(near(pa, expected[mode][0]) && near(pb, expected[mode][1]) && Math.abs(rotB - Math.PI / 2) < 0.01,
			`3.${mode} a 90° turn about the ${mode} pivot: ${fmt(pa)} / ${fmt(pb)} (rot ${rotB})`);
		await h.eventually(() => Promise.all([worldPos(B.page, ids.a), worldPos(B.page, ids.b)]), ([x, y]) => near(x, expected[mode][0]) && near(y, expected[mode][1]), `3.${mode} B agrees`, 10000);
		await A.page.evaluate(() => window.__stores.history.undo());
		await A.page.waitForTimeout(500);
		const back = await Promise.all([worldPos(A.page, ids.a), worldPos(A.page, ids.b)]);
		h.check(near(back[0], [1, 0, 0]) && near(back[1], [3, 0, 0]), `3.${mode} one undo puts both back (${fmt(back[0])} / ${fmt(back[1])})`);
		await A.page.evaluate(({ a, b }) => {
			const s = window.__stores;
			s.objectActions.selectObject(a, true);
			s.objectActions.selectObject(b, false, true);
		}, ids);
		await A.page.waitForTimeout(300);
	}

	// a typed value followed by Enter (the habit) must not apply twice: DragRow applies LIVE
	// per keystroke and Enter only blurs
	await A.page.evaluate(() => window.__stores.multiTransform.pivotMode.set('median'));
	await A.page.waitForTimeout(300);
	{
		const yRow = A.page.locator('#inspector-rotation .dn-input').nth(1);
		await yRow.click();
		await yRow.fill('90');
		await yRow.press('Enter');
		await A.page.waitForTimeout(900);
		const pa = await worldPos(A.page, ids.a);
		h.check(near(pa, [2, 0, 1]), `3.enter type 90 + Enter turns the set 90°, not 180° (${fmt(pa)})`);
		await A.page.evaluate(() => window.__stores.history.undo());
		await A.page.waitForTimeout(500);
		await A.page.evaluate(({ a, b }) => {
			const s = window.__stores;
			s.objectActions.selectObject(a, true);
			s.objectActions.selectObject(b, false, true);
		}, ids);
		await A.page.waitForTimeout(300);
	}

	// the TOOLBAR cell shows and steps the same mode
	await A.page.evaluate(() => window.__stores.multiTransform.pivotMode.set('median'));
	await A.page.waitForTimeout(200);
	const cell = A.page.locator('#controls-pill [title^="Pivot:"]');
	h.check((await cell.count()) === 1, '3.t1 the toolbar has a Pivot cell');
	const t0 = await cell.getAttribute('title');
	await cell.click();
	await A.page.waitForTimeout(300);
	const t1 = await A.page.locator('#controls-pill [title^="Pivot:"]').getAttribute('title');
	const m1 = await store(A.page, 'pivotMode').catch(() => null);
	const mode1 = m1 ?? (await A.page.evaluate(() => { let v; window.__stores.multiTransform.pivotMode.subscribe((x) => (v = x))(); return v; }));
	h.check(t0?.includes('Median') && t1?.includes('Active') && mode1 === 'active', `3.t2 a click steps Median -> Active (${t0} -> ${t1}, store ${mode1})`);
	const insMode = await A.page.evaluate(() => document.querySelector('#pivot-mode')?.textContent?.trim());
	h.check(!!insMode && insMode.includes('Active'), `3.t3 the Inspector's Pivot row agrees (${insMode})`);
	await A.page.evaluate(() => window.__stores.multiTransform.pivotMode.set('median'));

	// ---- 4. DRAG A SELECTION ONTO A GROUP / A PARENT IN THE OBJECT LIST -------------------
	const g = await A.page.evaluate(() => window.__stores.addObjects.spawnAtPoint('/group', null).uuid);
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(500);
	await A.page.evaluate(({ a, b }) => {
		const s = window.__stores;
		s.objectActions.selectObject(a);
		s.objectActions.selectObject(b, false, true);
	}, ids);
	await A.page.waitForTimeout(300);
	await wire(A.page);
	const depth1 = await undoDepth(A.page);
	const d1 = await dragRow(A.page, ids.a, g);
	h.check(d1 === 'ok', `4.0 the group row accepts the drag (${d1})`);
	await A.page.waitForTimeout(600);
	const parents = await Promise.all([ids.a, ids.b, ids.c].map((u) => objOf(A.page, u, (o) => o.parent?.uuid)));
	h.check(parents[0] === g && parents[1] === g && parents[2] !== g, `4.1 dragging one SELECTED row moved the whole selection into the group (${parents.map((p) => (p === g ? 'G' : 'root')).join(', ')})`);
	const posKept = await worldPos(A.page, ids.b);
	h.check(near(posKept, [3, 0, 0]), `4.2 ...keeping world positions (${fmt(posKept)})`);
	h.check((await undoDepth(A.page)) === depth1 + 1, '4.3 one undo entry');
	const dragSent = (await wire(A.page)).filter((m) => m.type === 'batch' || m.type === 'group');
	h.check(dragSent.length === 1 && dragSent[0].type === 'batch' && dragSent[0].items.length === 2, `4.4 one batch of two group moves (${JSON.stringify(dragSent)})`);
	await h.eventually(() => Promise.all([ids.a, ids.b].map((u) => objOf(B.page, u, (o) => o.parent?.uuid))), (v) => v.every((p) => p === g), '4.5 B has both in the group', 10000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	const after = await Promise.all([ids.a, ids.b].map((u) => objOf(A.page, u, (o) => o.parent?.uuid)));
	h.check(after.every((p) => p !== g), '4.6 one undo takes both back out');
	await h.eventually(() => Promise.all([ids.a, ids.b].map((u) => objOf(B.page, u, (o) => o.parent?.uuid))), (v) => v.every((p) => p !== g), '4.7 B follows', 10000);

	// onto a NON-group object: parenting (Blender's drop-onto)
	await A.page.evaluate(({ a, b }) => {
		const s = window.__stores;
		s.objectActions.selectObject(a);
		s.objectActions.selectObject(b, false, true);
	}, ids);
	await A.page.waitForTimeout(300);
	const d2 = await dragRow(A.page, ids.b, ids.c);
	h.check(d2 === 'ok', `4.8a a plain object row accepts the drag too (${d2})`);
	await A.page.waitForTimeout(600);
	const parented = await Promise.all([ids.a, ids.b].map((u) => objOf(A.page, u, (o) => o.parent?.uuid)));
	h.check(parented.every((p) => p === ids.c), `4.8 dropping onto a box PARENTS the selection to it (${parented.map((p) => (p === ids.c ? 'C' : p)).join(', ')})`);
	await h.eventually(() => Promise.all([ids.a, ids.b].map((u) => objOf(B.page, u, (o) => o.parent?.uuid))), (v) => v.every((p) => p === ids.c), '4.9 B agrees', 10000);
	// a parent dropped onto its own child is refused (no cycle)
	await A.page.evaluate((c) => window.__stores.objectActions.selectObject(c), ids.c);
	await A.page.waitForTimeout(200);
	const refused = await A.page.evaluate(({ a, c }) => window.__stores.objectActions.moveObjectsToParent([c], a), ids);
	h.check(refused === 0, `4.10 a parent dropped into its own child is refused (${refused} moved)`);

	await h.finish(browser);
});
