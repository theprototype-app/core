// Regenerate the README screenshots in .github/assets from a REAL app, so they can
// never drift into showing UI that no longer exists.
//
//   npx vite dev --port 5174
//   APP_URL=https://localhost:5174/ node scripts/capture-screenshots.cjs
//
// It builds a small scene, opens the panels worth showing, and clears transient
// toasts/badges before each frame. 1600x940 at scale 1 keeps the whole set ~450 KB.
const { chromium } = require('playwright');
const path = require('path');

const URL = process.env.APP_URL || 'https://localhost:5174/';
const OUT = path.join(__dirname, '../.github/assets');

(async () => {
	const browser = await chromium.launch({
		headless: true,
		args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--use-gl=angle', '--use-angle=gl']
	});
	// 1600px wide at scale 1 is still ~1.8x the 900px the README renders them at, and
	// keeps the whole asset set well under a megabyte.
	const ctx = await browser.newContext({
		ignoreHTTPSErrors: true,
		viewport: { width: 1600, height: 940 },
		deviceScaleFactor: 1
	});
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
		// localhost origin = "local dev" => the app targets a local :9001 signaling
		// server that isn't running, and the pill sits in "Generating…"/reconnect
		// errors. Point it at the real box so the shots show a real session state.
		localStorage.setItem(
			'peerServerConfig',
			JSON.stringify({ mode: 'custom', custom: { host: 'peerjs.theprototype.app', port: 443, path: '/peerjs', secure: true } })
		);
	});
	const page = await ctx.newPage();
	page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message.split('\n')[0]));
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 40000 });
	await page.waitForTimeout(3000);

	async function shotEarly(name, locator) {
		await page.evaluate(() => {
			const s = window.__stores;
			s.toastStore.set([]);
			s.notifications.set([]);
			s.notificationsUnread.set(0);
		});
		await page.waitForTimeout(400);
		const opts = { path: path.join(OUT, name) };
		if (name.endsWith('.jpg')) opts.quality = 88; // 3D renders compress far better as jpeg
		await (locator ? page.locator(locator) : page).screenshot(opts);
		console.log('wrote ' + name);
	}

	// ---- welcome overlay FIRST, over the clean default viewport --------------
	await page.evaluate(() => window.__stores.whatsNew.openWelcome());
	await page.waitForTimeout(900);
	await shotEarly('welcome.jpg');
	await page.evaluate(() => window.__stores.whatsNew.closeWelcome());
	await page.waitForTimeout(400);

	// ---- build a scene worth looking at ------------------------------------
	await page.evaluate(() => window.__stores.environment.setEnvironment('daylight', 1.05));
	await page.waitForTimeout(800);
	await page.evaluate(() => {
		const s = window.__stores;
		const cmd = (c) => s.commandsHandler.sceneCommand(c);
		cmd('/create terrain 60 60');
		cmd('/create box 3 3 3');
		cmd('/create sphere 1.8');
		cmd('/create torusKnot 1.4 0.4'); // the builder upper-cases only the FIRST letter
		cmd('/create cone 1.6 4');
		cmd('/create cylinder 1.2 1.2 3');
		cmd('/create capsule 1 2');
		cmd('/create dodecahedron 1.6');
	});
	await page.waitForTimeout(1500);
	// spread them out + settle the camera (local-only tweak, no replication needed)
	await page.evaluate(() => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const spots = [
			[0, -0.2, 0], // terrain
			[-7, 1.5, -2],
			[-2.5, 1.8, 3],
			[3, 1.6, -4],
			[7, 2, 1],
			[1.5, 1.5, -9],
			[-5, 1.2, 6],
			[5.5, 1.6, 6]
		];
		group.children.forEach((child, i) => {
			const p = spots[i];
			if (p) child.position.set(p[0], p[1], p[2]);
			child.rotation.y = i * 0.7;
		});
		s.objectsGroup.update((v) => v);
		let cam;
		s.globalCamera.subscribe((c) => (cam = c))();
		cam.position.set(14, 9, 18);
		cam.lookAt(0, 1, 0);
		cam.updateProjectionMatrix();
	});
	await page.waitForTimeout(2500);

	async function shot(name, locator) {
		// transient toasts / unread badges are noise in a screenshot
		await page.evaluate(() => {
			const s = window.__stores;
			s.toastStore.set([]);
			s.notifications.set([]);
			s.notificationsUnread.set(0);
		});
		await page.waitForTimeout(400);
		const opts = { path: path.join(OUT, name) };
		if (name.endsWith('.jpg')) opts.quality = 88;
		await (locator ? page.locator(locator) : page).screenshot(opts);
		console.log('wrote ' + name);
	}

	// 1. hero — the app as you meet it, object list open so it reads as an editor
	await page.evaluate(() => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(900);
	await shot('hero.jpg');

	// 2. flow editor with a small graph (object list closed so it doesn't overlap)
	await page.evaluate(() => {
		const s = window.__stores;
		s.objectListClose.set(true);
		const mk = (id, type, x, y, data) => s.nodesHandler.createFlowNode({ id, type, position: { x, y }, data: data || {} });
		mk('shot-time', 'time', 340, 60, {});
		mk('shot-slider', 'slider', 340, 230, { value: 1.4, min: 0, max: 5 });
		mk('shot-math', 'math', 620, 140, { operation: 'multiply' });
		s.nodesHandler.createFlowEdge({ id: 'e1', source: 'shot-time', target: 'shot-math', targetHandle: 'a' });
		s.nodesHandler.createFlowEdge({ id: 'e2', source: 'shot-slider', target: 'shot-math', targetHandle: 'b' });
		s.flowGraphClose.set(false); // open the docked node editor
		s.bottomDock.dockHeight.set(430); // dockHeight lives on the bottomDock namespace
	});
	await page.waitForTimeout(1800);
	// frame the graph with xyflow's own fit-view control
	const fit = page.locator('.svelte-flow__controls-fitview, button[title*="fit" i]').first();
	if (await fit.count()) {
		await fit.click().catch(() => {});
		await page.waitForTimeout(900);
	}
	await shot('flow.jpg');

	// 3. what's new
	await page.evaluate(() => window.__stores.whatsNew.openWhatsNew());
	await page.waitForTimeout(900);
	await shot('whats-new.png', '#whats-new-window');

	await browser.close();
})();
