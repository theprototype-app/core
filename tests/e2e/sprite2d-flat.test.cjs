// 64-2d D6 — THE FLAT 2D VIEW AND ITS TOOLBAR (one page; the touch rows run on a touch context).
//   0 feature unused = zero change: a fresh scene never loads the sprite runtime, shows no 2D toolbar, and the
//     bottom bar keeps its 3D transform cells
//   1 the 2D template opens FLAT: orthographic, straight down -Z, rotation locked; the 2D toolbar replaces the 3D
//     toolbox (move / rotate / scale / pivot step aside); the gizmo loses its z handle; the toolbar lists the tools in
//     the build and no other (pen / shapes / extrude only when their feature's tools2d.js is in the tree)
//   2 Text: a text object lands in the middle of the view, on the gameplay layer; ONE undo removes it
//   3 Layers: the template's layers front to back; a reorder swaps two depths as ONE undo entry (undo, redo);
//     New layer puts a 2D layer in front
//   4 by finger: one finger pans, two fingers pinch-zoom; nothing rotates
//   5 the Preview pill (Cinematic view switch) still answers in the flat view (when this machine offers it)
//   6 Back to 3D: the perspective view, the bar's transform cells and the gizmo's z handle come back
//   7 save and reopen: the sprites, the sheet documents and the layers survive a .tpscene round trip; the file is
//     written to tests/fixtures/sprite2d-64/template2d.tpscene for sprite2d-compat §2
// Run: APP_URL=https://theprototype.app:7222/ npm run e2e -- sprite2d-flat
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures/sprite2d-64');
// which features ship 2D tools in THIS tree (the toolbar must list exactly these, no dead buttons)
const FEATURE_TOOLS = { pen: 'vector', shapes: 'vector', extrude: 'extrude' };
const shipped = (id) => fs.existsSync(path.join(ROOT, 'src/lib', FEATURE_TOOLS[id], 'tools2d.js'));

/** the view, the toolbar and the bar, read in the page */
const state = (page) =>
	page.evaluate(() => {
		const t = window.__tp.test.v1;
		let tc;
		t.TControls?.subscribe?.((v) => (tc = v))?.();
		if (!tc) window.__stores.TControls?.subscribe?.((v) => (tc = v))?.();
		return {
			view: window.__view2dDebug?.() ?? null,
			loaded: t.sprite2dTick.sprite2dRuntimeLoaded(),
			on: (() => {
				let v;
				t.view2d.view2d.subscribe((x) => (v = x))();
				return v.on;
			})(),
			toolbar: !!document.querySelector('#toolbar-2d'),
			tools: [...document.querySelectorAll('#toolbar-2d [id^="tool2d-"]')].map((b) => b.id.replace('tool2d-', '')),
			moveCell: !!document.querySelector('#controls-pill [title="Move (1)"]'),
			rotateCell: !!document.querySelector('#controls-pill [title="Rotate (2)"]'),
			showZ: tc ? tc.showZ : null
		};
	});

/** every object the scene holds: name, kind, world z, sprite / layer blocks */
const scene = (page) =>
	page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const out = [];
		g.traverse((o) => {
			if (o === g) return;
			o.updateWorldMatrix(true, false);
			out.push({
				uuid: o.uuid,
				name: o.name,
				z: +o.matrixWorld.elements[14].toFixed(3),
				x: +o.matrixWorld.elements[12].toFixed(3),
				y: +o.matrixWorld.elements[13].toFixed(3),
				text: !!o.userData?.textPath || o.name === 'Text',
				sprite: o.userData?.sprite ? JSON.stringify(o.userData.sprite) : null,
				layer: o.userData?.layer2d ? JSON.stringify(o.userData.layer2d) : null,
				image: !!o.material?.map?.image
			});
		});
		return out;
	});

const layerRows = (page) =>
	page.evaluate(() => [...document.querySelectorAll('#layers-2d-list [data-layer-uuid]')].map((li) => li.getAttribute('data-layer-uuid')));

const zOf = async (page, uuid) => (await scene(page)).find((o) => o.uuid === uuid)?.z;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { hasTouch: true } });

	// ---- 0 feature unused = zero change ---------------------------------------------------------
	let s = await state(A.page);
	h.check(s.loaded === false, '0.1 a scene with no sprite never loads the sprite runtime');
	h.check(!s.on && !s.toolbar, '0.2 no flat view, no 2D toolbar');
	h.check(s.moveCell, '0.3 the bottom bar shows its 3D transform cells');

	// ---- 1 the 2D template opens flat -----------------------------------------------------------
	await A.page.evaluate(() => import('/src/lib/sprite2d/template2d.js').then((m) => m.open2dTemplate()));
	// two waits, so a red says which half: the view (view2d + the lazy Editor2dView) or the toolbar (its lazy chunk)
	await h.eventually(() => state(A.page), (r) => r.on && !!r.view?.active, '1.0 the template applied and opened the flat view', 90000);
	await h.eventually(() => state(A.page), (r) => r.toolbar && r.tools.length >= 3, '1.0a ...with its 2D toolbar', 90000);
	await h.eventually(() => scene(A.page), (l) => l.some((o) => o.sprite && o.image), '1.0b its sprites loaded their images', 30000);
	s = await state(A.page);
	h.check(s.view?.active && s.view.ortho, '1.1 the view is orthographic (' + JSON.stringify(s.view) + ')');
	h.check(s.view.rotate === false, '1.2 rotation is locked');
	h.check(s.view.pos && Math.abs(s.view.pos[2]) > 1 && s.view.frustum, '1.3 it looks straight down -Z at the plane');
	h.check(s.loaded === true, '1.4 the sprite runtime loaded with the first sprite');
	const want = ['select', 'pen', 'shapes', 'text', 'extrude', 'layers'].filter((id) => !FEATURE_TOOLS[id] || shipped(id));
	h.check(JSON.stringify(s.tools.filter((t) => t !== 'back3d')) === JSON.stringify(want), `1.5 the toolbar lists the tools in this build, in order (${s.tools} vs ${want})`);
	h.check(s.tools.includes('back3d'), '1.6 ...and a Back to 3D toggle');
	h.check(!s.moveCell && !s.rotateCell, '1.7 the bottom bar\'s 3D transform cells stepped aside');
	h.check(s.showZ === false, '1.8 the gizmo lost its z handle (moves stay in the plane)');
	const sel = await A.page.evaluate(() => document.querySelector('#tool2d-select')?.getAttribute('aria-pressed'));
	h.check(sel === 'true', '1.9 Select is the armed tool');

	// ---- 2 Text ---------------------------------------------------------------------------------
	const before = await scene(A.page);
	const gameplay = before.find((o) => o.layer && JSON.parse(o.layer).parallax === undefined) ?? before.find((o) => o.layer && JSON.parse(o.layer).parallax === 1);
	await A.page.click('#tool2d-text');
	await h.eventually(() => scene(A.page), (l) => l.length > before.length, '2.0 Text made an object', 15000);
	let after = await scene(A.page);
	const made = after.find((o) => !before.some((b) => b.uuid === o.uuid));
	const centre = (await state(A.page)).view.pos;
	console.log('  2 made', JSON.stringify(made), 'gameplay', JSON.stringify(gameplay), 'centre', JSON.stringify(centre));
	h.check(!!made && Math.abs(made.x - centre[0]) < 0.05 && Math.abs(made.y - centre[1]) < 0.05, '2.1 ...in the middle of the view');
	h.check(!!made && gameplay && Math.abs(made.z - (gameplay.z + 0.01)) < 0.02, '2.2 ...on the gameplay layer\'s plane');
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => scene(A.page), (l) => !l.some((o) => o.uuid === made?.uuid), '2.3 ONE undo removes it', 8000);

	// ---- 3 Layers -------------------------------------------------------------------------------
	await A.page.click('#tool2d-layers');
	await h.eventually(() => layerRows(A.page), (r) => r.length >= 4, '3.0 the Layers panel lists the template\'s layers', 8000);
	const rows = await layerRows(A.page);
	const zs = [];
	for (const u of rows) zs.push(await zOf(A.page, u));
	h.check(zs.every((z, i) => i === 0 || z <= zs[i - 1]), '3.1 front to back (z ' + JSON.stringify(zs) + ')');
	const [first, second] = rows;
	const [z1, z2] = [await zOf(A.page, first), await zOf(A.page, second)];
	await A.page.click(`#layers-2d-list [data-layer-uuid="${first}"] .layer2d-down`);
	await h.eventually(async () => [await zOf(A.page, first), await zOf(A.page, second)], (p) => p[0] === z2 && p[1] === z1, '3.2 Send back swaps the two depths', 6000);
	h.check(JSON.stringify((await layerRows(A.page)).slice(0, 2)) === JSON.stringify([second, first]), '3.3 ...and the list reorders');
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(async () => [await zOf(A.page, first), await zOf(A.page, second)], (p) => p[0] === z1 && p[1] === z2, '3.4 ONE undo puts both back', 6000);
	await A.page.evaluate(() => window.__tp.test.v1.history.redo());
	await h.eventually(async () => [await zOf(A.page, first), await zOf(A.page, second)], (p) => p[0] === z2 && p[1] === z1, '3.5 redo swaps again', 6000);
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	const nRows = (await layerRows(A.page)).length;
	await A.page.click('#layers-2d-new');
	await h.eventually(() => layerRows(A.page), (r) => r.length === nRows + 1, '3.6 New layer adds a row', 8000);
	const fresh = (await layerRows(A.page))[0];
	const freshObj = (await scene(A.page)).find((o) => o.uuid === fresh);
	h.check(!!freshObj?.layer && freshObj.z > Math.max(...zs), '3.7 ...a 2D layer in front of the rest (' + JSON.stringify(freshObj) + ')');
	await A.page.click('#tool2d-layers');
	await h.eventually(() => A.page.evaluate(() => !document.querySelector('#layers-2d')), (v) => v, '3.8 the Layers button closes the panel', 4000);

	// ---- 4 by finger ----------------------------------------------------------------------------
	const cdp = await A.page.context().newCDPSession(A.page);
	// the element the flat view's controls listen on (the FIRST <canvas> in the document is a hidden 0x0 one)
	const box = await A.page.evaluate(() => {
		let oc;
		window.__tp.test.v1.orbitControls.subscribe((v) => (oc = v))();
		// nothing selected (New layer left its group selected, and a touch on its gizmo moves the group, not the view)
		window.__stores.objectActions?.deselectObject?.();
		const r = oc.domElement.getBoundingClientRect();
		// off-centre: the middle of the view is where a selected object's gizmo would sit
		return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.35 };
	});
	await A.page.waitForTimeout(300);
	const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
	const v0 = (await state(A.page)).view;
	await touch('touchStart', [[box.x, box.y]]);
	for (let i = 1; i <= 8; i++) {
		await touch('touchMove', [[box.x + i * 15, box.y + i * 6]]);
		await A.page.waitForTimeout(30);
	}
	await touch('touchEnd', []);
	await A.page.waitForTimeout(600);
	const v1 = (await state(A.page)).view;
	h.check(Math.abs(v1.pos[0] - v0.pos[0]) > 0.05, `4.1 one finger pans the view (x ${v0.pos[0].toFixed(2)} -> ${v1.pos[0].toFixed(2)})`);
	await touch('touchStart', [
		[box.x - 40, box.y],
		[box.x + 40, box.y]
	]);
	for (let i = 1; i <= 8; i++) {
		await touch('touchMove', [
			[box.x - 40 - i * 12, box.y],
			[box.x + 40 + i * 12, box.y]
		]);
		await A.page.waitForTimeout(30);
	}
	await touch('touchEnd', []);
	await A.page.waitForTimeout(600);
	const v2 = (await state(A.page)).view;
	h.check(v2.zoom > v1.zoom * 1.1, `4.2 two fingers pinch-zoom (zoom ${v1.zoom.toFixed(2)} -> ${v2.zoom.toFixed(2)})`);
	h.check(v2.ortho && v2.rotate === false && Math.abs(v2.pos[2] - v0.pos[2]) < 1e-6, '4.3 nothing rotated or tilted');

	// ---- 5 the Preview pill ---------------------------------------------------------------------
	const pill = await A.page.evaluate(() => !!document.querySelector('#cinematic-toggle'));
	if (pill) {
		await A.page.click('#cinematic-toggle');
		await A.page.waitForTimeout(2500);
		const mode = await A.page.evaluate(() => document.querySelector('#cinematic-switch')?.getAttribute('data-mode'));
		h.check(mode === 'on' || mode === 'entering' || mode === 'fallback', `5.1 the Preview pill answers in the flat view (${mode})`);
		await A.page.click('#cinematic-toggle').catch(() => {});
		await A.page.waitForTimeout(1500);
		h.check((await state(A.page)).view?.active, '5.2 ...and the flat view is still there after it');
	} else console.log('  5 (the Preview pill is not offered on this machine: no row)');

	// ---- 6 Back to 3D ---------------------------------------------------------------------------
	await A.page.click('#tool2d-back3d');
	await h.eventually(() => state(A.page), (r) => !r.on && !r.toolbar, '6.1 Back to 3D: the flat view and its toolbar are gone', 8000);
	s = await state(A.page);
	h.check(s.moveCell && s.rotateCell, '6.2 the bar\'s 3D transform cells are back');
	h.check(s.showZ !== false, '6.3 the gizmo has its z handle again');
	const persp = await A.page.evaluate(() => {
		let c;
		window.__tp.test.v1.globalCamera.subscribe((v) => (c = v))();
		return !!c?.isPerspectiveCamera;
	});
	h.check(persp, '6.4 the editor looks through the perspective camera');

	// ---- 7 save and reopen ----------------------------------------------------------------------
	const saved = await scene(A.page);
	const bytes = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const zip = await s.sessions.exportSessionZip(s.sessions.buildSessionPayload('2D scene'), { assets: true, packs: false, flow: true });
		return Array.from(zip);
	});
	await A.page.evaluate(async (arr) => {
		const s = window.__tp.test.v1.sessions;
		const payload = await s.importSessionZip(new Uint8Array(arr).buffer);
		await s.applySession(payload, { backup: false, quiet: true });
	}, bytes);
	await h.eventually(() => scene(A.page), (l) => l.filter((o) => o.sprite && o.image).length === saved.filter((o) => o.sprite && o.image).length, '7.1 reopened: every sprite and its image', 30000);
	const back = await scene(A.page);
	const key = (l) => JSON.stringify(l.filter((o) => o.sprite || o.layer).map((o) => [o.name, o.sprite, o.layer, o.z]).sort());
	h.check(key(back) === key(saved), '7.2 the sprite and layer documents and depths are as saved');
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ')})`);
	// the fixture is written LAST: a file written into the tree makes the dev server reload open pages
	fs.mkdirSync(FIXTURE_DIR, { recursive: true });
	fs.writeFileSync(path.join(FIXTURE_DIR, 'template2d.tpscene'), Buffer.from(bytes));
	await h.finish(browser);
});
