// 105 T1: textures from the Explorer. One picker (thumbnails, search, folders, recent) behind "From Explorer"
// on every map slot; an Explorer image dropped on a map slot, on the UV editor's canvas (the active slot's colour
// map, asking before it replaces painted pixels) and on an object in the viewport (the slot under the pointer,
// one undo). The choice is stored the way an upload is, so a peer — and a late joiner after a reload — sees an
// ordinary texture. Touch: the Explorer's long-press drag reaches the same targets.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const OUT = process.env.EVIDENCE_DIR || path.join('test-results', '105-textures');

/** seed the Explorer with two flat-colour PNGs; resolves {red, blue} records */
const seed = (page) =>
	page.evaluate(async () => {
		const make = async (name, colour) => {
			const c = document.createElement('canvas');
			c.width = c.height = 32;
			const g = c.getContext('2d');
			g.fillStyle = colour;
			g.fillRect(0, 0, 32, 32);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			return new File([blob], name, { type: 'image/png' });
		};
		const ex = window.__tp.test.v1.explorer;
		const folder = ex.createFolder('Paints 105');
		const red = (await ex.importFiles([await make('red-105.png', '#ff0000')], null))[0];
		const blue = (await ex.importFiles([await make('blue-105.png', '#0000ff')], folder?.id ?? null))[0];
		return { red: { id: red.id, hash: red.hash }, blue: { id: blue.id, hash: blue.hash }, folder: folder?.id ?? null };
	});

const createBox = (page) =>
	page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(group.children.map((c) => c.uuid));
		w.commandsHandler.sceneCommand('/create box');
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const made = group.children.find((c) => !before.has(c.uuid) && c.isMesh);
			if (made) return made.uuid;
		}
		return '';
	});

/** per slot: does it carry a colour map, what source, and which of the PBR maps */
const mats = (page, uuid) =>
	page.evaluate((id) => {
		let group = null;
		window.__tp.test.v1.objectsGroup.subscribe((g) => (group = g))();
		const o = group?.getObjectByProperty('uuid', id);
		if (!o) return null;
		const list = Array.isArray(o.material) ? o.material : [o.material];
		return list.map((m) => ({
			map: !!m.userData?.mapDataUrl,
			url: (m.userData?.mapDataUrl ?? '').slice(0, 60) + ':' + (m.userData?.mapDataUrl ?? '').length,
			source: m.userData?.mapSource ?? null,
			normal: !!m.normalMap,
			rough: !!m.roughnessMap
		}));
	}, uuid);

const undoDepth = (page) =>
	page.evaluate(() => {
		let depth = 0;
		window.__tp.test.v1.history.undoStack.subscribe((s) => (depth = s.length))();
		return depth;
	});

const select = async (page, uuid) => {
	await page.evaluate((id) => {
		window.__tp.test.v1.inspectorClose.set(false);
		window.__tp.test.v1.objectActions.selectObject(id);
	}, uuid);
	await page.waitForSelector('#material-maps', { timeout: 30000, state: 'attached' });
};

/** a desktop HTML5 drop of an Explorer card on `selector` (the same DataTransfer the Explorer card writes) */
const htmlDrop = (page, selector, payload) =>
	page.evaluate(
		({ selector, payload }) => {
			const el = document.querySelector(selector);
			if (!el) return false;
			const dt = new DataTransfer();
			dt.setData('application/x-explorer-item', JSON.stringify(payload));
			const r = el.getBoundingClientRect();
			const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
			const over = new DragEvent('dragover', at);
			el.dispatchEvent(over);
			el.dispatchEvent(new DragEvent('drop', at));
			return over.defaultPrevented; // the target said it takes it
		},
		{ selector, payload }
	);

/** the confirm dialog, if one is up */
const confirmUp = (page) => page.evaluate(() => { let v = null; window.__tp.test.v1.confirmDialog.confirmDialog.subscribe((d) => (v = d))(); return v ? { title: v.title } : null; });

/** messages A sends, recorded from here on */
const spySends = (page) =>
	page.evaluate(() => {
		let peer = null;
		window.__tp.test.v1.peers.subscribe((p) => (peer = p))();
		window.__sent105 = [];
		if (peer.__spy105) return;
		peer.__spy105 = true;
		const send = peer.send.bind(peer);
		peer.send = (msg, ...rest) => {
			try {
				if (msg && typeof msg === 'object') window.__sent105.push(msg);
			} catch {}
			return send(msg, ...rest);
		};
	});
const mapMessages = (page) =>
	page.evaluate(() =>
		(window.__sent105 ?? [])
			.flatMap((m) => (m.type === 'batch' && Array.isArray(m.items) ? m.items : [m]))
			.filter((m) => m.type === 'objectParameters' && (m.parameter === 'map' || m.parameter === 'mapSlot'))
			.map((m) => ({ keys: Object.keys(m).sort().join(','), parameter: m.parameter, slot: m.slot ?? 0, key: m.key ?? null, isData: /^data:image\//.test(m.map ?? '') }))
	);

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const page = A.page;
	await h.connect(B, A);

	const lib = await seed(page);
	h.check(!!lib.red.id && !!lib.blue.id, '0.1 premise: two images in the Explorer');
	const box = await createBox(page);
	h.check(!!box, '0.2 premise: a box');
	await h.eventually(() => mats(B.page, box), (m) => !!m, '0.3 premise: B has the box', 30000);
	await select(page, box);
	await spySends(page);

	console.log('\n=== 1. the picker: thumbnails, search, folders, pick ===');
	h.check((await page.locator('#texture-explorer').count()) === 1, '1.1 the colour map has From Explorer');
	for (const key of ['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'])
		h.check((await page.locator('#map-explorer-' + key).count()) === 1, '1.2 ' + key + ' has From Explorer');
	await page.click('#texture-explorer');
	await page.waitForSelector('#explorer-picker [data-pick-id]', { timeout: 15000 });
	const cards = await page.locator('#explorer-picker-grid [data-pick-id]').count();
	h.check(cards >= 2, '1.3 the picker lists the images (' + cards + ')');
	h.check((await page.locator(`#explorer-picker-grid [data-pick-id="${lib.red.id}"] img`).count()) === 1, '1.4 ...as thumbnails');
	await page.fill('#explorer-picker-search', 'blue');
	await h.eventually(() => page.locator('#explorer-picker-grid [data-pick-id]').count(), (n) => n === 1, '1.5 search narrows to one', 5000);
	await page.fill('#explorer-picker-search', '');
	await page.screenshot({ path: path.join(OUT, '01-picker.png') });
	const depth0 = await undoDepth(page);
	await page.click(`#explorer-picker-grid [data-pick-id="${lib.red.id}"]`);
	await h.eventually(() => mats(page, box), (m) => m?.[0]?.map && m[0].source === lib.red.hash, '1.6 A: the colour map is the red image, linked to its file', 15000);
	h.check((await page.locator('#explorer-picker').count()) === 0, '1.7 the picker closed');
	h.check((await undoDepth(page)) === depth0 + 1, '1.8 one undo step');
	await h.eventually(() => mats(B.page, box), (m) => m?.[0]?.map && m[0].source === lib.red.hash, '1.9 B: the same texture arrived', 20000);
	const aUrl = (await mats(page, box))[0].url;
	h.check((await mats(B.page, box))[0].url === aUrl, '1.10 B holds the same pixels');

	console.log('\n=== 2. recent, folders, cancel ===');
	const pending = page.evaluate(() => window.__tp.test.v1.explorerPick.pickFromExplorer({}).then((it) => (window.__pick105 = it ?? 'none')));
	await page.waitForSelector('#explorer-picker-recent', { timeout: 15000 });
	h.check((await page.locator(`#explorer-picker-recent [data-pick-id="${lib.red.id}"]`).count()) === 1, '2.1 the last pick is under Recent');
	await page.click('#explorer-picker-folder');
	await page.locator('[role="option"]', { hasText: 'Paints 105' }).first().click();
	await h.eventually(
		() => page.evaluate(() => [...document.querySelectorAll('#explorer-picker-grid [data-pick-id]')].map((e) => e.getAttribute('data-pick-id'))),
		(ids) => ids.length === 1 && ids[0] === lib.blue.id,
		'2.2 a folder shows only what is in it',
		5000
	);
	h.check((await page.locator('#explorer-picker-recent').count()) === 0, '2.3 Recent stands down inside a folder');
	await page.keyboard.press('Escape');
	await pending;
	h.check((await page.evaluate(() => window.__pick105)) === 'none', '2.4 Esc closes the picker with nothing picked');
	h.check((await page.locator('#explorer-picker').count()) === 0, '2.5 ...and it is gone');

	console.log('\n=== 3. a map slot from the picker, and by a desktop drop ===');
	await page.click('#map-explorer-roughnessMap');
	await page.waitForSelector(`#explorer-picker-grid [data-pick-id="${lib.blue.id}"]`, { timeout: 15000 });
	await page.click(`#explorer-picker-grid [data-pick-id="${lib.blue.id}"]`);
	await h.eventually(() => mats(page, box), (m) => m?.[0]?.rough, '3.1 A: roughness map from the picker', 15000);
	await h.eventually(() => mats(B.page, box), (m) => m?.[0]?.rough, '3.2 B: roughness map arrived', 20000);
	const took = await htmlDrop(page, '#map-slot-normalMap', { id: lib.blue.id, kind: 'image', name: 'blue-105.png' });
	h.check(took, '3.3 the normal row takes an Explorer card');
	await h.eventually(() => mats(page, box), (m) => m?.[0]?.normal, '3.4 A: normal map from the drop', 15000);
	await h.eventually(() => mats(B.page, box), (m) => m?.[0]?.normal, '3.5 B: normal map arrived', 20000);

	console.log('\n=== 4. same messages as an upload (nothing new on the wire) ===');
	const sent = await mapMessages(page);
	const colour = sent.filter((m) => m.parameter === 'map');
	const slots = sent.filter((m) => m.parameter === 'mapSlot');
	h.check(colour.length >= 1 && colour.every((m) => m.keys === 'map,parameter,source,type,uuid' && m.isData), '4.1 colour map = the upload message + its 40-image source: ' + JSON.stringify(colour));
	h.check(slots.length >= 2 && slots.every((m) => m.keys === 'key,map,parameter,type,uuid' && m.isData), '4.2 map slots = the upload message exactly: ' + JSON.stringify(slots));

	console.log('\n=== 5. touch: the Explorer long-press drag drops on a map slot ===');
	await page.evaluate(() => window.__tp.test.v1.explorerClose.set(false));
	await page.waitForSelector('.explorer-card[title="red-105.png"]', { timeout: 20000 });
	const touchOk = await page.evaluate(async () => {
		const card = document.querySelector('.explorer-card[title="red-105.png"]');
		const row = document.getElementById('map-slot-emissiveMap');
		if (!card || !row) return 'missing';
		row.scrollIntoView({ block: 'center' });
		await new Promise((r) => setTimeout(r, 200));
		const c = card.getBoundingClientRect();
		const t = row.getBoundingClientRect();
		const tx = t.left + t.width / 2;
		const ty = t.top + t.height / 2;
		if (!row.contains(document.elementFromPoint(tx, ty))) return 'covered';
		const ev = (type, x, y, el) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 77, isPrimary: true, clientX: x, clientY: y }));
		const cx = c.left + c.width / 2;
		const cy = c.top + c.height / 2;
		ev('pointerdown', cx, cy, card);
		await new Promise((r) => setTimeout(r, 650)); // the hold
		ev('pointermove', cx + 20, cy + 20, card); // ...that moves: the pick-up
		ev('pointermove', tx, ty, card);
		const armed = row.classList.contains('ins-drop-on');
		ev('pointerup', tx, ty, card);
		return armed ? 'ok' : 'not-armed';
	});
	h.check(touchOk === 'ok', '5.1 the row lights up under the finger (' + touchOk + ')');
	await h.eventually(() => page.evaluate((id) => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); return !!g.getObjectByProperty('uuid', id)?.material?.emissiveMap; }, box), (v) => v, '5.2 the touch drop set the emission map', 15000);
	await page.evaluate(() => window.__tp.test.v1.explorerClose.set(true));

	console.log('\n=== 6. the UV editor canvas: the active slot, and the painted-pixels ask ===');
	// a colour map from DISK carries no Explorer link — the pixels a drop would lose
	await page.setInputFiles('#texture-file', { name: 'disk.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
	await h.eventually(() => mats(page, box), (m) => m?.[0]?.map && !m[0].source, '6.0 premise: a colour map with no Explorer link', 15000);
	const diskUrl = (await mats(page, box))[0].url;
	await page.evaluate(() => {
		const w = window.__tp.test.v1;
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
	});
	await page.waitForSelector('#uv-canvas', { timeout: 20000 });
	const drop1 = await htmlDrop(page, '#uv-canvas-wrap', { id: lib.blue.id, kind: 'image', name: 'blue-105.png' });
	h.check(drop1, '6.1 the canvas takes an Explorer card');
	await h.eventually(() => confirmUp(page), (c) => !!c, '6.2 it asks before replacing the painted image', 5000);
	await page.screenshot({ path: path.join(OUT, '02-uv-ask.png') });
	await page.click('#confirm-dialog-cancel');
	await page.waitForTimeout(800);
	h.check((await mats(page, box))[0].url === diskUrl, '6.3 Cancel keeps the pixels');
	await htmlDrop(page, '#uv-canvas-wrap', { id: lib.blue.id, kind: 'image', name: 'blue-105.png' });
	await h.eventually(() => confirmUp(page), (c) => !!c, '6.4 asked again', 5000);
	await page.click('#confirm-dialog-ok');
	await h.eventually(() => mats(page, box), (m) => m?.[0]?.source === lib.blue.hash, '6.5 Replace: the blue image is the colour map', 15000);
	await h.eventually(() => mats(B.page, box), (m) => m?.[0]?.source === lib.blue.hash, '6.6 B: the same', 20000);
	await htmlDrop(page, '#uv-canvas-wrap', { id: lib.red.id, kind: 'image', name: 'red-105.png' });
	await h.eventually(() => mats(page, box), (m) => m?.[0]?.source === lib.red.hash, '6.7 a texture that IS a library file is replaced without asking', 15000);
	h.check(!(await confirmUp(page)), '6.8 ...no question');
	await page.evaluate(() => window.__tp.test.v1.uvEditorClose.set(true));

	console.log('\n=== 7. the viewport: the slot under the pointer, one undo ===');
	const multi = await createBox(page);
	const prep = await page.evaluate(async (id) => {
		const w = window.__tp.test.v1;
		const slot = w.materialsHandler.addMaterialSlot(id);
		// BoxGeometry face order px nx py ny pz nz: triangles 4,5 are the TOP
		const ok = await w.uvEditor.assignTrisToSlot(id, [4, 5], slot);
		let g;
		w.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', id);
		o.position.set(0, 0.5, 0);
		o.updateMatrixWorld(true);
		w.objectActions.selectObject(null);
		return { slot, ok };
	}, multi);
	h.check(prep.slot === 1 && prep.ok !== false, '7.0 premise: a box whose top is slot 1 (' + JSON.stringify(prep) + ')');
	await h.eventually(() => mats(B.page, multi), (m) => m?.length === 2, '7.0b premise: B has both slots', 20000);
	await page.waitForTimeout(500);
	const top = await h.projectPoint(page, [0, 1, 0]);
	const aim = await page.evaluate(({ x, y }) => { const t = window.__tp.test.v1.explorerDrop.dropTarget(x, y); return { slot: t.slot, uuid: t.hit?.uuid }; }, top);
	h.check(aim.uuid === multi && aim.slot === 1, '7.1 premise: the pointer is on the top face, slot 1 (' + JSON.stringify(aim) + ')');
	const depth7 = await undoDepth(page);
	await page.evaluate(({ x, y, id }) => window.__tp.test.v1.explorerDrop.dropExplorerItem({ id, kind: 'image', name: 'red-105.png' }, x, y), { ...top, id: lib.red.id });
	await h.eventually(() => mats(page, multi), (m) => m?.[1]?.map && !m[0].map, '7.2 A: slot 1 took the image, slot 0 did not', 15000);
	h.check((await undoDepth(page)) === depth7 + 1, '7.3 one undo step');
	await h.eventually(() => mats(B.page, multi), (m) => m?.[1]?.map && !m[0].map, '7.4 B: slot 1 only', 20000);
	await page.screenshot({ path: path.join(OUT, '03-viewport-slot.png') });
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => mats(page, multi), (m) => m && !m[1].map && !m[0].map, '7.5 undo takes it off', 15000);
	await h.eventually(() => mats(B.page, multi), (m) => m && !m[1].map, '7.6 ...for B too', 20000);
	await page.evaluate(() => window.__tp.test.v1.history.redo());
	await h.eventually(() => mats(page, multi), (m) => m?.[1]?.map, '7.7 redo puts it back', 15000);

	console.log('\n=== 8. reload: A restores its save, B rejoins as a late joiner ===');
	await page.evaluate(async () => window.__tp.test.v1.autosave.saveNow());
	await page.waitForTimeout(800);
	const before = { box: await mats(page, box), multi: await mats(page, multi) };
	await h.freshReload(B);
	await h.answerRestore(B);
	await h.connect(B, A);
	await h.eventually(() => mats(B.page, multi), (m) => m?.[1]?.map, '8.1 B after a reload: slot 1 textured again', 40000);
	const bBox = await mats(B.page, box);
	h.check(bBox?.[0]?.map && bBox[0].normal && bBox[0].rough, '8.2 B after a reload: the box keeps colour, normal and roughness maps ' + JSON.stringify(bBox));
	await h.freshReload(A);
	await page.waitForTimeout(2500);
	await page.evaluate(async () => window.__tp.test.v1.autosave.restoreSnapshot());
	await h.eventually(() => mats(page, multi), (m) => m?.[1]?.map && !m[0].map, '8.3 A after a reload: the slot texture is back from the save', 30000);
	const aBox = await mats(page, box);
	h.check(aBox?.[0]?.map && aBox[0].source === before.box[0].source && aBox[0].normal && aBox[0].rough, '8.4 A after a reload: every map and the colour map link are back');

	h.check((await h.pageErrors(A)).length === 0, '9.1 no page errors on A');
	h.check((await h.pageErrors(B)).length === 0, '9.2 no page errors on B');
	await h.finish(browser);
});
