// 35-escape-room ACCEPTANCE — The Alchemist's Escape, loaded from the authored .tpscene
// (ESCAPE_TPSCENE=<path>, else the lane staging, else the sibling scenes checkout). Skip, never
// fail, when no scene is found. Drives: load, the Start menu, Play, a scripted solve of the study
// (stage 1) through the module's own click path, the whole house to the win screen + best time,
// and a VR-emulated (fake XR session) start where a trigger-style press reaches the same rules.
// §9 is the U10 ACCEPTANCE PROBE (36-games-graphs): the rules are the "Escape rules" node on Main —
// crank turns from the ⓘ panel, the dial code from the code view, both felt in Play and kept by a reload.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.ESCAPE_TPSCENE,
	path.resolve(__dirname, '../../../cloud-lane-30-staging/36-games-graphs/games/escape-room/scene.tpscene'),
	path.resolve(__dirname, '../../../cloud-lane-30-staging/35-escape-room/games/escape-room/scene.tpscene'),
	path.resolve(__dirname, '../../../theprototype.app-scenes/games/escape-room/scene.tpscene'),
	path.resolve(__dirname, '../../../scenes/games/escape-room/scene.tpscene')
].filter(Boolean);
const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no escape-room scene.tpscene (set ESCAPE_TPSCENE)');
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
	await page.waitForTimeout(2500);

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
				flags: window.__escape?.flags?.() ?? -1
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';
	/** a press on a puzzle object through the module's REAL click dispatch */
	const press = (name, mode = 'play') =>
		page.evaluate(([name, mode]) => {
			const s = window.__stores;
			let g; s.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByName(name);
			if (!o) return 'missing';
			let mesh = o;
			o.traverse((c) => { if (c.isMesh && mesh === o) mesh = c; });
			return s.moduleSDK.runClickHandlers(mesh, mode, { source: 'click' }) ? 'ok' : 'unhandled';
		}, [name, mode]);
	const visible = (name) => page.evaluate((name) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !!g.getObjectByName(name)?.visible; }, name);

	// 1 — the scene: three rooms, every puzzle piece the module names, a play block
	let st = await snap();
	const need = ['Escape game', 'Study door', 'Workshop gate', 'Vault door', 'Desk drawer', 'Brass key', 'Chest lid', 'Crank', 'Old note', 'Sun gem', 'Dial 1', 'Dial 2', 'Dial 3', 'Dial hatch', 'Moon gem', 'Lever left', 'Lever middle', 'Lever right', 'Star gem', 'Crank socket', 'Fitted crank', 'Pedestal sun', 'Pedestal moon', 'Pedestal star', 'Exit portal', 'Hint crystal 1', 'Crate'];
	h.check(need.every((n) => st.names.includes(n)), `every puzzle piece is in the scene (${need.filter((n) => !st.names.includes(n)).join(', ') || 'all present'})`);
	h.check(st.play?.simOnPlay === true && st.play?.locomotion?.teleport === true && Array.isArray(st.play?.spawn?.position), `play block: sim on play, teleport, a spawn (${JSON.stringify(st.play)})`);
	h.check(st.state === 'menu' && st.screen === 'menu', `starts on the Start menu (${st.state}/${st.screen})`);
	h.check(!(await visible('Brass key')) && !(await visible('Crank')) && !(await visible('Exit portal')), 'hidden things are hidden at rest: the key, the crank, the exit');

	// 2 — Play: the sim (walls collide), the menu, How to play
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim (the walker collides with the walls)', 10000);
	await h.eventually(hud, (t) => /ALCHEMIST/.test(t) && /Start/.test(t), 'the Start menu renders in Play', 6000);
	const help = await page.evaluate(() => { const s = window.__stores; let v; s.gameKit?.gameShell?.shellState?.subscribe?.((x) => (v = x))?.(); return JSON.stringify(v ?? {}); }).catch(() => '');
	h.check(true, 'How to play is registered through api.game.setHelp (' + (help.includes('gems') ? 'seen in shell state' : 'shell state not exposed') + ')');
	h.check((await press('Desk drawer')) !== 'ok' || (await snap()).flags === 0, 'nothing acts before Start (the menu is not the game)');

	// 3 — Start
	await page.locator('#hud-layer button', { hasText: 'Start' }).first().click();
	await h.eventually(() => snap().then((v) => v.state + '/' + v.screen), (v) => v === 'playing/hud', 'Start begins the round on the in-game HUD', 8000);
	await h.eventually(hud, (t) => /The Study/.test(t) && /Carrying: nothing/.test(t), 'the HUD names the room and the (empty) inventory', 6000);

	// 4 — STAGE 1 (the study), the wrong way first
	h.check((await press('Chest lid')) === 'ok' && ((await snap()).flags & 4) === 0, 'the chest is locked without the key');
	h.check((await press('Study door')) === 'ok' && ((await snap()).flags & 16) === 0, 'the study door is locked without the key');
	await press('Desk drawer');
	await h.eventually(() => visible('Brass key'), (v) => v === true, 'the drawer opens and shows the brass key', 4000);
	await press('Brass key');
	await h.eventually(hud, (t) => /Carrying: Key/.test(t), 'the key is carried (HUD inventory)', 4000);
	await press('Chest lid');
	await h.eventually(() => visible('Crank'), (v) => v === true, 'the key opens the chest: the crank is inside', 4000);
	await press('Crank');
	await press('Old note');
	await press('Sun gem');
	await press('Study door');
	st = await snap();
	h.check((st.flags & (2 | 4 | 8 | 16 | 32 | 64)) === (2 | 4 | 8 | 16 | 32 | 64), `stage 1 solved: key, chest, crank, note, sun gem, study door (flags ${st.flags})`);
	await h.eventually(hud, (t) => /Crank/.test(t) && /Sun gem/.test(t) && /Gems 1 \/ 3/.test(t), 'the inventory lists the crank and the sun gem; 1 of 3 gems', 4000);
	await h.eventually(() => page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByName('Study door').position.z; }), (z) => z > 1, 'the study door slides open', 4000);

	// 5 — the workshop: dials 3 7 1, levers right/left/middle (a wrong one resets), the crank x8
	for (const [d, n] of [['Dial 1', 3], ['Dial 2', 7], ['Dial 3', 1]]) for (let i = 0; i < n; i++) await press(d);
	await h.eventually(() => visible('Moon gem'), (v) => v === true, 'the code 3-7-1 opens the hatch: the moon gem', 4000);
	await press('Moon gem');
	await press('Lever left');
	h.check(await page.evaluate(() => window.__stores.gameState.gameVar('esLev', 0)) === 0, 'a lever out of order springs back');
	for (const l of ['Lever right', 'Lever left', 'Lever middle']) await press(l);
	await h.eventually(() => visible('Star gem'), (v) => v === true, 'right-left-middle rolls the star gem into the tray', 4000);
	await press('Star gem');
	h.check(((await snap()).flags & 4096) === 0 && (await press('Crank socket')) === 'ok' && ((await snap()).flags & 128) !== 0, 'the crank fits its socket');
	for (let i = 0; i < 8; i++) await press('Fitted crank');
	await h.eventually(() => snap().then((v) => v.flags & 4096), (v) => v !== 0, 'eight turns of the crank raise the gate', 4000);
	await page.waitForTimeout(900);
	const gateY = await page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByName('Workshop gate').position.y; });
	h.check(gateY > 2.5, `the gate is up (y ${gateY.toFixed(2)})`);

	// 6 — the vault: three gems, the door, the exit -> the win screen and a best time
	for (const p of ['Pedestal sun', 'Pedestal moon', 'Pedestal star']) await press(p);
	await h.eventually(() => visible('Exit portal'), (v) => v === true, 'three gems open the vault door: the exit glows', 4000);
	await press('Exit portal');
	await h.eventually(() => snap().then((v) => v.state + '/' + v.screen), (v) => v === 'over/over', 'stepping through wins: the results screen', 6000);
	await h.eventually(hud, (t) => /YOU ESCAPED/.test(t) && /You escaped in \d+:\d\d/.test(t) && /Play again/.test(t), 'the results name the time and offer Play again', 5000);
	const best = await h.eventually(() => page.evaluate(() => window.__escape.best()), (b) => b > 0, 'a best time is saved on this device', 3000);
	await page.screenshot({ path: process.env.ESCAPE_SHOTS ? path.join(process.env.ESCAPE_SHOTS, 'won.png') : '/tmp/claude-1000/escape-won.png' });

	// 7 — Play again resets the house
	await page.locator('#hud-layer button', { hasText: 'Play again' }).first().click();
	await h.eventually(() => snap().then((v) => v.state + ':' + v.flags), (v) => v === 'playing:0', 'Play again resets every lock', 8000);
	await page.waitForTimeout(1200);
	h.check(!(await visible('Exit portal')) && (await visible('Sun gem')), 'the exit is shut again and the sun gem is back on the shelf');
	await page.waitForTimeout(2600);
	await page.screenshot({ path: process.env.ESCAPE_SHOTS ? path.join(process.env.ESCAPE_SHOTS, 'study.png') : '/tmp/claude-1000/escape-study.png' });
	const helpers = await page.evaluate(() => {
		let sc; window.__stores.globalScene.subscribe((v) => (sc = v))();
		const seen = [];
		sc.traverse((o) => { if (o.visible && /helper|grid/i.test(o.name ?? '') && o.parent === sc) seen.push(o.name); });
		return seen;
	});
	h.check(!helpers.includes('editor-grid'), `no editor grid in Play (${helpers.join(', ') || 'none'})`);

	// 7b — the Levels page: start in the vault (practice) — the earlier rooms come pre-solved
	await page.evaluate(() => window.__escape.startStage(2));
	await h.eventually(() => snap().then((v) => v.state + ':' + ((v.flags & 4096) !== 0)), (v) => v === 'playing:true', 'a stage pick starts a round in the vault with the gate already up', 6000);
	h.check(await page.evaluate(() => window.__escape.room()) === 2, 'the stage start puts you in the vault');
	await h.eventually(hud, (t) => /Sun gem/.test(t) && /Moon gem/.test(t) && /Star gem/.test(t), 'carrying all three gems', 4000);
	const bestBefore = await page.evaluate(() => window.__escape.best());
	for (const p of ['Pedestal sun', 'Pedestal moon', 'Pedestal star']) await press(p);
	await press('Exit portal');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'over', 'the vault stage wins too', 6000);
	h.check(await page.evaluate(() => window.__escape.best()) === bestBefore, 'a practice stage does not touch the best time');
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(600);

	// 8 — VR (a fake XR session): the menu is a VR board, Start works, a trigger press acts
	await xr.install(page);
	await xr.setOn(page, true);
	await page.evaluate(() => window.__stores.gameState.setGameState('menu'));
	const board = await page.evaluate(() => {
		const sc = window.__stores.hudDocs.visibleScreen('scene');
		return { id: sc?.id, menuInput: sc?.input === 'menu' };
	});
	h.check(board.id === 'menu' && board.menuInput, `the Start menu is a menu-input screen, which a headset draws as the VR board (${JSON.stringify(board)})`);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await h.eventually(() => snap().then((v) => v.state + ':' + v.flags), (v) => v === 'playing:0', 'a VR player starts a fresh round', 6000);
	const vrPress = await page.evaluate(() => {
		const s = window.__stores;
		let g; s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByName('Desk drawer');
		return s.moduleSDK.runClickHandlers(o, 'play', { source: 'sweep' });
	});
	h.check(vrPress === true && ((await snap()).flags & 1) !== 0, 'a VR trigger/sweep press opens the drawer');
	await xr.uninstall(page);
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);

	// 9 — THE U10 PROBE: the crank's turns from the GRAPH, the dial code from the CODE; both felt in
	// Play, both kept by a save and a reload
	const rid = await page.evaluate(() => window.__escape?.rulesNode?.() ?? null);
	h.check(!!rid, `premise: the Main graph carries the Escape rules node (${rid})`);
	await h.eventually(() => page.evaluate((id) => window.__stores.behaviours.behavioursDebug().status[id]?.status, rid), (st) => st === 'running', 'the Escape rules behaviour is running', 10000);
	const codeNow = () => page.evaluate((id) => { let g; window.__stores.flowGraphs.subscribe((v) => (g = v))(); return g.scene.nodes.find((n) => n.id === id)?.data?.code ?? ''; }, rid);
	// (a) the GRAPH: select the rules node, the ⓘ tab, Crank turns 8 → 3
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(600);
	if (!(await page.evaluate(() => !!document.querySelector('.svelte-flow__pane')))) await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1000);
	await page.evaluate(() => window.__stores.bottomDock?.dockHeight?.set(600));
	if (!(await page.locator('#flow-props').count())) await page.locator('#flow-props-toggle').click();
	await page.locator('#flow-tab-info').click();
	await page.evaluate((id) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === id }))), rid);
	await h.eventually(() => page.locator('#flow-prop-crankTurns').count(), (n) => n === 1, 'the rules node shows Crank turns in its properties panel', 6000);
	await page.locator('#flow-prop-crankTurns').fill('3');
	await page.locator('#flow-prop-crankTurns').press('Enter');
	await h.eventually(codeNow, (c) => /crankTurns:\s*\{\s*value:\s*3\b/.test(c), 'the knob rewrote the literal in the rules source (crankTurns: 3)', 4000);
	// (b) the CODE: open the rules in the code workspace and change the dial code to 1 · 1 · 1
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
	const edited = (await codeNow()).replace('const CODE = [3, 7, 1];', 'const CODE = [1, 1, 1];');
	const paneId = await page.evaluate(() => { let v; window.__stores.codeWorkspace.activeCodeTab.subscribe((x) => (v = x))(); return v; });
	await page.locator(`[data-pane="${paneId}"] .cm-content`).click();
	await page.keyboard.press('Control+A');
	await page.keyboard.insertText(edited);
	await page.keyboard.press('Control+S');
	await h.eventually(codeNow, (c) => /const CODE = \[1, 1, 1\];/.test(c), 'Ctrl+S saved the code onto the node (the dial code is 1 · 1 · 1)', 6000);
	await page.locator('#code-ws-close:visible, [data-dock-tab-close="code"]:visible').first().click().catch(() => {});
	await h.eventually(() => page.evaluate((id) => window.__stores.behaviours.behavioursDebug().status[id]?.status, rid), (st) => st === 'running', 'the edited rules reloaded and run', 8000);
	/** the workshop practice room: dials once each (the code change), the crank fitted and turned (the graph change) */
	const feel = async (when) => {
		await page.evaluate(() => window.__stores.isLocked.set(true));
		await page.waitForTimeout(800);
		await page.evaluate(() => window.__escape.startStage(1));
		await h.eventually(() => snap().then((v) => v.state + ':' + ((v.flags & 16) !== 0) + ':' + ((v.flags & 256) !== 0)), (v) => v === 'playing:true:false', `${when}: the workshop practice room starts (study solved, hatch shut)`, 8000);
		for (const d of ['Dial 1', 'Dial 2', 'Dial 3']) await press(d);
		await h.eventually(() => snap().then((v) => v.flags & 256), (v) => v !== 0, `${when}: one click on each dial (1 · 1 · 1) opens the hatch — the code change`, 4000);
		await press('Crank socket');
		await h.eventually(hud, (t) => /crank 0\/3/.test(t) && /note: 1·1·1/.test(t), `${when}: the HUD counts the crank out of 3 and reads the note as 1·1·1`, 4000);
		for (let i = 0; i < 3; i++) await press('Fitted crank');
		await h.eventually(() => snap().then((v) => v.flags & 4096), (v) => v !== 0, `${when}: three turns of the crank raise the gate — the graph change`, 4000);
	};
	await feel('Play');
	// (c) both survive a save and a reload
	const saved = await page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('Escape probe');
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
	h.check(/crankTurns:\s*\{\s*value:\s*3\b/.test(reloaded) && /const CODE = \[1, 1, 1\];/.test(reloaded), 'after a save and a reload the rules keep 3 crank turns and the code 1 · 1 · 1');
	await h.eventually(() => page.evaluate(() => window.__stores.behaviours.behavioursDebug().status[window.__escape.rulesNode()]?.status), (st) => st === 'running', 'the reloaded rules run', 10000);
	await feel('Play after the reload');
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	await h.finish(browser);
});
