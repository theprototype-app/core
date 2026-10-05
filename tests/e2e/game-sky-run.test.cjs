// 35-sky-obby ACCEPTANCE — the Sky Run game template, loaded from its REAL authored .tpscene
// (SKY_RUN_TPSCENE=<path>, else the lane's staging folder, else the sibling scenes checkout) and
// driven through the real surfaces: the start menu, Play, a scripted run of stage 1 (a coin, a
// checkpoint flag, a fall back to that flag, the portal -> the round is won and the best time is
// saved) and the VR board pressing a stage button through the real trigger hook. Skip-never-fail
// when no authored scene is found. §6 is the U10 ACCEPTANCE PROBE (36-games-graphs): the rules are the
// "Sky Run rules" node on Main — fall depth from the ⓘ panel, a stage name from the code view, both felt in
// Play and kept by a reload.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.SKY_RUN_TPSCENE,
	path.resolve(__dirname, '../../../cloud-lane-30-staging/36-games-graphs/games/sky-run/scene.tpscene'),
	path.resolve(__dirname, '../../../cloud-lane-30-staging/35-sky-obby/games/sky-run/scene.tpscene'),
	path.resolve(__dirname, '../../../scenes/games/sky-run/scene.tpscene'),
	path.resolve(__dirname, '../../../theprototype.app-scenes/games/sky-run/scene.tpscene')
].filter(Boolean);
const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no authored games/sky-run/scene.tpscene (set SKY_RUN_TPSCENE)');
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
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null,
				phase: window.__skyrun?.phase() ?? null,
				stage: window.__skyrun?.stage() ?? null
			};
		});
	const run = () => page.evaluate(() => window.__skyrun.run());
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';

	console.log('\n=== 1. the course ===');
	let st = await snap();
	h.check(st.names.includes('Sky Run game'), 'the marker that wakes the skyrun module is in the scene');
	for (const s of [1, 2, 3]) {
		const need = ['Sky S' + s + ' start', 'Sky S' + s + ' portal', 'Sky S' + s + ' flag 1', 'Sky S' + s + ' coin 1'];
		h.check(need.every((n) => st.names.includes(n)), `stage ${s}: start pad, flag, coin, portal (${need.filter((n) => !st.names.includes(n)).join(', ') || 'all present'})`);
	}
	h.check(st.names.some((n) => /spinner/.test(n)) && st.names.some((n) => /tile/.test(n)) && st.names.some((n) => /slider/.test(n)), 'spinners, vanishing tiles and moving platforms are there');
	const meshes = await page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let n = 0;
		g.traverse((o) => { if (o.isMesh) n++; });
		return n;
	});
	h.check(meshes <= 110, `a small scene: ${meshes} meshes (draw-call budget 150)`);
	h.check(st.play?.simOnPlay === true && st.state === 'menu' && st.screen === 'menu', `starts on the menu, sim on play (${st.state}/${st.screen})`);
	// the movers are KINEMATIC-by-effect and run off the synced clock: a slider moves
	const slide = await page.evaluate(async () => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByName('Sky S1 slider');
		// sample across half its period: two samples 700 ms apart can straddle the sine's turn
		const xs = [];
		for (let i = 0; i < 9; i++) {
			xs.push(o.position.x);
			await new Promise((r) => setTimeout(r, 250));
		}
		return [Math.min(...xs), Math.max(...xs)];
	});
	h.check(slide[1] - slide[0] > 0.2, `the stage 1 slider moves (range ${slide.map((n) => n.toFixed(2))})`);

	console.log('\n=== 2. Play: the menu, the body, the music ===');
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim (the crate is a dynamic body)', 10000);
	const body = await page.evaluate(() => window.__stores.charController.charControllerDebug().control);
	h.check(body?.mode === 'walk' && body.jumpHeight === 1.3 && body.gravity, `the player WALKS and JUMPS 1.3 m (${JSON.stringify(body)})`);
	await h.eventually(hud, (t) => /SKY RUN/.test(t) && /1 · Cloud Steps/.test(t) && /3 · Sky Gauntlet/.test(t), 'the start menu renders three stages', 6000);
	h.check(/Space jumps/.test(await hud()) && /A jumps/.test(await hud()), 'the menu says how to play on a desktop and in VR');
	const eye0 = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		return cam.getWorldPosition(new s.THREE.Vector3()).toArray().map((n) => +n.toFixed(2));
	});
	const vignette = await page.evaluate(() => { let v; window.__stores.gameKit.gameSettings?.gameSettingValues?.subscribe((x) => (v = x))(); return v?.vignette ?? null; });
	h.check(vignette === true, `the comfort vignette defaults ON for this game (${vignette})`);
	h.check(eye0[1] > 12.5 && Math.abs(eye0[0]) < 3, `Play put the player on stage 1's start pad, up in the sky (${eye0})`);

	console.log('\n=== 3. a scripted run of stage 1 ===');
	await page.locator('#hud-layer button', { hasText: '1 · Cloud Steps' }).first().click();
	await h.eventually(() => snap().then((v) => v.phase), (v) => v === 'playing', 'the Stage 1 button starts the round (intro, then playing)', 10000);
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'the in-game HUD shows', 4000);
	await h.eventually(hud, (t) => /Stage 1 · Cloud Steps/.test(t) && /Coins 0 \/ 5/.test(t), 'the HUD: stage title, coins 0 / 5', 4000);
	// a coin: stand on the first step, under it
	await page.evaluate(() => window.__skyrun.teleportTo('Sky S1 step 1'));
	await h.eventually(() => run().then((r) => r.coins), (n) => n === 1, 'standing under a coin collects it', 4000);
	const hidden = await page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByName('Sky S1 coin 1').visible;
	});
	h.check(hidden === false, 'the collected coin hides (for its collector)');
	// the flag
	await page.evaluate(() => window.__skyrun.teleportTo('Sky S1 rest'));
	await h.eventually(() => run().then((r) => r.flag), (n) => n === 1, 'touching the flag saves checkpoint 1', 4000);
	// a moving platform carries a player who stands still on it
	await page.evaluate(() => window.__skyrun.teleportTo('Sky S1 slider'));
	await page.waitForTimeout(300);
	// a 1.5 s window can sit on the slider's turn (it barely moves there): measure up to three windows
	const rideOnce = () => page.evaluate(async () => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		let g; s.objectsGroup.subscribe((v) => (g = v))();
		const sl = g.getObjectByName('Sky S1 slider');
		const read = () => ({ eye: cam.getWorldPosition(new s.THREE.Vector3()).x, pad: sl.getWorldPosition(new s.THREE.Vector3()).x });
		const a = read();
		await new Promise((r) => setTimeout(r, 1500));
		const b = read();
		return { padMoved: b.pad - a.pad, eyeMoved: b.eye - a.eye, onIt: Math.abs(b.eye - b.pad), y: cam.getWorldPosition(new s.THREE.Vector3()).y };
	});
	let ride = await rideOnce();
	for (let k = 0; k < 2 && Math.abs(ride.padMoved) <= 0.2; k++) ride = await rideOnce();
	h.check(Math.abs(ride.padMoved) > 0.2 && Math.sign(ride.eyeMoved) === Math.sign(ride.padMoved) && ride.onIt < 1.2 && ride.y > 13.5, `standing still on the slider rides it (${JSON.stringify(ride)})`);
	// a fall: step off into the sky -> back on the flag
	await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		// a peer's spawn is what a teleport lands on; put the player in thin air beside the course
		const k = window.__skyrun;
		const cp = k.run().checkpoint;
		s.playSettings.setRuntimeSpawn([12, 12, -18], 0, 'test');
		s.playSpawn.spawnDesktopPlayer(s.playSpawn.desktopSpawn());
		window.__fallFrom = cp;
	});
	await h.eventually(() => run().then((r) => r.falls), (n) => n >= 1, 'falling off the course is caught', 8000);
	const back = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		return cam.getWorldPosition(new s.THREE.Vector3()).toArray().map((n) => +n.toFixed(2));
	});
	h.check(Math.abs(back[2] - -17.7) < 1.5 && Math.abs(back[0]) < 0.5 && back[1] > 13, `and puts you back on the flag (${back})`);
	const stockDrop = (await run()).fallDrop; // §6's baseline: how far under the pad the stock depth catches you
	// the portal
	await page.evaluate(() => window.__skyrun.teleportTo('Sky S1 finish'));
	await h.eventually(() => snap().then((v) => v.state + '/' + v.screen), (v) => v === 'over/over', 'reaching the portal wins the round: the results screen', 8000);
	const r = await run();
	h.check(r.finished > 0 && /Stage 1 cleared/.test(r.result), `the result names the stage and a time (${r.result} · ${r.resultLine})`);
	await h.eventually(hud, (t) => /Stage 1 cleared/.test(t) && /Next stage/.test(t) && /Retry/.test(t), 'the results screen: the result, Next stage, Retry', 4000);
	const best = await page.evaluate(() => window.__skyrun.info({ read: 'stageBest', level: '1' }));
	h.check(/best \d+:\d\d\.\d/.test(best), `the best time is saved on this device (${best})`);
	await page.waitForTimeout(500);
	await page.screenshot({ path: '/home/deck/.code/lanes-30/after-35/sky-run/results.png' }).catch(() => {});
	// no editor helper in Play
	const helpers = await page.evaluate(() => {
		let sc; window.__stores.globalScene.subscribe((v) => (sc = v))();
		const seen = [];
		sc.traverse((o) => { if (o.visible && /helper|grid/i.test(o.name ?? '') && o.parent === sc) seen.push(o.name); });
		return seen;
	});
	h.check(!helpers.includes('editor-grid'), `no editor grid in Play (${helpers.join(', ') || 'none'})`);

	console.log('\n=== 4. a stage in progress, the frame ===');
	await page.locator('#hud-layer button', { hasText: 'Retry' }).first().click();
	await h.eventually(() => snap().then((v) => v.phase), (v) => v === 'playing', 'Retry runs the stage again', 10000);
	const fresh = await run();
	h.check(fresh.coins === 0 && fresh.flag === 0 && !fresh.finished, `a fresh run: coins and checkpoint reset (${fresh.coins}/${fresh.flag})`);
	await page.waitForTimeout(600);
	await page.screenshot({ path: '/home/deck/.code/lanes-30/after-35/sky-run/play.png' }).catch(() => {});
	// finish again, then Next stage: stage 2 starts and the player stands on ITS start pad
	await page.evaluate(() => window.__skyrun.teleportTo('Sky S1 finish'));
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'over', 'the portal ends the round again', 8000);
	await page.locator('#hud-layer button', { hasText: 'Next stage' }).first().click();
	await h.eventually(() => snap().then((v) => v.stage + '/' + v.phase), (v) => v === '2/playing', 'Next stage runs stage 2', 10000);
	const eye2 = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		return cam.getWorldPosition(new s.THREE.Vector3()).toArray().map((n) => +n.toFixed(2));
	});
	h.check(Math.abs(eye2[0] - 30) < 3 && eye2[1] > 12.5, `and the player stands on stage 2's start pad (${eye2})`);
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(800);

	console.log('\n=== 5. VR: the board presses a stage button through the real trigger hook ===');
	await page.evaluate(() => {
		const s = window.__stores;
		s.gameState.setGameState('menu');
		s.objectActions.setEditorMode('interact');
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		for (const i of [0, 1]) {
			const c = r.xr.getController(i);
			c.matrixAutoUpdate = true;
			c.userData.handedness = i === 0 ? 'left' : 'right';
		}
		window.__T = {
			head: () => ({ position: new s.THREE.Vector3(0, 13.7, 1.8), quaternion: new s.THREE.Quaternion() }),
			rectPoint: (surfaceName, id) => {
				const k = s.gameKit.vrGamePanel;
				const surf = k.vrGameSurface(surfaceName);
				const rect = k.vrGamePanelDebug().hits[surfaceName].find((x) => x.id === id);
				if (!surf || !rect) return null;
				const g = surf.mesh.geometry.parameters;
				const cx = (rect.x + rect.w / 2) / surf.canvas.width;
				const cy = (rect.y + rect.h / 2) / surf.canvas.height;
				return surf.mesh.localToWorld(new s.THREE.Vector3((cx - 0.5) * g.width, (0.5 - cy) * g.height, 0));
			},
			aim: (index, from, to) => {
				const c = r.xr.getController(index);
				c.position.copy(from);
				c.lookAt(from.clone().multiplyScalar(2).sub(to));
				c.updateMatrixWorld(true);
			}
		};
	});
	await h.eventually(() => snap().then((v) => v.phase), (v) => v === 'menu', 'back on the menu', 6000);
	const ids = await page.evaluate(() => {
		const k = window.__stores.gameKit.vrGamePanel;
		for (let i = 0; i < 3; i++) k.vrGamePanelFrame({ head: window.__T.head(), hands: [null, null], dt: 1 / 72 });
		return (k.vrGamePanelDebug().hits['vr-game-panel'] ?? []).map((x) => x.id);
	});
	h.check(['stage-1', 'stage-2', 'stage-3'].every((i) => ids.includes(i)), `the VR board carries the three stage buttons (${ids.join(', ')})`);
	await page.waitForTimeout(700);
	const press = await page.evaluate(async () => {
		const s = window.__stores;
		const T = window.__T;
		const target = T.rectPoint('vr-game-panel', 'stage-2');
		T.aim(1, new s.THREE.Vector3(0.25, 13.4, 1.5), target);
		const hover = s.gameKit.vrGamePanel.panelHover(1, s.gameKit.vrGameInput.controllerRayOf(1))?.hit.id ?? null;
		const consumed = s.vrControls.vrModuleTriggerStart(1);
		await new Promise((r) => setTimeout(r, 600));
		s.vrControls.vrModuleTriggerEnd(1);
		return { hover, consumed };
	});
	h.check(press.hover === 'stage-2' && press.consumed === true, `the laser hovers and the trigger presses Stage 2 (${JSON.stringify(press)})`);
	await h.eventually(() => snap().then((v) => v.stage + '/' + v.phase), (v) => v === '2/intro' || v === '2/playing', 'stage 2 starts from the VR board', 8000);
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));

	console.log('\n=== 6. THE U10 PROBE: fall depth from the GRAPH, a stage name from the CODE; felt in Play, kept by a reload ===');
	const rid = await page.evaluate(() => window.__skyrun?.rulesNode?.() ?? null);
	h.check(!!rid, `premise: the Main graph carries the Sky Run rules node (${rid})`);
	await h.eventually(() => page.evaluate((id) => window.__stores.behaviours.behavioursDebug().status[id]?.status, rid), (st) => st === 'running', 'the Sky Run rules behaviour is running', 10000);
	h.check(stockDrop > 5.5 && stockDrop < 8.5, `premise: at the stock fall depth a fall is caught ~7 m under the start pad (${stockDrop})`);
	const codeNow = () => page.evaluate((id) => { let g; window.__stores.flowGraphs.subscribe((v) => (g = v))(); return g.scene.nodes.find((n) => n.id === id)?.data?.code ?? ''; }, rid);
	// (a) the GRAPH: select the rules node, the ⓘ tab, Fall depth 7 -> 2
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(600);
	if (!(await page.evaluate(() => !!document.querySelector('.svelte-flow__pane')))) await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1000);
	await page.evaluate(() => window.__stores.bottomDock?.dockHeight?.set(600));
	if (!(await page.locator('#flow-props').count())) await page.locator('#flow-props-toggle').click();
	await page.locator('#flow-tab-info').click();
	await page.evaluate((id) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === id }))), rid);
	await h.eventually(() => page.locator('#flow-prop-fallDepth').count(), (n) => n === 1, 'the rules node shows Fall depth in its properties panel', 6000);
	await page.locator('#flow-prop-fallDepth').fill('2');
	await page.locator('#flow-prop-fallDepth').press('Enter');
	await h.eventually(codeNow, (c) => /fallDepth:\s*\{\s*value:\s*2\b/.test(c), 'the knob rewrote the literal in the rules source (fallDepth: 2)', 4000);
	// (b) the CODE: open the rules in the code workspace and rename stage 1
	await page.evaluate((id) => {
		let ns;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		const n = ns.find((x) => x.id === id);
		window.__flowViewport?.setViewport({ x: -n.position.x + 300, y: -n.position.y + 60, zoom: 1 });
	}, rid);
	await page.waitForTimeout(600);
	const box = await page.locator(`.svelte-flow__node[data-id="${rid}"]`).boundingBox().catch(() => null);
	if (box) await page.mouse.dblclick(box.x + box.width / 2, box.y + 8);
	else await page.evaluate((id) => window.__stores.codeWorkspace.openCode({ source: 'behaviour', ref: { nodeId: id } }), rid);
	await h.eventually(() => page.locator('[data-pane] .cm-content').count(), (n) => n >= 1, 'double-click opens the rules in the code workspace', 15000);
	const edited = (await codeNow()).replace("{ id: '1', name: 'Cloud Steps', par: 45 }", "{ id: '1', name: 'Puff Steps', par: 45 }");
	const paneId = await page.evaluate(() => { let v; window.__stores.codeWorkspace.activeCodeTab.subscribe((x) => (v = x))(); return v; });
	await page.locator(`[data-pane="${paneId}"] .cm-content`).click();
	await page.keyboard.press('Control+A');
	await page.keyboard.insertText(edited);
	await page.keyboard.press('Control+S');
	await h.eventually(codeNow, (c) => /name: 'Puff Steps'/.test(c), "Ctrl+S saved the code onto the node (stage 1 is 'Puff Steps')", 6000);
	await page.locator('#code-ws-close').click().catch(() => {});
	await h.eventually(() => page.evaluate((id) => window.__stores.behaviours.behavioursDebug().status[id]?.status, rid), (st) => st === 'running', 'the edited rules reloaded and run', 8000);
	/** stage 1 from the menu, the HUD title (the code change), then a fall (the graph change) */
	const feel = async (when) => {
		await page.evaluate(() => window.__stores.isLocked.set(true));
		await page.waitForTimeout(800);
		await page.evaluate(() => window.__stores.gameState.setGameState('menu'));
		await h.eventually(hud, (t) => /Cloud Steps|Puff Steps|1 ·/.test(t), `${when}: the start menu`, 8000);
		await page.locator('#hud-layer button', { hasText: /^\s*1 ·/ }).first().click();
		await h.eventually(() => snap().then((v) => v.stage + '/' + v.phase), (v) => v === '1/playing', `${when}: stage 1 runs`, 12000);
		await h.eventually(() => page.evaluate(() => window.__skyrun.info({ read: 'title' })), (t) => t === 'Stage 1 · Puff Steps', `${when}: the HUD title reads 'Stage 1 · Puff Steps' — the code change`, 4000);
		await page.evaluate(() => {
			const s = window.__stores;
			s.playSettings.setRuntimeSpawn([12, 12, -18], 0, 'test');
			s.playSpawn.spawnDesktopPlayer(s.playSpawn.desktopSpawn());
		});
		await h.eventually(() => run().then((r) => r.falls), (n) => n >= 1, `${when}: a fall is caught`, 8000);
		const drop = (await run()).fallDrop;
		h.check(drop > 1 && drop < 3.5, `${when}: … ~2 m under the start pad instead of ~7 — the graph change (${drop})`);
	};
	await feel('Play');
	// (c) both survive a save and a reload
	const saved = await page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('Sky Run probe');
		const zip = await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		return Array.from(zip);
	});
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(600);
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		s.flowGraphs.set({ scene: { nodes: [], edges: [] } });
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, saved);
	await page.waitForTimeout(2500);
	const reloaded = await codeNow();
	h.check(/fallDepth:\s*\{\s*value:\s*2\b/.test(reloaded) && /name: 'Puff Steps'/.test(reloaded), "after a save and a reload the rules keep fall depth 2 and 'Puff Steps'");
	await h.eventually(() => page.evaluate(() => window.__stores.behaviours.behavioursDebug().status[window.__skyrun.rulesNode()]?.status), (st) => st === 'running', 'the reloaded rules run', 10000);
	await feel('Play after the reload');
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	await h.finish(browser);
});
