// 102b save-file compatibility, both directions, through the REAL .tpscene path (buildSessionPayload ->
// exportSessionZip, readSessionZip -> openScenePayload):
//   §1 an OLD scene (saved by a v1.70.0 page: dynamic bodies, a weld and a hinge) opens in this build UNCHANGED —
//      every physics block and joint byte-identical, re-saving writes no new key, and with the feature unused every
//      body gets the damping the v1.70.0 run gave it and gravity scale 1 (feature unused = zero change);
//   §2 a file SAVED BY THIS BUILD (gravity scale, drag, all six joint kinds) opens in v1.70.0: every object, every
//      userData key and every joint def arrive, the old run starts with no crash and holds the new kinds as welds.
// v1.70.0 is a second dev server: E2E_BASE_URL=https://theprototype.app:<port>/ (scripts/ci/battery-snapshot.sh).
// Without it (the union battery) §1 and §2 run as a round trip inside this build, and E2E_OLD_TPSCENE=<a shipped
// .tpscene> adds a shipped scene to §1.
const fs = require('node:fs');
const h = require('./helpers.cjs');

const BASE = process.env.E2E_BASE_URL || '';
const OLD_FILE = process.env.E2E_OLD_TPSCENE || '';

/** a page on the v1.70.0 server (setupPage always opens APP_URL) */
async function basePage(browser, errors) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
	// the same opt-ins setupPage gives every page: the test API, and no first-visit overlays
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	const page = await ctx.newPage();
	page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
	await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
	await page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 120000 });
	await page.waitForTimeout(1500);
	return { ctx, page };
}

/** build the scene a page holds into .tpscene bytes (base64) */
const saveZip = (page) =>
	page.evaluate(async () => {
		const s = await window.__tp.test.v1.sessions;
		const payload = s.buildSessionPayload('compat');
		const zip = await s.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		let bin = '';
		const u8 = new Uint8Array(zip);
		for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
		return btoa(bin);
	});

/** open .tpscene bytes in a page the way File > Open does, wait for `count` top-level objects */
async function openZip(page, b64, label) {
	const ok = await page.evaluate(async (data) => {
		const bin = atob(data);
		const u8 = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
		const payload = await window.__tp.test.v1.sessions.readSessionZip(u8.buffer);
		return window.__tp.test.v1.fileHandler.openScenePayload(payload);
	}, b64);
	h.check(ok !== false, `${label}: the file opened`);
	await page.waitForTimeout(2500);
}

/** the physics surface of a payload: every physics block (sorted JSON) and the joint list, with object NAMES */
const surface = (page, fromB64 = null) =>
	page.evaluate(async (data) => {
		const v = window.__tp.test.v1;
		let payload;
		if (data) {
			const bin = atob(data);
			const u8 = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
			payload = await v.sessions.readSessionZip(u8.buffer);
		} else payload = v.sessions.buildSessionPayload('compat');
		const blocks = [];
		const walk = (x) => {
			if (Array.isArray(x)) return x.forEach(walk);
			if (!x || typeof x !== 'object') return;
			const p = x.physics;
			if (p && typeof p === 'object' && ('mode' in p || 'mass' in p || 'collider' in p)) blocks.push(JSON.stringify(p, Object.keys(p).sort()));
			for (const y of Object.values(x)) {
				if (typeof y === 'string' && y.startsWith('{') && y.includes('"physics"')) {
					try {
						walk(JSON.parse(y));
					} catch {}
				} else walk(y);
			}
		};
		walk(payload.objects ?? payload);
		return { blocks: blocks.sort(), joints: JSON.stringify(payload.joints ?? []), jointCount: (payload.joints ?? []).length };
	}, fromB64);

/** start a run, read each named body's damping / gravity scale, stop */
const bodies = (page) =>
	page.evaluate(async () => {
		const v = window.__tp.test.v1;
		const on = () => new Promise((r) => v.physics.simulating.subscribe(r)());
		if (!(await on())) await v.physics.toggleSimulation();
		for (let i = 0; i < 60 && !v.physics.physicsDebug().length; i++) await new Promise((r) => setTimeout(r, 250));
		await new Promise((r) => setTimeout(r, 300));
		const out = {};
		for (const e of v.physics.physicsDebug()) if (e.mode === 'dynamic') out[e.name] = { lin: e.linearDamping, ang: e.angularDamping, g: e.gravityScale ?? null };
		const live = v.physics.liveJointIds().length;
		v.physics.stopSimulation({ reset: true });
		return { bodies: out, live };
	});

/** the OLD scene: three dynamic boxes, a weld and a hinge, built with the API every build has */
const buildOld = (page) =>
	page.evaluate(() => {
		const v = window.__tp.test.v1;
		const cmd = v.commandsHandler.sceneCommand;
		const names = ['OldA', 'OldB', 'OldC', 'OldFloor'];
		names.forEach(() => cmd('/create Box 0.5 0.5 0.5'));
		let g;
		v.objectsGroup.subscribe((x) => (g = x))();
		const objs = g.children.slice(-4);
		objs.forEach((o, i) => {
			o.name = names[i];
			o.position.set(i * 1.5, 3, 0);
			o.updateMatrixWorld(true);
		});
		v.physics.setPhysicsFor(objs[0].uuid, { mode: 'dynamic', mass: 2, friction: 0.8 });
		v.physics.setPhysicsFor(objs[1].uuid, { mode: 'dynamic', mass: 1, restitution: 0.6 });
		v.physics.setPhysicsFor(objs[2].uuid, { mode: 'dynamic', mass: 1, ccd: true });
		v.physics.setPhysicsFor(objs[3].uuid, { mode: 'static' });
		v.joints.createJoint('fixed', objs[0].uuid, objs[1].uuid);
		v.joints.createJoint('revolute', objs[3].uuid, objs[2].uuid, 'z');
	});

/** the NEW scene: tuned bodies and all six joint kinds */
const buildNew = (page) =>
	page.evaluate(() => {
		const v = window.__tp.test.v1;
		const cmd = v.commandsHandler.sceneCommand;
		const make = (name, x, physics) => {
			cmd('/create Box 0.4 0.4 0.4');
			let g;
			v.objectsGroup.subscribe((y) => (g = y))();
			const o = g.children[g.children.length - 1];
			o.name = name;
			o.position.set(x, 4, 0);
			o.updateMatrixWorld(true);
			v.physics.setPhysicsFor(o.uuid, physics);
			return o.uuid;
		};
		const post = make('Post', 0, { mode: 'static' });
		const kinds = ['fixed', 'revolute', 'ball', 'slider', 'spring', 'rope'];
		kinds.forEach((k, i) => {
			const bob = make('Bob-' + k, (i + 1) * 1.2, { mode: 'dynamic', mass: 1, gravityScale: 0.5, linearDamping: 1.5, angularDamping: 0.4 });
			v.joints.createJoint(k, post, bob, 'y', undefined, k === 'slider' ? { limits: [-1, 0] } : k === 'rope' ? { length: 2 } : undefined);
		});
		return kinds.length;
	});

const objectNames = (page) =>
	page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		return g.children.map((o) => o.name).filter(Boolean).sort();
	});
/** clear and WAIT until the world is empty (a scene's pack pieces can still be arriving: clear again) */
async function clearScene(page) {
	await h.eventually(
		() =>
			page.evaluate(() => {
				let g;
				window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
				if (g.children.length) window.__tp.test.v1.commandsHandler.sceneCommand('/clear');
				return g.children.length;
			}),
		(n) => n === 0,
		'the scene is empty before the next file',
		30000
	);
}

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const L = await h.setupPage(browser, 'lane');
	const baseErrors = [];
	const O = BASE ? await basePage(browser, baseErrors) : null;
	const older = O ? O.page : L.page; // without a base server, the "old" side is this build
	console.log(`[compat] old side: ${BASE ? 'v1.70.0 at ' + BASE : 'this build (no E2E_BASE_URL)'}`);

	// ---- §1 an old scene opens unchanged, and with the feature unused nothing changes ----
	await buildOld(older);
	const oldRun = await bodies(older);
	const oldZip = await saveZip(older);
	const oldSurface = await surface(older, oldZip);
	h.check(oldSurface.jointCount === 2 && oldSurface.blocks.length === 4, `premise: the old file holds 4 bodies and 2 joints (${oldSurface.blocks.length}, ${oldSurface.jointCount})`);
	if (O) await clearScene(O.page);
	else await clearScene(L.page);
	await openZip(L.page, oldZip, '§1 old scene in this build');
	const opened = await surface(L.page);
	h.check(JSON.stringify(opened.blocks) === JSON.stringify(oldSurface.blocks), '§1 every physics block re-saves byte-identical (no new key written)');
	h.check(opened.joints === oldSurface.joints, '§1 the weld and the hinge re-save byte-identical');
	const laneRun = await bodies(L.page);
	const same = Object.keys(oldRun.bodies).every(
		(n) => laneRun.bodies[n] && Math.abs(laneRun.bodies[n].lin - oldRun.bodies[n].lin) < 1e-9 && Math.abs(laneRun.bodies[n].ang - oldRun.bodies[n].ang) < 1e-9 && laneRun.bodies[n].g === 1
	);
	h.check(Object.keys(oldRun.bodies).length === 3 && same, `§1 feature unused = zero change: each body's damping equals the ${BASE ? 'v1.70.0' : 'old'} run's, gravity scale 1 (${JSON.stringify({ old: oldRun.bodies, lane: laneRun.bodies })})`);
	h.check(laneRun.live === 2 && oldRun.live === 2, `§1 both runs build the two joints (${oldRun.live}, ${laneRun.live})`);

	if (OLD_FILE && fs.existsSync(OLD_FILE)) {
		const b64 = fs.readFileSync(OLD_FILE).toString('base64');
		const fileSurface = await surface(L.page, b64);
		await clearScene(L.page);
		await openZip(L.page, b64, '§1 shipped scene');
		await L.page.waitForTimeout(3000);
		const after = await surface(L.page);
		h.check(JSON.stringify(after.blocks) === JSON.stringify(fileSurface.blocks) && after.joints === fileSurface.joints, `§1 the shipped scene ${OLD_FILE.split('/').slice(-2).join('/')} re-saves its ${fileSurface.blocks.length} physics blocks unchanged`);
	}

	// ---- §2 a file saved by this build opens in the older one ----
	await clearScene(L.page);
	const kinds = await buildNew(L.page);
	const savedNames = await objectNames(L.page);
	const newZip = await saveZip(L.page);
	const newSurface = await surface(L.page, newZip);
	h.check(newSurface.jointCount === kinds && newSurface.blocks.filter((b) => b.includes('"gravityScale":0.5')).length === kinds, `premise: the new file holds ${kinds} joints and ${kinds} tuned bodies`);
	await clearScene(older);
	await openZip(older, newZip, `§2 new file in ${BASE ? 'v1.70.0' : 'this build'}`);
	const names = await objectNames(older);
	h.check(savedNames.length === kinds + 1 && JSON.stringify(names) === JSON.stringify(savedNames), `§2 every object arrives (${names.join(', ')})`);
	const there = await surface(older);
	h.check(JSON.stringify(there.blocks) === JSON.stringify(newSurface.blocks), '§2 every userData.physics key survives, gravityScale / linearDamping / angularDamping included');
	h.check(there.joints === newSurface.joints, '§2 all six joint defs arrive field for field (an older build keeps what it does not use)');
	const run = await bodies(older);
	h.check(run.live === kinds, `§2 a run starts and builds every joint (${run.live}/${kinds}; v1.70.0 holds the four new kinds as welds)`);
	if (O) {
		const crashes = baseErrors.filter((e) => !/ResizeObserver|AbortError|Failed to fetch/i.test(e));
		h.check(crashes.length === 0, `§2 no page error in v1.70.0 (${crashes.slice(0, 3).join(' | ')})`);
		await O.ctx.close();
	}

	await h.finish(browser);
});
