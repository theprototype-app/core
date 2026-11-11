// 47 M2 — Align / Distribute / Drop to ground over a multi-selection: exact positions on BOTH
// peers, ONE undo restores the whole set, and Drop lands on a box top and on y = 0.
//
// Three boxes of different widths (1, 2, 0.5 on X) so min / centre / max and centres / gaps all
// give different answers. Every op is pressed through the REAL Inspector Arrange section (or the
// object menu row), then the poses are read on A and on B. Counterfactual on v1.36.0: there is no
// Arrange section, and the menu's per-object "Align to ground" recorded one undo entry PER object
// (section 6 asserts the depth grows by exactly one for two drops).
const h = require('./helpers.cjs');

const EPS = 1e-6;

/** world boxes + positions of the named uuids on a page */
const poses = (page, uuids) =>
	page.evaluate((ids) => {
		const w = window.__tp?.test.v1;
		let g; w.objectsGroup.subscribe((v) => (g = v))();
		return ids.map((id) => {
			const o = g.getObjectByProperty('uuid', id);
			if (!o) return null;
			o.updateMatrixWorld(true);
			o.geometry.computeBoundingBox();
			const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
			return { pos: o.position.toArray(), min: bb.min.toArray(), max: bb.max.toArray() };
		});
	}, uuids);

const depth = (page) =>
	page.evaluate(() => {
		let d; window.__tp.test.v1.history.undoStack.subscribe((v) => (d = v.length))();
		return d;
	});

/** pose the boxes on A and replicate (the move path) */
async function place(A, items) {
	await A.page.evaluate((list) => {
		const w = window.__tp?.test.v1;
		let g; w.objectsGroup.subscribe((v) => (g = v))();
		let p; w.peers.subscribe((v) => (p = v))();
		for (const it of list) {
			const o = g.getObjectByProperty('uuid', it.uuid);
			o.position.set(...it.pos);
			o.rotation.set(0, 0, 0);
			o.scale.set(1, 1, 1);
			o.updateMatrixWorld(true);
			p.send({ type: 'move', uuid: it.uuid, pos: it.pos, rot: [0, 0, 0], scale: [1, 1, 1] });
		}
	}, items);
}

const near = (a, b, eps = EPS) => Math.abs(a - b) < eps;
const fmt = (n) => (n == null ? '—' : Number(n).toFixed(4));

/** both peers agree with `expect(boxes)`, polled on B (the wire is async) */
async function onBoth(A, B, uuids, test, label) {
	const a = await poses(A.page, uuids);
	h.check(test(a), `${label} — on A (${a.map((p) => p && p.pos.map(fmt).join(',')).join(' | ')})`);
	await h.eventually(() => poses(B.page, uuids), (b) => b.every(Boolean) && test(b), `${label} — on B`, 10000);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS }); // real clicks on a loaded box (the measure-tool note)
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await h.connect(B, A);

	const uuids = await A.page.evaluate(async () => {
		const w = window.__tp?.test.v1;
		const out = [];
		for (const dims of ['1 1 1', '2 1 1', '0.5 1 1']) {
			w.commandsHandler.sceneCommand('/create Box ' + dims);
			await new Promise((r) => setTimeout(r, 400));
			let g; w.objectsGroup.subscribe((v) => (g = v))();
			out.push(g.children[g.children.length - 1].uuid);
		}
		return out;
	});
	await A.page.waitForTimeout(1500); // /create re-seats after it returns
	const START = [
		{ uuid: uuids[0], pos: [-3, 0.5, 0] }, // x [-3.5, -2.5]
		{ uuid: uuids[1], pos: [1, 2, 1] }, //    x [0, 2]
		{ uuid: uuids[2], pos: [4, 0.5, -1] } //  x [3.75, 4.25]
	];
	await place(A, START);
	await onBoth(A, B, uuids, (p) => p.every((q, i) => q && near(q.pos[0], START[i].pos[0])), 'premise: three boxes posed on both peers');

	// select all three and open the Inspector (properties of a SET)
	await A.page.evaluate((ids) => window.__tp.test.v1.objectActions.applySelectionSet(ids, true), uuids);
	await A.page.waitForSelector('#arrange-section', { timeout: 15000 }).catch(() => {});
	h.check(await A.page.locator('#arrange-section').isVisible().catch(() => false), 'the multi-select Inspector shows the Arrange section');
	const press = async (id) => {
		const el = A.page.locator('#' + id);
		await el.scrollIntoViewIfNeeded();
		await el.click();
		await A.page.waitForTimeout(400);
	};
	const undo = async () => {
		await A.page.evaluate(() => window.__tp.test.v1.history.undo());
		await A.page.waitForTimeout(400);
	};
	const restored = (p) => p.every((q, i) => q && START[i].pos.every((v, a) => near(q.pos[a], v)));

	// --- 1. Align X min / centre / max (to the selection bounds), one undo each ---
	const cases = [
		{ id: 'arrange-align-x-min', test: (p) => p.every((q) => near(q.min[0], -3.5)), label: 'Align X min puts every left edge on -3.5' },
		{ id: 'arrange-align-x-center', test: (p) => p.every((q) => near((q.min[0] + q.max[0]) / 2, (-3.5 + 4.25) / 2)), label: 'Align X centre puts every centre on 0.375' },
		{ id: 'arrange-align-x-max', test: (p) => p.every((q) => near(q.max[0], 4.25)), label: 'Align X max puts every right edge on 4.25' }
	];
	for (const c of cases) {
		const d0 = await depth(A.page);
		await press(c.id);
		await onBoth(A, B, uuids, c.test, c.label);
		const other = await poses(A.page, uuids);
		h.check(other.every((q, i) => near(q.pos[1], START[i].pos[1]) && near(q.pos[2], START[i].pos[2])), `${c.label}: Y and Z untouched`);
		h.check((await depth(A.page)) === d0 + 1, `${c.label}: ONE undo entry (${d0} -> ${await depth(A.page)})`);
		await undo();
		await onBoth(A, B, uuids, restored, `one undo restores all three after ${c.id}`);
	}

	// --- 2. Align to the ACTIVE object (the last picked: the 0.5-wide box at x 4) ---
	await A.page.locator('#arrange-align-to').getByText('Active', { exact: true }).click();
	await press('arrange-align-x-min');
	await onBoth(A, B, uuids, (p) => p.every((q) => near(q.min[0], 3.75)) && near(p[2].pos[0], 4), 'Align X min to active: every left edge on the active box (3.75), which stays');
	await undo();
	await onBoth(A, B, uuids, restored, 'one undo restores the align-to-active');
	await A.page.locator('#arrange-align-to').getByText('Selection', { exact: true }).click();

	// --- 3. Distribute gaps and centres on X ---
	const d0 = await depth(A.page);
	await press('arrange-dist-x-gaps');
	await onBoth(
		A,
		B,
		uuids,
		(p) => {
			const sorted = [...p].sort((a, b) => a.min[0] - b.min[0]);
			const g1 = sorted[1].min[0] - sorted[0].max[0];
			const g2 = sorted[2].min[0] - sorted[1].max[0];
			return near(g1, g2) && near(g1, (4.25 - -3.5 - 3.5) / 2) && near(p[0].min[0], -3.5) && near(p[2].max[0], 4.25);
		},
		'Distribute X gaps: equal 2.125 m gaps, the outer two stay'
	);
	h.check((await depth(A.page)) === d0 + 1, 'Distribute: ONE undo entry');
	await undo();
	await onBoth(A, B, uuids, restored, 'one undo restores the distribute');
	await press('arrange-dist-x-centers');
	await onBoth(A, B, uuids, (p) => near(p[1].pos[0], (-3 + 4) / 2) && near(p[0].pos[0], -3) && near(p[2].pos[0], 4), 'Distribute X centres: the middle box centred at 0.5');
	await undo();
	await onBoth(A, B, uuids, restored, 'one undo restores the centre distribute');

	// --- 4. Drop to ground: onto a box top, and onto y = 0 ---
	const DROP = [
		{ uuid: uuids[0], pos: [1, 4, 1] }, //  above the 2-wide box (top at y 1 when it sits at y 0.5)
		{ uuid: uuids[1], pos: [1, 0.5, 1] }, // the platform: x [0, 2], y [0, 1]
		{ uuid: uuids[2], pos: [6, 3, 3] } //   nothing under it
	];
	await place(A, DROP);
	await onBoth(A, B, uuids, (p) => near(p[0].pos[1], 4) && near(p[2].pos[1], 3), 'premise: two boxes lifted');
	await A.page.evaluate((ids) => window.__tp.test.v1.objectActions.applySelectionSet([ids[0], ids[2]], true), uuids);
	await A.page.waitForSelector('#arrange-drop', { timeout: 15000 }).catch(() => {});
	const dd = await depth(A.page);
	await press('arrange-drop');
	await onBoth(A, B, uuids, (p) => near(p[0].min[1], 1, 1e-4) && near(p[2].min[1], 0, 1e-4), 'Drop to ground: the first lands on the box top (y 1), the second on y 0');
	h.check((await depth(A.page)) === dd + 1, 'Drop to ground of two objects is ONE undo entry');
	await undo();
	await onBoth(A, B, uuids, (p) => near(p[0].pos[1], 4) && near(p[2].pos[1], 3), 'one undo lifts both back');

	// --- 5. the object menu row does the same, as one entry ---
	const menu = await A.page.evaluate((ids) => {
		const s = window.__tp?.test.v1;
		const items = s.objectMenu.flattenMenuItems(s.objectMenu.buildObjectMenuItems(ids[0], { selection: [ids[0], ids[2]] }));
		return items.map((i) => i.label);
	}, uuids);
	h.check(menu.some((l) => l === 'Drop to ground (2)'), `the object menu offers Drop to ground (2) (${menu.filter((l) => /ground|Align|Distrib/.test(l)).join(' | ')})`);
	h.check(menu.some((l) => /^X min/.test(l)) && menu.some((l) => /^Y centre/.test(l)), 'the object menu offers Align rows per axis');
	const dm = await depth(A.page);
	await A.page.evaluate((ids) => {
		const s = window.__tp?.test.v1;
		const item = s.objectMenu.flattenMenuItems(s.objectMenu.buildObjectMenuItems(ids[0], { selection: [ids[0], ids[2]] })).find((i) => i.label === 'Drop to ground (2)');
		item.action();
	}, uuids);
	await A.page.waitForTimeout(400);
	await onBoth(A, B, uuids, (p) => near(p[0].min[1], 1, 1e-4) && near(p[2].min[1], 0, 1e-4), 'the menu Drop to ground lands both');
	h.check((await depth(A.page)) === dm + 1, `the menu Drop to ground (2) is ONE undo entry (${dm} -> ${await depth(A.page)})`);

	await h.finish(browser);
});
