// 37-avatar-fix R22 perf — eight characters, all knocked off at once, on the real renderer. The
// knocked-off idle must cost at most ONE extra draw call per character (the stars + star eyes are a
// single InstancedMesh), no shadow draws, a handful of triangles, and nothing at all while awake.
// Frame ms on this box is printed, never gated (it is not a Quest number). The update cost of the
// 8 bodies (mixer + the R23 sole clamp + the R22 sway/stars) is measured in-page and printed.
const h = require('./helpers.cjs');

const CHARS = ['knight', 'mage', 'rogue', 'rogue-hooded', 'barbarian', 'skeleton-minion', 'skeleton-warrior', 'skeleton-mage'];
const SHOTS = process.env.AVATAR_SHOTS || '';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([0, 2.4, 6.5], [0, 1.3, -2], 0));
	await A.page.waitForTimeout(800);
	const measure = (shadows = true) =>
		A.page.evaluate((shadows) => {
			const s = window.__stores;
			let r, scene, cam;
			s.globalRenderer.subscribe((x) => (r = x))();
			s.globalScene.subscribe((x) => (scene = x))();
			s.globalCamera.subscribe((x) => (cam = x))();
			const auto = r.info.autoReset;
			const sm = r.shadowMap.enabled;
			r.shadowMap.enabled = shadows;
			r.info.autoReset = false;
			r.info.reset();
			r.render(scene, cam);
			const out = { calls: r.info.render.calls, tris: r.info.render.triangles };
			r.info.autoReset = auto;
			r.shadowMap.enabled = sm;
			return out;
		}, shadows);
	/** frames per second over `ms`, and the 8 bodies' update cost (ms per frame, measured in a loop) */
	const timing = (ms = 2000) =>
		A.page.evaluate(async (ms) => {
			const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
			const t0 = performance.now();
			let frames = 0;
			while (performance.now() - t0 < ms) {
				await tick();
				frames++;
			}
			const s = window.__stores;
			let scene;
			s.globalScene.subscribe((x) => (scene = x))();
			const list = [...s.avatars.avatarInstances.entries()];
			const u0 = performance.now();
			for (let f = 0; f < 60; f++) for (const [id, a] of list) a.update(1 / 72, f / 72, scene.getObjectByName(id), null, null);
			return { fps: (frames * 1000) / ms, updateMs: (performance.now() - u0) / 60 };
		}, ms);

	// eight peers in a row, one per character, two of them on stylised heads (+ hats)
	await A.page.evaluate((chars) => {
		const s = window.__stores;
		const ud = [];
		s.userdata.subscribe((v) => ud.push(...(v ?? [])))();
		s.userdata.set([
			...ud,
			...chars.map((c, i) => ['kp' + i, 'Peer ' + i, null, null, null, { character: c, hat: i % 3 ? 'none' : 'cap', head: i % 4 === 1 ? 'sphere' : 'character', showLabel: false }])
		]);
	}, CHARS);
	await h.eventually(
		() => A.page.evaluate(() => Object.values(window.__stores.avatars.avatarsDebug()).filter((a) => a.ready).length),
		(n) => n === 8,
		'0.1 (premise) eight rigged peers are loaded',
		20000
	);
	await A.page.evaluate((n) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		for (let i = 0; i < n; i++) {
			const g = scene.getObjectByName('kp' + i);
			g.position.set((i - (n - 1) / 2) * 1.3, 1.6, -2);
			g.rotation.set(0, Math.PI, 0); // facing the camera
		}
	}, 8);
	await A.page.waitForTimeout(1200);
	const awake = await measure();
	const awakeMain = await measure(false);
	const tAwake = await timing();

	// all eight knocked off at once (the camera-stream flag, set where moveCamera would set it)
	await A.page.evaluate((n) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		for (let i = 0; i < n; i++) scene.getObjectByName('kp' + i).userData.knocked = true;
	}, 8);
	await h.eventually(
		() => A.page.evaluate(() => Object.values(window.__stores.avatars.avatarsDebug()).map((a) => a.dizzy)),
		(d) => d.length === 8 && d.every((x) => x > 0.95),
		'0.2 (premise) all eight are knocked off',
		8000
	);
	const knocked = await measure();
	const knockedMain = await measure(false);
	const tKnocked = await timing();
	if (SHOTS) {
		await A.page.screenshot({ path: SHOTS + '/06-eight-knocked-off.png' });
		// a close-up of two faces: the star eyes on the character's own head and on a stylised head
		await A.page.evaluate(() => window.__stores.objectActions.flyTo([-3.6, 1.55, 0.4], [-3.6, 1.45, -2], 0));
		await A.page.waitForTimeout(700);
		await A.page.screenshot({ path: SHOTS + '/07-knocked-off-faces.png' });
		await A.page.evaluate(() => window.__stores.objectActions.flyTo([0, 2.4, 6.5], [0, 1.3, -2], 0));
		await A.page.waitForTimeout(400);
	}
	const dCalls = knockedMain.calls - awakeMain.calls;
	const dShadow = knocked.calls - awake.calls - dCalls;
	const dTris = knockedMain.tris - awakeMain.tris;
	console.log(
		`awake ${JSON.stringify(awake)} knocked ${JSON.stringify(knocked)}; fps(this box) ${tAwake.fps.toFixed(0)} -> ${tKnocked.fps.toFixed(0)}; ` +
			`8-body update ${tAwake.updateMs.toFixed(2)} -> ${tKnocked.updateMs.toFixed(2)} ms/frame`
	);
	h.check(dCalls <= 8, `1.1 eight knocked-off characters add ${dCalls} main-pass draw calls (<= 8: one each)`);
	h.check(dShadow <= 0, `1.2 ...and ${dShadow} shadow draws (the stars cast none)`);
	h.check(dTris <= 8 * 7 * 10, `1.3 ...and ${dTris} triangles (7 flat stars each)`);
	h.check(knocked.calls <= 150 && knocked.tris <= 300000, `1.4 the whole frame stays inside the Quest budget (${knocked.calls} calls, ${knocked.tris} tris)`);
	h.check(tKnocked.updateMs - tAwake.updateMs < 1.0, `1.5 the effect adds ${(tKnocked.updateMs - tAwake.updateMs).toFixed(2)} ms of CPU for 8 bodies (< 1 ms on this box)`);

	// awake again: back to zero cost
	await A.page.evaluate((n) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		for (let i = 0; i < n; i++) scene.getObjectByName('kp' + i).userData.knocked = false;
	}, 8);
	await h.eventually(
		() => A.page.evaluate(() => Object.values(window.__stores.avatars.avatarsDebug()).every((a) => a.dizzy === 0)),
		(ok) => ok,
		'2.1 everyone wakes: the effect blends out',
		8000
	);
	const back = await measure(false);
	h.check(back.calls === awakeMain.calls, `2.2 awake costs nothing (${back.calls} calls, as before)`);
	await h.finish(browser);
});
