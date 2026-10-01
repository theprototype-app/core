// B8 → 31-towers ACCEPTANCE — the Towers game template, loaded from the REAL .tpscene in the
// sibling scenes checkout (or TOWERS_TPSCENE=<path>, a lane's staged build) and driven through
// the real surfaces. Skip-never-fail when the scenes checkout is absent — authored content, not
// core code, must keep a bare checkout green.
//
// 31-towers: Towers is TWELVE LEVELS now (the core `towers` module: levels, pieces, stars,
// unlocks — towers-levels plays them). This suite owns the SCENE: the arena every level names
// (three build zones, the racks, the high ledge, the star perch, the moving markers, the piece
// templates parked under the floor), the look, the play block (grab REACH + the spawn), the
// player's body (a walk + jump Character Controller), the level-select menu and a readable
// frame. No module download any more: the collectible stars are gone and the template needs
// only core.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [
	path.resolve(__dirname, '../../../theprototype.app-scenes'),
	path.resolve(__dirname, '../../../scenes')
].find((p) => fs.existsSync(p));
const TPSCENE = process.env.TOWERS_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/towers/scene.tpscene'));

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no sibling scenes checkout with games/towers/scene.tpscene (or TOWERS_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2000);

	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			const group = g(s.objectsGroup);
			return {
				names: group.children.map((c) => c.name),
				dynamic: group.children.filter((c) => c.userData?.physics?.mode === 'dynamic').map((c) => ({ name: c.name, y: c.position.y })),
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';

	// 1 — the arena every level names arrived, and nothing loose on the floor
	let st = await snap();
	if (!st.names.includes('Towers game')) {
		console.log('SKIP: this Towers scene predates 31 (no "Towers game" marker) — author it or set TOWERS_TPSCENE');
		await h.finish(browser);
		return;
	}
	const need = ['Build pad', 'Pedestal', 'Wobble plate', 'Rack west', 'Rack east', 'High ledge', 'Star perch', 'Goal ring', 'Yard ring', 'Ghost wall', 'Template vault', 'Card camera'];
	h.check(need.every((n) => st.names.includes(n)), `the arena: zones, racks, ledge, perch, markers (${need.filter((n) => !st.names.includes(n)).join(', ') || 'all present'})`);
	const templates = ['cube', 'plank', 'beam', 'wedge', 'barrel', 'arch', 'L', 'ball', 'base', 'star'].map((k) => 'Piece ' + k);
	h.check(templates.every((n) => st.dynamic.some((d) => d.name === n && d.y < -5)), 'ten piece TEMPLATES, dynamic, parked on the vault under the floor');
	h.check(st.dynamic.length === templates.length, `and no other dynamic object — the pieces are dealt per level (${st.dynamic.length})`);
	h.check(st.play?.simOnPlay === true && st.play?.interaction === 'grab' && st.play?.reach === 1.3, `play block: grab, simOnPlay, reach 1.3 m (${JSON.stringify(st.play)})`);
	h.check(st.state === 'menu' && st.screen === 'menu', `starts on the level select (${st.state}/${st.screen})`);
	const shapes = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const arch = g.getObjectByName('Piece arch');
		const l = g.getObjectByName('Piece L');
		const wedge = g.getObjectByName('Piece wedge');
		return {
			arch: arch?.userData?.physics?.collider + ':' + (arch?.userData?.physics?.colliderPieces?.length ?? 0),
			l: l?.userData?.physics?.collider + ':' + (l?.userData?.physics?.colliderPieces?.length ?? 0),
			wedge: wedge?.userData?.physics?.collider,
			wedgeGeo: wedge?.geometry?.type
		};
	});
	h.check(shapes.arch === 'custom:3' && shapes.l === 'custom:2' && shapes.wedge === 'hull', `real shapes collide as themselves: arch 3 boxes, L 2 boxes, wedge a hull (${JSON.stringify(shapes)})`);

	// 1b — the look, measured
	const look = await page.evaluate(() => {
		const s = window.__stores;
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const floor = g(s.objectsGroup).getObjectByName('Arena floor');
		const env = g(s.environment.environment);
		return {
			floorShader: !!g(s.shaderGraph.shaderGraphs)[floor?.uuid] && !g(s.shaderGraph.shaderErrors)[floor?.uuid],
			gradient: !!env?.customPreset?.gradient, ground: !!env?.customPreset?.ground, exposure: env?.exposure,
			post: (g(s.scenePost.scenePost)?.effects ?? []).map((e) => e.kind)
		};
	});
	h.check(look.floorShader, 'the arena floor carries its tile shader graph');
	h.check(look.gradient && look.ground && look.exposure >= 0.9, `a real sky and ground, exposure >= 0.9 (${look.gradient}/${look.ground}/${look.exposure})`);
	h.check(['ao', 'tonemapping', 'bloom', 'smaa'].every((k) => look.post.includes(k)), `the post floor: AO, tone mapping, bloom, SMAA (${look.post})`);
	const loadToasts = await page.locator('.tp-toast').allTextContents().catch(() => []);
	h.check(!loadToasts.some((t) => /cap|error|went wrong|install|module/i.test(t)), `no warning toast on load — no module to download (${JSON.stringify(loadToasts).slice(0, 120)})`);

	// 2 — Play: the sim, the body, the menu, the music, the spawn
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim', 10000);
	const body = await page.evaluate(() => window.__stores.charController.charControllerDebug().control);
	h.check(body?.mode === 'walk' && body.jumpHeight === 1 && body.gravity, `the player WALKS and JUMPS 1 m (a Character Controller: ${JSON.stringify(body)})`);
	await h.eventually(hud, (t) => /TOWERS/.test(t) && /1 · Stack/.test(t) && /12 · Summit/.test(t), 'the level select renders in play: twelve levels', 6000);
	h.check(/build steps and jump/.test(await hud()) && /Space jumps/.test(await hud()) && /A jumps/.test(await hud()), 'the menu says how to play — reach, steps, jump — on a desktop and in VR');
	await h.eventually(() => page.evaluate(() => { let m; window.__stores.gameKit.gameMusic.gameMusicState.subscribe((v) => (m = v))(); return m?.preset ?? null; }), (m) => m === 'arcade', 'the arcade music plays in Play', 6000);
	const eye = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		const p = cam.getWorldPosition(new s.THREE.Vector3());
		return [p.x, p.y, p.z].map((n) => +n.toFixed(2));
	});
	h.check(Math.abs(eye[0]) < 0.05 && Math.abs(eye[1] - 1.7) < 0.1 && Math.abs(eye[2] - 5.4) < 0.1, `Play put the eye on the spawn between the racks (${eye})`);
	const centring = await page.evaluate(() => {
		const out = {};
		for (const el of document.querySelectorAll('#hud-layer .hud-text')) {
			const t = el.textContent.trim();
			if (t !== 'TOWERS') continue;
			const r = document.createRange();
			r.selectNodeContents(el);
			const words = r.getBoundingClientRect();
			const box = el.getBoundingClientRect();
			out[t] = +((words.left + words.width / 2) - (box.left + box.width / 2)).toFixed(1);
		}
		return out;
	});
	h.check(Object.keys(centring).length === 1 && Math.abs(centring.TOWERS) < 3, `the title is centred on its box (${JSON.stringify(centring)})`);

	// 3 — a level starts from its button; the frame reads
	await page.locator('#hud-layer button', { hasText: '1 · Stack' }).first().click();
	await h.eventually(() => snap().then((v) => v.state + '/' + v.screen), (v) => v === 'playing/hud', 'the Stack button starts level 1 on the in-game HUD', 8000);
	await h.eventually(() => page.evaluate(() => window.__towers.pieces().length), (n) => n === 6, 'the level deals its six cubes', 8000);
	await page.waitForTimeout(800);
	const lum = await page.evaluate(async (b64) => {
		const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
		const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
		const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
		const d = x.getImageData(Math.round(bmp.width / 2 - 180), Math.round(bmp.height / 2 - 180), 360, 360).data;
		let sum = 0;
		for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		return sum / (d.length / 4) / 255;
	}, (await page.screenshot()).toString('base64'));
	h.check(lum >= 0.25, `the play frame reads: centre luminance ${lum.toFixed(3)} >= 0.25`);
	// no editor helper in Play: the markers are scene objects, the templates are out of sight
	const helpers = await page.evaluate(() => {
		let sc; window.__stores.globalScene.subscribe((v) => (sc = v))();
		const seen = [];
		sc.traverse((o) => { if (o.visible && /helper|grid/i.test(o.name ?? '') && o.parent === sc) seen.push(o.name); });
		return seen;
	});
	h.check(!helpers.includes('editor-grid'), `no editor grid in Play (${helpers.join(', ') || 'none'})`);

	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	await h.finish(browser);
});
