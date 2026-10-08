// Roadmap 39 P1/P2 — DRAG TO PLACE from the Explorer. Real mouse gestures on a real pack card:
//   · a box ghost with the W × D × H the pack ROW declares (the bundled starter Duck carries dims)
//   · the real model swaps in once the file is decoded and under the budget; a box above it
//   · R / the wheel turn it in 15° steps, Shift is free, the ghost rests ON the surface
//   · Esc cancels, dragging back to the Explorer cancels: no object, no undo entry
//   · releasing over the viewport spawns ONE object (one undo step) exactly at the ghost, as a
//     pack stub in the Placeholder Style, replicated to a second peer (same uuid, same pose)
//   · the card's other HTML5 targets still work (a drop on a Library folder card is a bridge drop)
//
//   APP_URL=https://theprototype.app:5390/ node tests/e2e/place-drag.test.cjs
const h = require('./helpers.cjs');

const fs = require('fs');
const path = require('path');
const STATIC = path.join(__dirname, '../../static/library');

/** THE CDN PATH, served locally: the pack index names one pack (the starter, whose rows carry
 * dims — 39 P4) and every file under PACKS_BASE is answered from static/library, so a placed
 * Duck is a real PACKS_BASE-relative reference exactly as in production, with no network. */
async function routeStarterPack(peer) {
	await peer.ctx.route(/cdn\.jsdelivr\.net\/gh\/theprototype-app\/packs@[^/]+\/(.*)$/, (route) => {
		const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*packs@[^/]+\//, ''));
		if (rel === 'index.json')
			return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ name: 'default', title: 'The Prototype', value: 'default/default.json', attribution: 'default/attribution.html', copyright: '', license: '', source: 'https://github.com/theprototype-app/packs' }]) });
		const file = path.join(STATIC, rel);
		if (!file.startsWith(STATIC) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
		const type = /\.json$/.test(file) ? 'application/json' : /\.glb$/.test(file) ? 'model/gltf-binary' : /\.png$/.test(file) ? 'image/png' : 'text/html';
		return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
	});
	await peer.page.evaluate(() => window.__stores.packs.loadPacks());
}

/** open the Explorer on the starter pack and return the Duck card's centre */
async function openStarterPack(peer) {
	const { page } = peer;
	await page.evaluate(() => {
		window.__stores.explorerClose?.set?.(false);
	});
	if (!(await page.locator('#explorer-window, #explorer-list').count())) await page.locator('#explorer-slot').click();
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('pack:default'));
	const card = page.locator('.explorer-card', { hasText: 'Duck' }).first();
	await card.waitFor({ timeout: 15000 });
	return card;
}

/** the viewport point at a fraction of the canvas, plus the canvas rect */
async function canvasPoint(page, fx = 0.5, fy = 0.6) {
	return page.evaluate(
		({ fx, fy }) => {
			let renderer;
			window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
			const r = renderer.domElement.getBoundingClientRect();
			return { x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) };
		},
		{ fx, fy }
	);
}

/** a free spot on the canvas: elementFromPoint must be the canvas itself (not a window over it) */
async function freeCanvasPoint(page) {
	for (const [fx, fy] of [[0.5, 0.62], [0.42, 0.55], [0.6, 0.5], [0.35, 0.7], [0.65, 0.68], [0.5, 0.4]]) {
		const p = await canvasPoint(page, fx, fy);
		const ok = await page.evaluate(({ x, y }) => {
			let renderer;
			window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
			return document.elementFromPoint(x, y) === renderer.domElement;
		}, p);
		if (ok) return p;
	}
	return canvasPoint(page);
}

const pd = (page) => page.evaluate(() => window.__stores.placeDrag.state());
const last = (page) => page.evaluate(() => window.__stores.placeDrag.last());
const ghost = (page) => page.evaluate(() => window.__stores.placeDrag.ghostInfo());
const counts = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let g, undo;
		s.objectsGroup.subscribe((v) => (g = v))();
		s.history.undoStack.subscribe((v) => (undo = v))();
		return { objects: g.children.length, undo: undo.length, uuids: g.children.map((c) => c.uuid) };
	});

/** press on a card and travel far enough for a real dragstart, then go to (x, y) in steps */
async function pickUp(page, card, to) {
	const box = await card.boundingBox();
	const sx = box.x + box.width / 2;
	const sy = box.y + box.height / 2;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	await page.mouse.move(sx + 12, sy + 6, { steps: 4 });
	await page.mouse.move(sx + 30, sy + 10, { steps: 4 });
	if (to) await page.mouse.move(to.x, to.y, { steps: 12 });
	return { sx, sy };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await routeStarterPack(A);
	await routeStarterPack(B);
	await h.connect(B, A);
	const card = await openStarterPack(A);
	const spot = await freeCanvasPoint(A.page);
	const before = await counts(A.page);

	// ---- 1. the box ghost from the row's dims -----------------------------------------------
	await A.page.evaluate(() => window.__stores.placementPrefs?.placementTriBudget?.set?.(50000));
	await pickUp(A.page, card, spot);
	await A.page.waitForTimeout(300);
	let s = await pd(A.page);
	h.check(!!s, 'a real drag of a pack card starts a place drag (the native dragstart was handed over)');
	h.check(s?.over === 'viewport', 'over the canvas the drag reads "viewport" (got ' + s?.over + ')');
	const dims = s?.items?.[0]?.dims;
	h.check(dims?.source === 'row' && JSON.stringify(dims?.size) === JSON.stringify([1.655, 1.541, 1.152]), 'the Duck ghost is sized from its ROW: [1.655, 1.541, 1.152] m (got ' + JSON.stringify(dims?.size) + ' from ' + dims?.source + ')');
	const chip = await A.page.locator('#place-drag-dims').textContent().catch(() => '');
	h.check(/1\.66 × 1\.15 × 1\.54 m/.test(chip || ''), 'the chip says W × D × H: "' + chip + '"');
	h.check(/4\.2k tris/.test(chip || ''), 'and the triangle count from the row');
	let g = await ghost(A.page);
	h.check(g.visible && g.items.length === 1, 'one ghost is drawn in the viewport');
	const sc = g.items[0]?.boxScale ?? [];
	h.check(Math.abs(sc[0] - 1.655) < 0.01 && Math.abs(sc[1] - 1.541) < 0.01 && Math.abs(sc[2] - 1.152) < 0.01, 'the wire box IS that size (' + sc.map((v) => v.toFixed(3)) + ')');
	// rest on the surface: the box bottom (minY 0.099) touches the ground plane
	const p0 = s.placements[0].position;
	h.check(Math.abs(p0[1] - -0.099) < 0.01, 'the ghost rests ON the ground: origin y = -minY (' + p0[1].toFixed(3) + ')');

	// ---- 2. the real model once decoded and under the budget ----------------------------------
	await h.eventually(() => ghost(A.page), (gi) => gi.items[0]?.tier === 'model', 'hovering the viewport decodes the file and the ghost becomes the real model (4212 tris < 50k)', 15000);
	g = await ghost(A.page);
	h.check(g.items[0]?.meshes > 0, 'the model ghost holds the template meshes (' + g.items[0]?.meshes + ')');

	// ---- 3. rotation ----------------------------------------------------------------------
	await A.page.keyboard.press('r');
	await A.page.keyboard.press('r');
	s = await pd(A.page);
	h.check(s.rotation === 30, 'R twice turns the ghost 30° (got ' + s.rotation + ')');
	await A.page.mouse.wheel(0, 100);
	await A.page.waitForTimeout(100);
	s = await pd(A.page);
	h.check(s.rotation === 45, 'a wheel notch turns it 15° more, and does not zoom the camera (got ' + s.rotation + ')');
	await A.page.keyboard.press('Shift+R');
	s = await pd(A.page);
	h.check(s.rotation === 30, 'Shift+R turns it back (got ' + s.rotation + ')');

	// ---- 4. Esc cancels ---------------------------------------------------------------------
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	s = await pd(A.page);
	h.check(s === null && (await last(A.page)).end === 'escape', 'Esc ends the drag');
	await A.page.mouse.up();
	await A.page.waitForTimeout(600);
	let after = await counts(A.page);
	h.check(after.objects === before.objects && after.undo === before.undo, 'Esc: nothing spawned and no undo entry (' + JSON.stringify(after) + ')');
	h.check(!(await ghost(A.page)).visible && (await ghost(A.page)).items.length === 0, 'and the ghost is gone');

	// ---- 5. back to the Explorer = cancel ---------------------------------------------------
	const { sx, sy } = await pickUp(A.page, card, spot);
	await A.page.waitForTimeout(250);
	h.check((await pd(A.page))?.over === 'viewport', 'premise: the second drag reached the viewport');
	await A.page.mouse.move(sx + 4, sy + 4, { steps: 10 });
	await A.page.waitForTimeout(150);
	h.check((await pd(A.page))?.over === 'explorer', 'back over the Explorer the drag reads "explorer"');
	await A.page.mouse.up();
	await A.page.waitForTimeout(600);
	after = await counts(A.page);
	h.check(after.objects === before.objects && after.undo === before.undo, 'released on the Explorer: nothing spawned, no undo entry');
	h.check((await last(A.page)).end === 'released-elsewhere', 'the drag ended as "released elsewhere"');

	// ---- 6. the drop -----------------------------------------------------------------------
	await pickUp(A.page, card, spot);
	await A.page.waitForTimeout(250);
	await A.page.keyboard.press('r');
	await A.page.waitForTimeout(100);
	const want = (await pd(A.page)).placements[0];
	await A.page.mouse.up();
	await h.eventually(() => counts(A.page), (c) => c.objects === before.objects + 1, 'releasing over the viewport spawns one object');
	after = await counts(A.page);
	h.check(after.undo === before.undo + 1, 'ONE undo step (' + before.undo + ' → ' + after.undo + ')');
	const fresh = after.uuids.find((u) => !before.uuids.includes(u));
	const facts = await A.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		return { pos: o.position.toArray(), quat: o.quaternion.toArray(), ref: o.userData.packRef ?? null, name: o.name };
	}, fresh);
	h.check(facts.pos.every((v, i) => Math.abs(v - want.position[i]) < 1e-4), 'it stands exactly where the ghost stood');
	h.check(facts.quat.every((v, i) => Math.abs(v - want.quaternion[i]) < 1e-4), 'turned the way the ghost was turned');
	h.check(facts.ref?.item === 'Duck' && Array.isArray(facts.ref?.box), 'it is a pack reference carrying the row box (' + JSON.stringify(facts.ref) + ')');
	await h.eventually(
		() => A.page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', uuid);
			return o ? o.children.length : -1;
		}, fresh),
		(n) => n > 0,
		'the stub fills with the model (the prefetched template)'
	);
	// ---- 7. replicated to the second peer -------------------------------------------------
	const onB = (uuid) =>
		B.page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', uuid);
			return o ? { pos: o.position.toArray(), quat: o.quaternion.toArray(), kids: o.children.length, ref: o.userData.packRef ?? null } : null;
		}, uuid);
	const b = await h.eventually(() => onB(fresh), (o) => !!o, 'peer B receives the placed object under the SAME uuid', 15000);
	const bo = await onB(fresh);
	h.check(!!bo && bo.pos.every((v, i) => Math.abs(v - want.position[i]) < 1e-3) && bo.quat.every((v, i) => Math.abs(v - want.quaternion[i]) < 1e-3), 'at the same pose on B');
	h.check(bo?.ref?.item === 'Duck', 'B holds it as the same pack reference (it travelled as a stub)');
	await h.eventually(() => onB(fresh), (o) => (o?.kids ?? 0) > 0, 'and B refills it from the pack itself', 15000);

	await A.page.keyboard.press('Control+z');
	await A.page.waitForTimeout(600);
	after = await counts(A.page);
	h.check(after.objects === before.objects, 'one Ctrl+Z removes the placed object');
	await h.eventually(() => onB(fresh), (o) => o === null, 'and the undo reaches B', 10000);

	// ---- 8. a release over app chrome places nothing (the bridge drop is not a viewport drop) ----
	const chrome = await A.page.evaluate(() => {
		for (const sel of ['#connect-pill', '.connect-wrap', '#editor-chrome button', '.top-right-chrome button']) {
			const el = document.querySelector(sel);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 4) continue;
			const x = Math.round(r.left + r.width / 2);
			const y = Math.round(r.top + r.height / 2);
			const hit = document.elementFromPoint(x, y);
			let renderer;
			window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
			if (hit && hit !== renderer.domElement && !hit.closest('#explorer-window, #explorer-list')) return { x, y, sel };
		}
		return null;
	});
	h.check(!!chrome, 'premise: found a piece of app chrome over the viewport (' + chrome?.sel + ')');
	if (chrome) {
		const c0 = await counts(A.page);
		await pickUp(A.page, card, spot);
		await A.page.waitForTimeout(200);
		await A.page.mouse.move(chrome.x, chrome.y, { steps: 8 });
		await A.page.waitForTimeout(150);
		h.check((await pd(A.page))?.over === 'other', 'over the chrome the drag reads "other"');
		await A.page.mouse.up();
		await A.page.waitForTimeout(1500);
		const c1 = await counts(A.page);
		h.check(c1.objects === c0.objects && c1.undo === c0.undo, 'released over app chrome: nothing placed, no undo entry (' + c0.objects + ' → ' + c1.objects + ')');
	}

	// ---- 9. a LIBRARY model: its ghost uses the size recorded at import, and the card's other
	//         HTML5 targets still work through the bridge (dropped on a folder card = moved) -----
	const lib = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(2, 1, 0.5), new s.THREE.MeshStandardMaterial());
		mesh.position.y = 0.5;
		const glb = await new Promise((res, rej) => new s.GLTFExporterModule.GLTFExporter().parse(mesh, res, rej, { binary: true }));
		const item = await s.explorer.addItemFromBytes(glb, 'crate-39.glb', null);
		const folder = s.explorer.createFolder('Target 39');
		s.explorer.activeFolder.set(null);
		return { id: item.id, dims: item.dims ?? null, folder: folder.id };
	});
	h.check(JSON.stringify(lib.dims?.size) === JSON.stringify([2, 1, 0.5]) && lib.dims?.tris === 12, 'a library model records its size at import (' + JSON.stringify(lib.dims) + ')');
	const libCard = A.page.locator('.explorer-card', { hasText: 'crate-39' }).first();
	await libCard.waitFor({ timeout: 10000 });
	await pickUp(A.page, libCard, spot);
	await A.page.waitForTimeout(300);
	s = await pd(A.page);
	h.check(JSON.stringify(s?.items?.[0]?.dims?.size) === JSON.stringify([2, 1, 0.5]), 'its ghost is that size before any decode');
	const folderCard = A.page.locator('.explorer-folder-card', { hasText: 'Target 39' }).first();
	const fb = await folderCard.boundingBox();
	await A.page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 10 });
	await A.page.waitForTimeout(200);
	await A.page.mouse.up();
	await h.eventually(
		() => A.page.evaluate((id) => { let it; window.__stores.explorer.explorerItems.subscribe((v) => (it = v))(); return it.find((i) => i.id === id)?.folderId ?? null; }, lib.id),
		(f) => f === lib.folder,
		'dropped on a Library folder card it MOVES there (the HTML5 bridge kept the Explorer target)'
	);

	await h.finish(browser);
});
