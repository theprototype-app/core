// 36-vr — EVERY RADIAL RING + THE VR SETTINGS PANEL, as the headset eye sees them (a tool, not a
// suite: `node tests/e2e/vr-ring-shots.cjs <outdir> [prefix]`). The ring is not posed without a real
// session (it sits at the origin), so each shot poses the menu group 0.32 m in front of a standing
// head and renders the LEFT eye through vrEyes (the headset's own render path, troika text and all).
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const eyes = require('./vrEyes.cjs');

const OUT = process.argv[2] || '/tmp/vr-ring-shots';
const PREFIX = process.argv[3] || 'ring';

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 900, height: 700 } } });
	const page = A.page;
	await xr.install(page);
	await xr.pose(page, 'left', [-20, 30, 20], { pitch: 1.4 });
	await xr.pose(page, 'right', [20, 30, 20], { pitch: 1.4 });
	await page.evaluate(() => {
		const s = window.__stores;
		s.viewMode.set('shaded');
		s.showGrid.set(false);
	});

	// the LEFT eye sits ipd/2 left of the head: centre the target in that eye
	const HEAD = [0.0315, 1.6, 0.32];
	/** pose a named group in front of the head, facing it (`dist` metres away) */
	const place = (name, scale = 1, dist = 0.32) =>
		page.evaluate(
			({ name, scale, dist }) => {
				const s = window.__stores;
				let scene;
				s.globalScene.subscribe((v) => (scene = v))();
				const g = scene.getObjectByName(name);
				if (!g) return false;
				g.position.set(0, 1.6, 0.32 - dist);
				g.quaternion.identity();
				g.scale.setScalar(scale);
				g.updateMatrixWorld(true);
				return true;
			},
			{ name, scale, dist }
		);
	const shot = async (file, name, scale = 1, dist = 0.32) => {
		await page.waitForTimeout(400); // troika lays text out asynchronously
		const ok = await place(name, scale, dist);
		await page.waitForTimeout(150);
		await place(name, scale, dist);
		const r = await eyes.shoot(page, { size: 720, fov: 44, head: { position: HEAD } });
		const p = path.join(OUT, file);
		fs.writeFileSync(p, r.left);
		console.log((ok ? 'saved ' : 'MISSING group ' + name + ' — saved anyway ') + p);
	};

	const rings = await page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		// every ring reachable from root by nav entries (BFS), plus the selection ring
		const seen = ['root'];
		for (let i = 0; i < seen.length; i++)
			for (const e of m.ringEntries(seen[i])) if (e.ring && !seen.includes(e.ring)) seen.push(e.ring);
		if (!seen.includes('object')) seen.push('object');
		return seen;
	});
	console.log('rings: ' + rings.join(', '));

	let n = 1;
	for (const ring of rings) {
		await page.evaluate((ring) => {
			const s = window.__stores;
			const m = s.vrRadialMenu;
			if (ring === 'object') {
				s.commandsHandler.sceneCommand('/create box');
				// park it behind the head: the shot is of the ring, not the selection
				let sel;
				s.selectedObject.subscribe((v) => (sel = v))();
				sel?.position?.set(0, 1, 30);
				sel?.updateMatrixWorld?.(true);
			}
			s.vrMenuOpen.set(true);
			m.resetRings();
			if (ring !== 'root') m.pushRing(ring);
		}, ring);
		await shot(`${String(n++).padStart(2, '0')}-${PREFIX}-${ring.replace(/[^a-z0-9]+/gi, '-')}.png`, 'vr-quick-menu', 1);
	}
	await page.evaluate(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(false);
		s.objectActions.deleteSelection?.();
	});

	// the VR panels that hold settings
	for (const [store, name, file] of [
		['vrSettingsPanelOpen', 'vr-settings-panel', 'settings-panel'],
		['vrControlsPanelOpen', 'vr-controls-panel', 'controls-panel']
	]) {
		const has = await page.evaluate((store) => !!window.__stores[store], store);
		if (!has) continue;
		await page.evaluate((store) => window.__stores[store].set(true), store);
		await shot(`${String(n++).padStart(2, '0')}-${PREFIX}-${file}.png`, name, 1, 0.62);
		await page.evaluate((store) => window.__stores[store].set(false), store);
	}
	await h.finish(browser);
});
