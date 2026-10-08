// Roadmap 39 P6 — what a pro placement tool also does:
//   · a multi-selection drags as one gesture and drops as a ROW (each item its own ghost), ONE undo
//   · Alt while dropping = the camera's focus point
//   · aiming above the horizon (no surface) turns the ghost red, and releasing there places nothing
//
//   APP_URL=https://theprototype.app:5390/ node tests/e2e/place-drag-extras.test.cjs
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const STATIC = path.join(__dirname, '../../static/library');

async function routeStarterPack(peer) {
	await peer.ctx.route(/cdn\.jsdelivr\.net\/gh\/theprototype-app\/packs@[^/]+\/(.*)$/, (route) => {
		const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*packs@[^/]+\//, ''));
		if (rel === 'index.json')
			return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ name: 'default', title: 'The Prototype', value: 'default/default.json', attribution: 'default/attribution.html', copyright: '', license: '', source: 'https://github.com/theprototype-app/packs' }]) });
		const file = path.join(STATIC, rel);
		if (!file.startsWith(STATIC) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
		const type = /\.json$/.test(file) ? 'application/json' : /\.glb$/.test(file) ? 'model/gltf-binary' : 'image/png';
		return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
	});
	await peer.page.evaluate(() => window.__stores.packs.loadPacks());
}

const pd = (page) => page.evaluate(() => window.__stores.placeDrag.state());
const counts = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let g, undo;
		s.objectsGroup.subscribe((v) => (g = v))();
		s.history.undoStack.subscribe((v) => (undo = v))();
		return { objects: g.children.length, undo: undo.length };
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const { page } = A;
	await routeStarterPack(A);
	await page.evaluate(() => window.__stores.explorerClose.set(false));
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('pack:default'));
	const duck = page.locator('.explorer-card', { hasText: 'Duck' }).first();
	const logo = page.locator('.explorer-card', { hasText: 'Logo' }).first();
	await duck.waitFor({ timeout: 15000 });
	const canvas = await page.evaluate(() => {
		let renderer;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const r = renderer.domElement.getBoundingClientRect();
		const pick = (fy) => ({ x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height * fy) });
		return { ground: pick(0.5), sky: pick(0.02), top: r.top };
	});
	const pickUp = async (card, to) => {
		const b = await card.boundingBox();
		await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 10, { steps: 6 });
		await page.mouse.move(to.x, to.y, { steps: 12 });
		await page.waitForTimeout(300);
	};

	// ---- 1. a multi-selection drops as a row, one undo step --------------------------------
	await duck.click();
	await logo.click({ modifiers: ['Control'] });
	await page.waitForTimeout(200);
	const before = await counts(page);
	await pickUp(duck, canvas.ground);
	let s = await pd(page);
	h.check(s?.items?.length === 2, 'dragging one card of a two-card selection carries both (' + s?.items?.length + ')');
	const [p1, p2] = s?.placements ?? [];
	const gap = p1 && p2 ? Math.hypot(p1.position[0] - p2.position[0], p1.position[2] - p2.position[2]) : 0;
	h.check(gap > 1, 'each item has its own ghost, side by side in a row (' + gap.toFixed(2) + ' m apart)');
	h.check((await page.evaluate(() => window.__stores.placeDrag.ghostInfo().items.length)) === 2, 'two ghosts are drawn');
	await page.mouse.up();
	await h.eventually(() => counts(page), (c) => c.objects === before.objects + 2, 'releasing places both');
	let after = await counts(page);
	h.check(after.undo === before.undo + 1, 'as ONE undo step (' + before.undo + ' → ' + after.undo + ')');
	await page.keyboard.press('Control+z');
	await page.waitForTimeout(600);
	h.check((await counts(page)).objects === before.objects, 'and one Ctrl+Z removes both');
	await duck.click();
	await page.waitForTimeout(200);

	// ---- 2. Alt = the camera focus point ----------------------------------------------------
	const target = await page.evaluate(() => {
		let c;
		window.__stores.orbitControls.subscribe((v) => (c = v))();
		return c?.target?.toArray() ?? null;
	});
	await pickUp(duck, canvas.ground);
	await page.keyboard.down('Alt');
	await page.mouse.move(canvas.ground.x + 3, canvas.ground.y + 3);
	await page.waitForTimeout(200);
	s = await pd(page);
	const ap = s?.placements?.[0]?.position;
	h.check(!!target && !!ap && Math.abs(ap[0] - target[0]) < 1e-3 && Math.abs(ap[2] - target[2]) < 1e-3, 'with Alt the ghost stands at the camera focus point (' + JSON.stringify(ap) + ' vs ' + JSON.stringify(target) + ')');
	h.check(!!ap && Math.abs(ap[1] - -0.099) < 0.01, 'on the ground below it, not in the air (y ' + ap?.[1]?.toFixed(3) + ')');
	const chip = await page.locator('#place-drag-chip').textContent();
	h.check(/At the camera focus/.test(chip || ''), 'and the chip says so');
	await page.mouse.up();
	await page.keyboard.up('Alt');
	await h.eventually(() => counts(page), (c) => c.objects === before.objects + 1, 'Alt-drop places it there');
	await page.keyboard.press('Control+z');
	await page.waitForTimeout(600);

	// ---- 3. nowhere to place it: red, and the release does nothing ---------------------------
	// look at the horizon, so the upper half of the view is sky (the default view sees ground everywhere)
	const sky = await page.evaluate(() => {
		const s = window.__stores;
		let c, cam, renderer;
		s.orbitControls.subscribe((v) => (c = v))();
		s.globalCamera.subscribe((v) => (cam = v))();
		s.globalRenderer.subscribe((v) => (renderer = v))();
		cam.position.set(0, 2, 12);
		c.target.set(0, 2, 0);
		c.update();
		cam.updateMatrixWorld(true);
		const r = renderer.domElement.getBoundingClientRect();
		for (const fy of [0.3, 0.25, 0.35, 0.2]) for (const fx of [0.5, 0.3, 0.7]) {
			const x = Math.round(r.left + r.width * fx);
			const y = Math.round(r.top + r.height * fy);
			if (document.elementFromPoint(x, y) === renderer.domElement) return { x, y };
		}
		return null;
	});
	h.check(!!sky, 'premise: a free viewport point above the horizon');
	canvas.sky = sky ?? canvas.sky;
	const c0 = await counts(page);
	await pickUp(duck, canvas.sky);
	s = await pd(page);
	h.check(s?.over === 'viewport' && s?.state === 'bad', 'aiming at the sky turns the ghost red (state ' + s?.state + ', over ' + s?.over + ')');
	h.check(/No place to put it here/.test((await page.locator('#place-drag-chip').textContent()) || ''), 'the chip says there is no place for it');
	await page.mouse.up();
	await page.waitForTimeout(800);
	const c1 = await counts(page);
	h.check(c1.objects === c0.objects && c1.undo === c0.undo, 'releasing there places nothing, no undo entry');
	h.check((await page.evaluate(() => window.__stores.placeDrag.last())).end === 'invalid', 'the drag ended as invalid');

	await h.finish(browser);
});
