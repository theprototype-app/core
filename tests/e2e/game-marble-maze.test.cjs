// 35 MARBLE MAZE — the template loaded from its authored .tpscene, played through the real
// surfaces: the menu, Start, the tilt rolling the marble, a hole sending it back, a scripted
// win of maze 1 (results + stars), and a VR-emulated run (fake XR session: both grips on the
// handles twist the board). Skip-never-fail when no authored scene is found.
//   MARBLE_TPSCENE=<path to scene.tpscene>  (default: the lane staging dir, then the scenes checkout)
//   SHOTS=<dir> writes two screenshots (menu + a run)
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
// the def's solution paths (board-local x/z per cell, start -> goal): the autopilot rolls them
const PATHS = require('../../scripts/templates/marble-maze.cjs').solutionPaths;

/** roll the marble along `path` by TILTING the board (a PD controller through the module's tilt
 * input — real physics, no teleport); resolves when the maze is won or `limit` ms pass */
const autopilot = (page, path, limit) =>
	page.evaluate(
		async ({ path, limit }) => {
			const M = window.__marble;
			const MAX = 0.26;
			let i = 1;
			let last = M.marbleLocal();
			const t0 = performance.now();
			try {
				while (performance.now() - t0 < limit) {
					await new Promise((res) => setTimeout(res, 30));
					if (M.vars().mmStatus === 2) return { won: true, t: (performance.now() - t0) / 1000 };
					const p = M.marbleLocal();
					if (!p) continue;
					const vx = (p[0] - last[0]) / 0.03;
					const vz = (p[2] - last[2]) / 0.03;
					last = p;
					const [tx, tz] = path[Math.min(i, path.length - 1)];
					const dx = tx - p[0];
					const dz = tz - p[2];
					if (Math.hypot(dx, dz) < 0.035 && i < path.length - 1) i++;
					M.setTilt(Math.max(-MAX, Math.min(MAX, 2.2 * dz - 0.9 * vz)), Math.max(-MAX, Math.min(MAX, -(2.2 * dx - 0.9 * vx))));
				}
				return { won: false, i, p: M.marbleLocal() };
			} finally {
				M.setTilt(0, 0);
			}
		},
		{ path, limit }
	);

const CANDIDATES = [
	process.env.MARBLE_TPSCENE,
	'/home/deck/.code/theprototype-app/cloud-lane-30-staging/35-marble-maze/games/marble-maze/scene.tpscene',
	process.env.SCENES_REPO && path.join(process.env.SCENES_REPO, 'games/marble-maze/scene.tpscene')
].filter(Boolean);

(async () => {
	const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));
	if (!TPSCENE) {
		console.log('SKIP: no authored marble-maze scene.tpscene (author it: node scripts/author-templates.cjs --only marble-maze --out <dir>)');
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
	await page.evaluate(() => window.__marble.resetProgress());

	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			const group = g(s.objectsGroup);
			const m = group.getObjectByName('Marble');
			return {
				names: group.children.map((c) => c.name),
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null,
				vars: window.__marble.vars(),
				local: window.__marble.marbleLocal(),
				world: m ? m.position.toArray() : null,
				visibleMazes: group.children.filter((c) => /^Maze \d$/.test(c.name) && c.visible).map((c) => c.name),
				collider: group.getObjectByName('Maze 1')?.userData?.physics?.colliderPieces?.length ?? 0
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';

	// 1 — the scene: marker, five mazes with compound colliders, the marble, the gates
	let st = await snap();
	const need = ['Marble Maze game', 'Marble', 'Maze 1', 'Maze 2', 'Maze 3', 'Maze 4', 'Maze 5', 'Gate 4.1', 'Gate 5.3', 'Card camera'];
	h.check(need.every((n) => st.names.includes(n)), `the scene: marker, five mazes, marble, gates (${need.filter((n) => !st.names.includes(n)).join(', ') || 'all present'})`);
	h.check(st.collider > 10 && st.collider <= 50, `maze 1 collides as a compound of boxes (${st.collider})`);
	h.check(st.state === 'menu', `starts on the menu (${st.state})`);
	await h.eventually(snap, (v) => v.visibleMazes.length === 1 && v.visibleMazes[0] === 'Maze 1', 'only maze 1 is drawn in the menu', 6000);

	// 2 — Play: the menu, How to play, Start
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim', 10000);
	await h.eventually(hud, (t) => /MARBLE MAZE/.test(t) && /1 · First roll/.test(t) && /5 · The gauntlet/.test(t), 'the menu lists five mazes', 6000);
	h.check(/WASD/.test(await hud()) && /grip both handles/.test(await hud()), 'the menu says how to play on a desktop and in VR');
	if (process.env.SHOTS) {
		fs.mkdirSync(process.env.SHOTS, { recursive: true });
		await page.screenshot({ path: path.join(process.env.SHOTS, 'menu.png') });
	}
	await page.locator('#hud-layer button', { hasText: 'Start' }).first().click();
	await h.eventually(snap, (v) => v.state === 'playing' && v.vars.mmLevel === 1 && v.vars.mmStatus === 1, 'Start runs maze 1', 6000);
	await page.waitForTimeout(1500);
	st = await snap();
	h.check(st.local && Math.abs(st.local[1]) < 0.06, `the marble sits on the board (local ${st.local?.map((n) => n.toFixed(3))})`);
	const eye = await page.evaluate(() => window.__marble.eye());
	h.check(eye && Math.abs(eye[1] - 1.82) < 0.1 && Math.abs(eye[2] + 0.13) < 0.1, `desktop: the eye stands over the board (${eye?.map((n) => n.toFixed(2))})`);
	await h.eventually(hud, (t) => /Maze 1 · First roll/.test(t) && /Coins 0 \/ 3/.test(t), 'the HUD names the maze and the coins', 4000);

	// the draw calls while a maze runs: every VISIBLE mesh in the scene is at most one call
	// (renderer.info resets per composer pass, so it reads the last pass only)
	const calls = await page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		let n = 0;
		const walk = (o) => {
			if (!o.visible) return;
			if (o.isMesh || o.isInstancedMesh || o.isPoints || o.isLine) n++;
			for (const c of o.children) walk(c);
		};
		walk(scene);
		return n;
	});
	h.check(calls > 0 && calls <= 150, `visible meshes while a maze runs: ${calls} (<= 150 draw calls)`);

	// 3 — the tilt rolls the marble (desktop keys)
	const before = (await snap()).local;
	await page.keyboard.down('KeyD');
	await page.waitForTimeout(700);
	await page.keyboard.up('KeyD');
	const tilt = await page.evaluate(() => window.__marble.tilt());
	await page.waitForTimeout(400);
	const after = (await snap()).local;
	h.check(Math.abs(after[0] - before[0]) > 0.02 || Math.abs(after[2] - before[2]) > 0.02, `holding D tilts the board and the marble rolls (tilt z ${tilt.z.toFixed(3)}, moved ${(after[0] - before[0]).toFixed(3)})`);
	h.check(tilt.z < -0.05, `D lowers the right side (tilt z ${tilt.z.toFixed(3)})`);
	if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'play.png') });

	// 4 — a scripted win of maze 1 (the coins marked taken, then a real roll): results, stars, Next
	await page.evaluate(() => window.__marble.takeCoins());
	const run = await autopilot(page, PATHS[0], 40000);
	h.check(run.won, `TILTING the board rolls the marble through maze 1 to the goal — real physics (${JSON.stringify(run)})`);
	await h.eventually(snap, (v) => v.state === 'over' && v.vars.mmStatus === 2, 'reaching the goal wins the maze', 6000);
	st = await snap();
	h.check(st.vars.mmStars >= 2, `three coins + the goal: at least two stars (${st.vars.mmStars})`);
	await h.eventually(hud, (t) => /Maze 1 cleared!/.test(t) && /Next maze/.test(t), 'the results screen: cleared + Next maze', 4000);
	await page.locator('#hud-layer button', { hasText: 'Next maze' }).first().click();
	await h.eventually(snap, (v) => v.state === 'playing' && v.vars.mmLevel === 2, 'Next maze runs maze 2 (unlocked by the win)', 6000);
	await h.eventually(snap, (v) => v.visibleMazes.length === 1 && v.visibleMazes[0] === 'Maze 2', 'maze 2 is the one on the board', 4000);

	// 5 — VR: a fake session, both grips on the handles; lowering the right hand rolls the board
	await page.evaluate(() => window.__stores.isVRMode.set(true));
	await xr.install(page);
	// headless XR never PRESENTS, so the SDK's vrHand answers null: read the same controller
	// matrices + the fake gamepads the way handSnapshot does
	await page.evaluate(() =>
		window.__marble.setHandSource((hand) => {
			const { renderer, sources } = window.__fakeXR;
			const THREE = window.__stores.THREE;
			const c = renderer.xr.getController(hand === 'left' ? 0 : 1);
			const p = c.getWorldPosition(new THREE.Vector3());
			const q = c.getWorldQuaternion(new THREE.Quaternion());
			const src = sources.find((s) => s.handedness === hand);
			return { position: p.toArray(), quaternion: q.toArray(), gripped: !!src.gamepad.buttons[1].pressed, trigger: false, connected: true };
		})
	);
	const B = [0, 1.1, -0.75];
	await xr.pose(page, 'left', [B[0] - 0.55, B[1], B[2]]);
	await xr.pose(page, 'right', [B[0] + 0.55, B[1], B[2]]);
	await page.waitForTimeout(300);
	await xr.button(page, 'left', 1, true);
	await xr.button(page, 'right', 1, true);
	await page.waitForTimeout(300);
	await xr.pose(page, 'right', [B[0] + 0.55, B[1] - 0.12, B[2]]);
	await xr.pose(page, 'left', [B[0] - 0.55, B[1] + 0.12, B[2]]);
	await h.eventually(() => page.evaluate(() => window.__marble.tilt().z), (z) => z < -0.1, 'VR: both grips + a twist roll the board right side down', 4000);
	await xr.button(page, 'left', 1, false);
	await xr.button(page, 'right', 1, false);
	await h.eventually(() => page.evaluate(() => window.__marble.tilt().z), (z) => Math.abs(z) < 0.03, 'VR: letting go levels the board', 4000);
	await page.evaluate(() => window.__marble.setHandSource(null));
	await xr.uninstall(page);
	await page.evaluate(() => window.__stores.isVRMode.set(false));

	// 6 — a hole: the marble over it drops through and comes back on the start, a fall counted
	h.check((await page.evaluate(() => window.__marble.holes().length)) === 2, 'maze 2 has two holes the module judges');
	await page.evaluate(() => window.__marble.toHole(0));
	await h.eventually(snap, (v) => v.vars.mmFalls >= 1, 'the marble over a hole falls (counted)', 4000);
	await h.eventually(snap, (v) => v.local && v.local[1] > -0.02 && v.local[0] < -0.25 && v.local[2] > 0.25, 'and is back on the start pad', 4000);

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
})();
