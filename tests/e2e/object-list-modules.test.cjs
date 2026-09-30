// 30 P3 — EVERY MODULE'S CONTENT IS LISTED. The object list's "Module content" section.
//
// Measured before this (roadmap 30, "Selection and the object list", cause 3): scene-root
// module content — the untangle board, the dungeon, the piano, the sabers — lives
// outside objectsGroup by golden rule 5, so it was never picked and never LISTED (only
// the advanced System filter polled it). Now every group a module registers gets one
// READ-ONLY row: the module's name as a badge, expandable to its named children, a click
// that selects a PROXY and frames it, and an Inspector card saying whose it is.
//
// The proxy is the thing to distrust, so it is checked from every side: it never enters
// objectsGroup, never reaches a peer, never appears in a saved payload, and a deselect
// removes it. Skip-never-fail when the untangle scene or zip cannot be reached (the
// game-untangle sources: UNTANGLE_TPSCENE / UNTANGLE_ZIP / the feed / a sibling checkout).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_BASE = (process.env.UNTANGLE_SCENES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@format-2').replace(/\/$/, '');
const MODULES_BASE = (process.env.UNTANGLE_MODULES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/modules@main').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_LEVEL = 2;

async function fetchBytes(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
		if (!res.ok) {
			console.log('  (source) ' + url + ' -> HTTP ' + res.status);
			return null;
		}
		return Buffer.from(await res.arrayBuffer());
	} catch (error) {
		console.log('  (source) ' + url + ' -> ' + error.message);
		return null;
	}
}
async function sceneBytes() {
	if (process.env.UNTANGLE_TPSCENE) {
		const p = process.env.UNTANGLE_TPSCENE;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const feed = await fetchBytes(SCENES_BASE + '/games/untangle/scene.tpscene');
	if (feed) return { bytes: feed, from: SCENES_BASE };
	for (const dir of ['theprototype.app-scenes', 'scenes']) {
		const p = path.join(ROOT, dir, 'games/untangle/scene.tpscene');
		if (fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	}
	return null;
}
async function zipBytes() {
	if (process.env.UNTANGLE_ZIP) {
		const p = process.env.UNTANGLE_ZIP;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const local = [];
	if (process.env.MODULES_REPO) local.push(path.join(process.env.MODULES_REPO, 'untangle.zip'));
	local.push(h.moduleZipPath('untangle'));
	for (const dir of fs.readdirSync(ROOT)) if (/^(theprototype\.app-)?modules/.test(dir)) local.push(path.join(ROOT, dir, 'untangle.zip'));
	for (const p of local) if (p && fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	const cdn = await fetchBytes(MODULES_BASE + '/untangle.zip');
	return cdn ? { bytes: cdn, from: MODULES_BASE } : null;
}
async function installZip(peer, bytes, label) {
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await peer.page.waitForTimeout(400);
	await peer.page.getByRole('tab', { name: /^User/ }).click();
	await peer.page.waitForTimeout(200);
	await peer.page.locator('#install-module-zip').setInputFiles({ name: 'untangle.zip', mimeType: 'application/zip', buffer: bytes });
	await h.eventually(
		() => peer.page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		(ids) => ids.includes('untangle'),
		label + ': the untangle module installed from the real zip',
		20000
	);
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await peer.page.waitForTimeout(300);
}


const GROUP = 'untangle-module';
const objectCount = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let n = 0;
		g.traverse(() => n++);
		return n;
	});
const debug = (page) => page.evaluate(() => window.__stores.moduleSDK.moduleContentDebug());

h.run(async () => {
	const scene = await sceneBytes();
	if (!scene) {
		console.log('SKIP: games/untangle/scene.tpscene unreachable');
		return;
	}
	const zip = await zipBytes();
	if (!zip) {
		console.log('SKIP: untangle.zip unreachable');
		return;
	}
	console.log('  scene from ' + scene.from + ' / module from ' + zip.from);
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const page = A.page;
	await installZip(A, zip.bytes, 'A');
	await installZip(B, zip.bytes, 'B');
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		await s.sessions.applySession(await s.sessions.readSessionZip(new Uint8Array(arr).buffer), { backup: false });
	}, Array.from(scene.bytes));
	await h.eventually(
		() => page.evaluate((g) => {
			let sc;
			window.__stores.globalScene.subscribe((v) => (sc = v))();
			return sc?.getObjectByName(g)?.children.filter((c) => c.name.startsWith('untangle-dot-')).length ?? 0;
		}, GROUP),
		(n) => n > 0,
		'(premise) the untangle board is built at the scene root'
	);
	await h.connect(A, B);
	await page.waitForTimeout(1500);

	// ---------------------------------------------------------------- 1
	console.log('\n=== 1. the section lists the board, read-only ===');
	await page.evaluate(() => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(1500);
	const row = page.locator(`#module-content .module-content-row[data-group="${GROUP}"]`);
	h.check((await row.count()) === 1, '1.1 the object list has a Module content row for the untangle board');
	const label = ((await row.locator('.module-content-name').textContent()) ?? '').trim();
	h.check(/untangle/i.test(label), `1.2 ...labelled for a person (${label})`);
	const badge = ((await row.locator('.module-content-badge').textContent()) ?? '').trim();
	h.check(/untangle/i.test(badge), `1.3 ...with the module's name as its badge (${badge})`);
	await row.locator('button[aria-label="Show children"]').click();
	await page.waitForTimeout(300);
	const kids = await row.locator('.module-content-child').allTextContents();
	h.check(kids.some((t) => t.trim().startsWith('untangle-dot-')), `1.4 expanding it lists the dots (${kids.length} named parts)`);
	// the tree above is untouched: the board is NOT a scene row
	const sceneRows = await page.evaluate((g) => [...document.querySelectorAll('#object-tree [role="treeitem"]')].some((el) => el.textContent.includes(g)), GROUP);
	h.check(!sceneRows, '1.5 the board is not smuggled into the scene tree');
	await row.click({ button: 'right' });
	await page.waitForTimeout(300);
	const menu = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
	h.check(menu.includes('Frame it') && !menu.some((t) => /delete|rename|duplicate/i.test(t)), `1.6 its menu is read-only (${menu.join(' | ')})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);

	// ---------------------------------------------------------------- 2
	console.log('\n=== 2. a click selects a PROXY and frames it ===');
	const countsA = await objectCount(page);
	const countsB = await objectCount(B.page);
	const camBefore = await page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		return c.position.toArray();
	});
	await row.locator('.module-content-name').click();
	await page.waitForTimeout(900);
	const d = await debug(page);
	h.check(d.selection?.name === GROUP, `2.1 the proxy selection names the board (${d.selection?.name})`);
	h.check(d.proxyInScene, '2.2 the proxy box is in the scene');
	const inside = await page.evaluate((g) => {
		const s = window.__stores;
		let sc;
		s.globalScene.subscribe((v) => (sc = v))();
		const box = new s.THREE.Box3().setFromObject(sc.getObjectByName(g));
		const proxy = sc.getObjectByName('module-content-proxy');
		return !!proxy && proxy.parent === sc && proxy.box.containsBox(box.expandByScalar(-1e-4));
	}, GROUP);
	h.check(inside, '2.3 ...at the SCENE ROOT, sized to the board\'s bounds');
	const camAfter = await page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		return c.position.toArray();
	});
	h.check(Math.hypot(...camAfter.map((v, i) => v - camBefore[i])) > 0.2, '2.4 the camera framed it');
	const card = ((await page.locator('#module-content-card').textContent().catch(() => '')) ?? '').trim();
	h.check(/untangle/i.test(card) && /module/i.test(card), `2.5 the Inspector shows whose it is (${card.slice(0, 80)})`);
	const sel = await page.evaluate(() => {
		let v;
		window.__stores.selectedObjects.subscribe((x) => (v = x))();
		return v.length;
	});
	h.check(sel === 0, '2.6 the object SELECTION stays empty (the proxy never joins the set)');

	// ---------------------------------------------------------------- 3
	console.log('\n=== 3. the proxy never replicates and never saves ===');
	h.check((await objectCount(page)) === countsA, `3.1 objectsGroup unchanged on A (${countsA})`);
	await page.waitForTimeout(1200);
	h.check((await objectCount(B.page)) === countsB, `3.2 ...and on the peer (${countsB})`);
	const saved = await page.evaluate(() => JSON.stringify(window.__stores.sessions.buildSessionPayload('probe')));
	h.check(!saved.includes('module-content-proxy'), '3.3 a saved payload does not contain the proxy');
	const onB = await B.page.evaluate(() => {
		let sc;
		window.__stores.globalScene.subscribe((v) => (sc = v))();
		return !!sc.getObjectByName('module-content-proxy');
	});
	h.check(!onB, '3.4 the peer has no proxy');

	// ---------------------------------------------------------------- 4
	console.log('\n=== 4. a deselect puts it away ===');
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(300);
	const gone = await debug(page);
	h.check(!gone.proxyInScene && !gone.selection, '4.1 deselect clears the proxy and the selection');

	// ---------------------------------------------------------------- 5
	console.log('\n=== 5. in the VIEWPORT: an Edit click on the board selects its proxy; Interact plays ===');
	await page.evaluate(() => window.__stores.inspectorClose.set(true));
	// 30 integrate: flyTo(..., 0) is a jump — even on a frame whose rAF timestamp precedes the
	// call (the race that parked the camera at -Infinity/NaN for a frame, mod-audit's finding)
	const jump = await page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = window.__stores;
				let cam;
				s.globalCamera.subscribe((v) => (cam = v))();
				const raf = window.requestAnimationFrame;
				window.requestAnimationFrame = (cb) => {
					window.requestAnimationFrame = raf;
					return raf(() => {
						cb(performance.now() - 20);
						resolve(cam.position.toArray());
					});
				};
				s.objectActions.flyTo([1, 2.5, 6], [0, 1, 0], 0);
			})
	);
	h.check(jump.every(Number.isFinite) && Math.hypot(jump[0] - 1, jump[1] - 2.5, jump[2] - 6) < 0.05, `5.0 flyTo(…, 0) lands in one frame, finite (${jump.map((v) => +v.toFixed(3))})`);
	await page.evaluate((g) => {
		const s = window.__stores;
		let sc;
		s.globalScene.subscribe((v) => (sc = v))();
		const box = new s.THREE.Box3().setFromObject(sc.getObjectByName(g));
		const c = box.getCenter(new s.THREE.Vector3());
		s.objectActions.flyTo([c.x, c.y + 0.4, c.z + 3.2], c.toArray(), 0);
	}, GROUP);
	await page.waitForTimeout(900);
	const dot = await page.evaluate((g) => {
		const s = window.__stores;
		let sc, camera, renderer;
		s.globalScene.subscribe((v) => (sc = v))();
		s.globalCamera.subscribe((v) => (camera = v))();
		s.globalRenderer.subscribe((v) => (renderer = v))();
		const root = sc.getObjectByName(g);
		const target = root.children.find((c) => c.name.startsWith('untangle-dot-'));
		const p = target.getWorldPosition(new s.THREE.Vector3());
		const v = p.clone().project(camera);
		const rect = renderer.domElement.getBoundingClientRect();
		const x = rect.left + ((v.x + 1) / 2) * rect.width;
		const y = rect.top + ((1 - v.y) / 2) * rect.height;
		const ray = new s.THREE.Raycaster();
		ray.setFromCamera(new s.THREE.Vector2(v.x, v.y), camera);
		const hit = ray.intersectObject(root, true)[0];
		let n = hit?.object;
		while (n && n.parent !== root) n = n.parent;
		return { x, y, hitsBoard: !!hit, name: n?.name ?? null, onCanvas: document.elementFromPoint(x, y) === renderer.domElement };
	}, GROUP);
	h.check(dot.hitsBoard && dot.onCanvas, `5.1 (premise) the pixel lands on the board (${dot.name})`);
	await page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.objectActions.setEditorMode('edit');
	});
	await page.waitForTimeout(1700);
	await page.mouse.click(dot.x, dot.y);
	await page.waitForTimeout(500);
	const edit = await debug(page);
	h.check(edit.selection?.name === GROUP, `5.2 an EDIT click on the board selects its proxy (${edit.selection?.name ?? 'nothing'})`);
	await page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.objectActions.setEditorMode('interact');
	});
	await page.waitForTimeout(1700);
	await page.mouse.click(dot.x, dot.y);
	await page.waitForTimeout(500);
	const inter = await debug(page);
	h.check(!inter.selection, '5.3 in INTERACT the same click selects nothing (it belongs to the module)');
	await page.mouse.click(dot.x + 200, dot.y + 150); // drop whatever the module picked up
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));

	h.check(h.pageErrors(A).length === 0, `the page threw nothing (${h.pageErrors(A).join(' / ')})`);
	await h.finish(browser);
});
