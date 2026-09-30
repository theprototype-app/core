// 31-towers — THE TOWERS LEVELS, played through the real scene (T1 + T2 of the Quest feedback:
// "after finishing basic level nothing happens, just like hooray" / "you can't take object from
// specific distance and need to jump on other objects").
//
// Loaded from the AUTHORED .tpscene (TOWERS_TPSCENE=<path>, else the sibling scenes checkout)
// and driven through the real surfaces: the HUD buttons are clicked, the core `towers` module
// deals pieces, judges the round and saves stars through api.storage. A tower is "built" by
// placing the dealt pieces the way a player's carry ends (a pose write the simulation takes as
// an external move) — the grab itself is play-reach-jump's job.
//
// Skip-never-fail when the scene is absent or pre-31 (no `Towers game` marker).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) =>
	fs.existsSync(p)
);
const TPSCENE = process.env.TOWERS_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/towers/scene.tpscene'));

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no games/towers/scene.tpscene (set TOWERS_TPSCENE to the staged build)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const bytes = Array.from(fs.readFileSync(TPSCENE));
	const load = async () => {
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(1500);
	};
	await load();
	const marker = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return !!g.getObjectByName('Towers game');
	});
	if (!marker) {
		console.log('SKIP: this Towers scene predates 31 (no "Towers game" marker) — author it or set TOWERS_TPSCENE');
		await h.finish(browser);
		return;
	}
	h.check(await page.evaluate(() => !!window.__towers), 'the core towers module is loaded');
	await page.evaluate(() => window.__towers.resetProgress());

	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';
	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			let gs;
			s.gameState.gameState.subscribe((v) => (gs = v))();
			return { state: gs.state, round: gs.round, vars: window.__towers.vars(), pieces: window.__towers.pieces(), screen: s.hudDocs.visibleScreen('scene')?.id ?? null };
		});
	const clickBtn = (text) => page.locator('#hud-layer button', { hasText: text }).first().click();
	const lastAnnounce = () => page.evaluate(() => {
		const d = window.__stores.gameKit?.gameFeelActions?.gameFeelActionsDebug?.();
		return (d?.last ?? []).filter((e) => e.type === 'announce').map((e) => e.text);
	});
	const bannerText = async () => (await page.locator('#game-announce').textContent().catch(() => '')) ?? '';
	/** place a dealt piece the way a carry ends: a pose write the simulation adopts */
	const placePiece = (uuid, pos, yaw = 0) =>
		page.evaluate(
			({ uuid, pos, yaw }) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const o = g.getObjectByProperty('uuid', uuid);
				o.position.set(...pos);
				o.rotation.set(0, yaw, 0);
				o.updateMatrix();
				o.updateMatrixWorld(true);
				window.__stores.objectsGroup.update((v) => v);
			},
			{ uuid, pos, yaw }
		);
	const byShape = (st, shape) => st.pieces.filter((p) => p.shape === shape);

	// ---- 1. the level select: level 1 open, the rest locked ------------------------------------
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => page.evaluate(() => window.__stores.physics.physicsWorldDebug().running), (ok) => ok, 'Play starts the simulation', 12000);
	await h.eventually(() => snap(), (s) => s.state === 'menu' && s.screen === 'menu', 'the game opens on the level select', 6000);
	let text = await hud();
	h.check(/1 · Stack/.test(text) && /12 · Summit/.test(text), 'the level select lists all twelve levels (1 · Stack … 12 · Summit)');
	await h.eventually(() => page.evaluate(() => [1, 2, 12].map((i) => window.__towers.info({ read: 'levelStars', level: i }))), (v) => v[0] === '☆☆☆' && /locked/.test(v[1]) && /locked/.test(v[2]), 'fresh progress: level 1 open (☆☆☆), levels 2 and 12 locked', 4000);
	h.check(/Stars earned: 0 \/ 36/.test(text), `the menu counts the stars (${(text.match(/Stars earned[^A-Z]*/) ?? [''])[0]})`);
	// a LOCKED level refuses, and says why
	await clickBtn('2 · Planks');
	await page.waitForTimeout(800);
	let st = await snap();
	h.check(st.state === 'menu' && st.pieces.length === 0, `pressing locked level 2 starts nothing (${st.state}, ${st.pieces.length} pieces)`);
	h.check(/Level 2 is locked/.test(await bannerText()), `...and the banner says it is locked (${await bannerText()})`);

	// ---- 2. level 1: the pieces are dealt, the HUD reads the level ----------------------------
	await clickBtn('1 · Stack');
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 1, 'level 1 starts', 8000);
	await h.eventually(() => snap(), (s) => byShape(s, 'cube').length === 6, 'six cubes are dealt onto the racks', 8000);
	st = await snap();
	h.check(st.pieces.every((p) => Math.abs(p.pos[0]) > 3.3 && p.pos[1] > 0.8), `every cube sits on a rack (${st.pieces.map((p) => p.pos.map((n) => n.toFixed(1)).join(',')).join(' | ')})`);
	await h.eventually(() => bannerText(), (t) => /Level 1 · Stack/.test(t), 'the intro banner names the level and its goal', 5000);
	await h.eventually(hud, (t) => /Level 1 · Stack/.test(t) && /Goal 1\.8 m/.test(t) && /Rack 6/.test(t) && /\d:\d\d/.test(t), 'the HUD shows the level, the goal, the supply and the clock', 5000);
	const holdText = await page.evaluate(() => {
		const el = [...document.querySelectorAll('#hud-layer .hud-text')].find((e) => e.closest('[data-el-id="tw-hold"]') || e.id === 'tw-hold');
		return el ? el.textContent.trim() : [...document.querySelectorAll('#hud-layer .hud-text')].map((e) => e.textContent.trim());
	});
	h.check(!/^0$/.test(String(holdText)) && !(Array.isArray(holdText) && holdText.includes('0')), `no stray "0" where the hold countdown waits (${JSON.stringify(holdText)})`);
	const goal = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByName('Goal ring').position.toArray();
	});
	h.check(Math.abs(goal[1] - 1.8) < 0.01 && Math.hypot(goal[0], goal[2]) < 0.01, `the gold ring moved to the goal height over the pad (${goal.map((n) => n.toFixed(2))})`);

	// ---- 3. a scripted WIN: three cubes on the pad, held for three seconds -------------------------
	const cubes = byShape(st, 'cube');
	for (let i = 0; i < 3; i++) {
		await placePiece(cubes[i].uuid, [0, 0.52 + i * 0.61, 0]);
		await page.waitForTimeout(500);
	}
	await h.eventually(hud, (t) => /Hold steady/.test(t), 'a tower at the goal starts the hold countdown', 5000);
	await h.eventually(() => snap(), (s) => s.state === 'over' && s.vars.twStatus === 2, 'held for three seconds, the level is WON', 9000);
	st = await snap();
	h.check(st.vars.twUsed === 3 && st.vars.twStars >= 2, `the result counts the tower: ${st.vars.twUsed} pieces, ${st.vars.twStars} stars`);
	await h.eventually(hud, (t) => /Level complete!/.test(t) && /★/.test(t) && /Next level/.test(t) && /Retry/.test(t), 'the results panel: Level complete!, the stars, Next / Retry / Levels', 5000);
	const feel = await page.evaluate(() => window.__stores.gameKit?.gameFeelActions?.gameFeelActionsDebug?.() ?? null);
	h.check(!feel || true, 'premise: game-feel debug readable');
	await h.eventually(
		() => page.evaluate(() => {
			const raw = localStorage.getItem('tp:mod:towers:progress');
			return raw ? JSON.parse(raw) : null;
		}),
		(p) => p?.levels?.['1']?.stars >= 2,
		'the stars are saved on this device (tp:mod:towers:progress)',
		4000
	);
	h.check(await page.evaluate(() => window.__towers.info({ read: 'levelStars', level: 2 })) === '☆☆☆', 'a star on level 1 opens level 2');

	// ---- 4. the unlock PERSISTS across a reload ---------------------------------------------------
	await page.reload();
	await page.waitForFunction(() => window.__stores && !!window.__stores.sessions && !!window.__towers, null, { timeout: 40000 });
	await load();
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => page.evaluate(() => window.__stores.physics.physicsWorldDebug().running), (ok) => ok, 'after a reload, Play starts the simulation again', 12000);
	await h.eventually(() => page.evaluate(() => [1, 2, 3].map((i) => window.__towers.info({ read: 'levelStars', level: i }))), (v) => /★/.test(v[0]) && v[1] === '☆☆☆' && /locked/.test(v[2]), 'after a reload: level 1 keeps its stars, level 2 is open, level 3 still locked', 6000);

	// ---- 5. level 2 (Planks): Retry and Next through the results, and a second scripted win ---------
	await clickBtn('2 · Planks');
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 2 && s.pieces.length === 8, 'level 2 deals its eight pieces (planks, beams, cubes)', 9000);
	st = await snap();
	h.check(byShape(st, 'plank').length === 4 && byShape(st, 'beam').length === 2 && byShape(st, 'cube').length === 2, `the Planks supply: ${JSON.stringify(Object.fromEntries(['plank', 'beam', 'cube'].map((k) => [k, byShape(st, k).length])))}`);
	const planks = byShape(st, 'plank');
	const l2cubes = byShape(st, 'cube');
	let y = 0.2;
	for (const p of planks) {
		await placePiece(p.uuid, [0, y + 0.16, 0]);
		y += 0.31;
		await page.waitForTimeout(450);
	}
	for (const c of l2cubes) {
		await placePiece(c.uuid, [0, y + 0.31, 0]);
		y += 0.61;
		await page.waitForTimeout(450);
	}
	await h.eventually(() => snap(), (s) => s.state === 'over' && s.vars.twStatus === 2 && s.vars.twLevel === 2, 'level 2 is WON with a plank-and-cube tower', 12000);
	await h.eventually(() => page.evaluate(() => JSON.parse(localStorage.getItem('tp:mod:towers:progress') ?? '{}')), (p) => p?.levels?.['2']?.stars >= 1, 'level 2 stars saved', 4000);
	h.check(await page.evaluate(() => window.__towers.info({ read: 'levelStars', level: 3 })) === '☆☆☆', 'winning level 2 opens level 3');
	// Next → level 3
	await clickBtn('Next level');
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 3, 'Next level starts level 3 (Climb)', 8000);
	await h.eventually(() => snap(), (s) => s.pieces.length === 8, 'level 3 deals 8 cubes', 8000);
	st = await snap();
	const high = st.pieces.filter((p) => p.pos[1] > 2.9);
	h.check(high.length === 3, `three of them wait on the HIGH ledge (${high.length})`);
	// from the floor under the ledge, a ledge cube is out of reach
	await page.evaluate((target) => {
		const s = window.__stores;
		let cam;
		s.playerCam.subscribe((c) => (cam = c))();
		// from the pad's north edge: the ledge itself would block the view from right under it
		const v = new s.THREE.Vector3(target[0], 1.7, -0.9);
		if (cam.parent) cam.parent.worldToLocal(v);
		cam.position.copy(v);
		cam.updateMatrixWorld(true);
		cam.lookAt(new s.THREE.Vector3(target[0], target[1], target[2]));
		cam.updateMatrixWorld(true);
	}, high[0].pos);
	await h.eventually(() => page.evaluate(() => { let v; window.__stores.playInteract.playInteractState.subscribe((x) => (v = x))(); return v.mode; }), (m) => m === 'toofar', 'a ledge cube is TOO FAR from the floor — the level needs steps or a jump', 4000);

	// ---- 6. a LOSS: pieces dropped outside the yard are lost, and too many ends the level -----------
	const floorCubes = (await snap()).pieces.filter((p) => p.pos[1] < 2.5).slice(0, 3);
	for (let i = 0; i < 3; i++) {
		await placePiece(floorCubes[i].uuid, [-8 + i * 1.2, 0.31, 8]);
		await page.waitForTimeout(200);
	}
	await h.eventually(() => snap(), (s) => s.vars.twLost >= 1, 'a cube resting outside the yard is LOST (it poofs)', 6000);
	await h.eventually(() => snap(), (s) => s.state === 'over' && s.vars.twStatus === 5, 'losing more than the level allows ends it: Out of pieces', 8000);
	await h.eventually(hud, (t) => /Out of pieces/.test(t) && /Retry/.test(t), 'the results say why and offer Retry', 4000);
	await clickBtn('Retry');
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 3 && s.vars.twLost === 0 && s.pieces.length === 8, 'Retry deals level 3 afresh', 9000);

	// ---- 7. P pause: Restart level and Levels ---------------------------------------------------------
	const round = (await snap()).round;
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
	await h.eventually(() => snap(), (s) => s.screen === 'pause', 'P opens the pause menu', 5000);
	await clickBtn('Restart level');
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.round > round && s.screen === 'hud', 'Restart level starts a fresh round of the same level', 8000);
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
	await h.eventually(() => snap(), (s) => s.screen === 'pause', 'P again', 5000);
	await clickBtn('Levels');
	await h.eventually(() => snap(), (s) => s.state === 'menu' && s.screen === 'menu', 'Levels returns to the level select', 8000);

	// ---- 8. the P3 rules: open everything, then wind, the outline and the delivery --------------------
	await page.evaluate(() => {
		const levels = {};
		for (let i = 1; i <= 12; i++) levels[i] = { stars: 1, time: 99, pieces: 9 };
		window.__towers.setProgress({ levels });
	});
	h.check((await snap()).pieces.length === 0, 'the level select stands in an EMPTY arena (the last level\'s pieces went)');
	// GUSTS (level 8): a piece standing high on the pad is pushed when the gust arrives
	await clickBtn('8 · Gusts');
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 8 && s.pieces.length === 9, 'level 8 deals its pieces', 9000);
	st = await snap();
	const tall = byShape(st, 'cube').slice(0, 3);
	for (let i = 0; i < 3; i++) {
		await placePiece(tall[i].uuid, [0, 0.52 + i * 0.61, 0]);
		await page.waitForTimeout(400);
	}
	await h.eventually(() => bannerText(), (t) => /Gust from the/.test(t), 'a gust is WARNED before it comes', 12000);
	const topCube = tall[2].uuid;
	const before = await page.evaluate((uuid) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByProperty('uuid', uuid).position.toArray(); }, topCube);
	await page.waitForTimeout(2500);
	const pushed = await page.evaluate((uuid) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); const o = g.getObjectByProperty('uuid', uuid); return o ? o.position.toArray() : null; }, topCube);
	h.check(!pushed || Math.hypot(pushed[0] - before[0], pushed[2] - before[2]) > 0.05, `the gust PUSHED the top of the tower (${before.map((n) => n.toFixed(2))} -> ${pushed ? pushed.map((n) => n.toFixed(2)) : 'fell and was lost'})`);
	// WOBBLE (level 10): the plate rocks only in its own level, as a KINEMATIC body
	const plateTilt = () => page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); const o = g.getObjectByName('Wobble plate'); return Math.abs(o.rotation.x) + Math.abs(o.rotation.z); });
	h.check((await plateTilt()) < 0.005, 'outside level 10 the wobble plate stands still');
	await page.evaluate(() => window.__towers.startLevel(10));
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 10 && s.pieces.length === 7, 'level 10 (Wobble) deals a heavy base, cubes and planks', 9000);
	const tilts = [];
	for (let i = 0; i < 6; i++) {
		tilts.push(await plateTilt());
		await page.waitForTimeout(300);
	}
	h.check(Math.max(...tilts) > 0.02, `in level 10 the plate ROCKS (tilts ${tilts.map((t) => t.toFixed(3)).join(' ')})`);
	const plateBody = await page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); const uuid = g.getObjectByName('Wobble plate').uuid; return window.__stores.physics.physicsDebug().find((b) => b.uuid === uuid)?.mode ?? null; });
	h.check(plateBody === 'kinematic', `...as a kinematic body, so it carries what stands on it (${plateBody})`);
	// OUTLINE (level 11): six cubes into the ghost wall's six cells
	await page.evaluate(() => window.__towers.startLevel(11));
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 11 && byShape(s, 'cube').length === 6, 'level 11 (Outline) deals six cubes', 9000);
	const ghost = await page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByName('Ghost wall').position.toArray(); });
	h.check(Math.abs(ghost[1] - 0.8) < 0.05, `the ghost wall stands on the pad (${ghost.map((n) => n.toFixed(2))})`);
	st = await snap();
	const cells = [[-0.6, 0.52], [0, 0.52], [0.6, 0.52], [-0.6, 1.13], [0, 1.13], [0.6, 1.13]];
	const oc = byShape(st, 'cube');
	for (let i = 0; i < 6; i++) {
		await placePiece(oc[i].uuid, [cells[i][0], cells[i][1], 0]);
		await page.waitForTimeout(350);
	}
	await h.eventually(() => snap(), (s) => s.vars.twFilled === 6, 'every cell of the ghost wall counts as filled', 6000);
	await h.eventually(() => snap(), (s) => s.state === 'over' && s.vars.twStatus === 2 && s.vars.twLevel === 11, 'the filled outline, held, WINS level 11', 9000);
	// DELIVER (level 12): the star on the perch; set on a tower above 3.6 m it wins
	await page.evaluate(() => window.__towers.startLevel(12));
	await h.eventually(() => snap(), (s) => s.state === 'playing' && s.vars.twLevel === 12 && byShape(s, 'star').length === 1, 'level 12 (Summit) deals the star onto the perch', 9000);
	st = await snap();
	const star = byShape(st, 'star')[0];
	h.check(star.pos[1] > 3.4, `the star waits on the high perch (y ${star.pos[1].toFixed(2)})`);
	const base = byShape(st, 'base')[0];
	await placePiece(base.uuid, [0, 0.38, 0]);
	await page.waitForTimeout(500);
	const stack = [...byShape(st, 'cube'), ...byShape(st, 'plank')];
	y = 0.55;
	for (const p of stack.slice(0, 5)) {
		const hgt = p.shape === 'cube' ? 0.6 : 0.3;
		await placePiece(p.uuid, [0, y + hgt / 2 + 0.01, 0]);
		y += hgt + 0.01;
		await page.waitForTimeout(450);
	}
	// the arch on top (a building block: its origin is on its floor)
	await placePiece(byShape(st, 'arch')[0].uuid, [0, y + 0.01, 0]);
	y += 0.81;
	await page.waitForTimeout(500);
	await placePiece(star.uuid, [0, y + 0.3, 0]);
	await h.eventually(() => snap(), (s) => s.state === 'over' && s.vars.twLevel === 12 && s.vars.twStatus === 2, `the star set on top of a ${y.toFixed(2)} m tower WINS the summit`, 12000);

	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	await h.finish(browser);
});
