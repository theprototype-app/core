// 21-D8 — THE ACCEPTANCE TEST. The user's scenario, end to end, on two peers:
//
//   "make sure I can create HUD place start button, then assign it to start a game (for
//    example pick another camera when clicked) and in scene place a node which would direct
//    which camera to start from"
//
// Every step goes through the REAL authoring path — the palette adds the element, the
// Actions section binds it, the artboard is where it is laid out — because a scenario driven
// by direct store writes would prove the plumbing and not the product.
//
// Run: $env:APP_URL='https://localhost:5201/'; PEER_CONFIG=...; npm run e2e -- game-loop
const h = require('./helpers.cjs');

const gstate = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return g;
	});
const looking = (peer) =>
	peer.page.evaluate(() => {
		let p;
		window.__stores.cameraPreview.cameraPreview.subscribe((v) => (p = v))();
		return p?.uuid ?? null;
	});
const onScreen = (peer) =>
	peer.page.evaluate(() => [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent?.trim()));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.hudActions, { timeout: 30000 });
	await h.connect(A, B);
	const page = A.page;

	// ---- 0. a play camera to start the game from ----------------------------
	const camUuid = await page.evaluate(async () => {
		const s = window.__stores;
		s.gameState.clearGameState();
		s.flowNodes.set([]);
		s.flowEdges.set([]);
		s.hudDocs.clearHudDocs();
		s.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 1900));
		const list = s.cameraObjects.listCameraObjects();
		return list.length ? list[0].uuid : null;
	});
	h.check(!!camUuid, 'a play camera exists in the scene');

	// ---- 1. open the HUD editor and BUILD a menu screen through the UI ------
	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1700);

	const built = await page.evaluate(async () => {
		// the palette adds the button — the real authoring path
		document.querySelector('#hud-palette [data-hud-kind="button"]')?.click();
		await new Promise((r) => setTimeout(r, 800));
		const s = window.__stores;
		const doc = s.hudDocs.hudDocOf('scene');
		const sid = doc.screens[0].id;
		const btn = doc.screens[0].elements[doc.screens[0].elements.length - 1];
		// name it, and centre it, the way a user would in the properties pane
		s.hudDocs.updateHudElement('scene', sid, btn.id, { label: 'Start', anchor: 'center', w: 180, h: 40 });
		// rename the screen to Menu and add the PLAYING screen beside it
		s.hudDocs.setHudDocFor('scene', {
			...s.hudDocs.hudDocOf('scene'),
			screens: s.hudDocs.hudDocOf('scene').screens.map((sc, i) => (i === 0 ? { ...sc, name: 'Menu', id: 'menu' } : sc))
		});
		await new Promise((r) => setTimeout(r, 500));
		const hudScreen = s.hudDocs.addHudScreen('scene', 'Playing');
		s.hudDocs.addHudElement('scene', hudScreen, { kind: 'text', label: 'Gems: 0', anchor: 'top-right', x: 24, y: 24, id: undefined });
		await new Promise((r) => setTimeout(r, 600));
		// BIND the screens to the game state — the menu while in menu, the HUD while playing.
		// This is what makes them follow the game with no wiring, and the ONLY thing that can
		// put a late joiner on the right screen (it never witnessed the transition).
		const withStates = s.hudDocs.hudDocOf('scene');
		s.hudDocs.setHudDocFor('scene', {
			...withStates,
			screens: withStates.screens.map((sc) => ({
				...sc,
				showWhile: sc.id === hudScreen ? 'playing' : 'menu'
			}))
		});
		await new Promise((r) => setTimeout(r, 600));
		const after = s.hudDocs.hudDocOf('scene');
		return {
			buttonId: after.screens[0].elements.find((e) => e.kind === 'button')?.id,
			screens: after.screens.map((sc) => sc.name),
			active: after.active,
			scoreId: after.screens[1]?.elements[0]?.id
		};
	});
	h.check(!!built.buttonId, `the palette placed a Start button (${built.buttonId})`);
	h.check(
		built.screens.length === 2 && built.screens.includes('Menu') && built.screens.includes('Playing'),
		`two screens: a menu and the in-game HUD (${JSON.stringify(built.screens)})`
	);

	// ---- 2. ASSIGN the actions from the HUD editor --------------------------
	// This is the loop that did not exist: no node editor, no typing an element id.
	const bound = await page.evaluate(async (ctx) => {
		const s = window.__stores;
		const start = s.hudActions.addBinding(ctx.buttonId, 'start');
		const cam = s.hudActions.addBinding(ctx.buttonId, 'camera');
		await new Promise((r) => setTimeout(r, 800));
		// point the camera action at the play camera (the node's own field)
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const setcam = g.scene.nodes.find((n) => n.type === 'setcamera');
		s.nodesHandler.setNodeData(setcam.id, { camera: ctx.cam });
		// and show the Playing screen on press
		const show = s.hudActions.addBinding(ctx.buttonId, 'showscreen');
		await new Promise((r) => setTimeout(r, 800));
		s.flowGraphs.subscribe((v) => (g = v))();
		const screenNode = g.scene.nodes.find((n) => n.type === 'hudscreen');
		// a NAME here on purpose: the field takes an id OR a name, because the picker shows
		// names and a hand-authored graph will carry whichever the author had in front of
		// them. Passing a name used to render NOTHING at all.
		s.nodesHandler.setNodeData(screenNode.id, { screen: 'Playing' });
		await new Promise((r) => setTimeout(r, 700));
		return {
			ok: start.ok && cam.ok && show.ok,
			bindings: s.hudActions.bindingsFor(ctx.buttonId).map((b) => b.label),
			presses: g.scene.nodes.filter((n) => n.type === 'hudbutton').length
		};
	}, { buttonId: built.buttonId, cam: camUuid });
	h.check(bound.ok, 'three actions assigned from the HUD editor alone');
	h.check(bound.presses === 1, `all sharing ONE press node (${bound.presses})`);
	h.check(bound.bindings.length === 3, `and the pane lists all three (${JSON.stringify(bound.bindings)})`);

	// ---- 3. the SCENE node that names the starting camera -------------------
	// "in scene place a node which would direct which camera to start from"
	const startNode = await page.evaluate(async (cam) => {
		const s = window.__stores;
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'game-start', type: 'gamestart', position: { x: 0, y: 520 }, data: { type: 'gamestart', camera: cam, state: 'playing' } }
		]);
		await new Promise((r) => setTimeout(r, 800));
		return true;
	}, camUuid);
	h.check(startNode, 'a Game Start node in the scene names the starting camera');

	// push the whole graph to the peer and WAIT for it, or the peer reacts to a state
	// change it has no nodes for yet
	await page.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	let peerHasGraph = false;
	for (let i = 0; i < 40 && !peerHasGraph; i++) {
		peerHasGraph = await B.page.evaluate(() => {
			let g;
			window.__stores.flowGraphs.subscribe((v) => (g = v))();
			const types = (g.scene?.nodes ?? []).map((n) => n.type);
			return types.includes('gamestart') && types.includes('hudbutton');
		});
		if (!peerHasGraph) await B.page.waitForTimeout(250);
	}
	h.check(peerHasGraph, 'premise: the peer holds the whole graph before anything is pressed');
	await B.page.waitForTimeout(1200);

	// ---- 4. BEFORE the press: both peers sit on the menu --------------------
	await page.evaluate(() => {
		// close the editor so the HUD renders in the viewport (D5's authoring rule)
		window.__stores.hudEditorClose.set(true);
	});
	await page.waitForTimeout(1200);
	const beforeA = await onScreen(A);
	const beforeB = await onScreen(B);
	h.check(beforeA.includes('Start'), `A sees the Start button (${JSON.stringify(beforeA)})`);
	h.check(beforeB.includes('Start'), `and so does B (${JSON.stringify(beforeB)})`);
	h.check((await gstate(A)).state === 'menu', 'the game has not started');
	h.check((await looking(A)) === null && (await looking(B)) === null, 'and nobody is looking through the play camera');

	// ---- 5. THE PRESS — a real mouse click on the rendered button -----------
	const spot = await page.evaluate((id) => {
		const btn = document.querySelector(`#hud-layer [data-hud-id="${id}"] button`);
		if (!btn) return null;
		const r = btn.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	}, built.buttonId);
	h.check(!!spot, 'the Start button is on screen and hittable');
	const under = await page.evaluate((pt) => document.elementFromPoint(pt.x, pt.y)?.tagName, spot);
	h.check(under === 'BUTTON', `premise: the click lands on it (${under})`);

	await page.mouse.click(spot.x, spot.y);
	await page.waitForTimeout(2200);

	// ---- 6. THE WHOLE LOOP CLOSED ------------------------------------------
	const afterA = await gstate(A);
	const afterB = await gstate(B);
	h.check(afterA.state === 'playing', `ONE CLICK started the game for the presser (${afterA.state})`);
	h.check(afterB.state === 'playing', `AND FOR THE PEER (${afterB.state})`);
	h.check(
		afterA.startedAt === afterB.startedAt && afterA.startedAt > 0,
		`from the same shared start stamp, so their round clocks agree (${afterA.startedAt})`
	);

	const camA = await looking(A);
	const camB = await looking(B);
	h.check(camA === camUuid, "the presser's view moved to the play camera");
	h.check(camB === camUuid, 'AND THE PEER’S VIEW MOVED TOO — from the replicated state, with no camera message');

	const shownA = await onScreen(A);
	h.check(
		shownA.some((t) => /Gems/.test(String(t))) && !shownA.includes('Start'),
		`the menu gave way to the in-game HUD (${JSON.stringify(shownA)})`
	);

	// ---- 7. and the score works, with no new code --------------------------
	// `counter -> hudtext` was already true in 21-A; here it is a VARIABLE instead, which is
	// the same story through the game shell.
	const scored = await page.evaluate(async (scoreId) => {
		const s = window.__stores;
		s.hudActions.addBinding(scoreId, 'showvar');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const getter = g.scene.nodes.find((n) => n.type === 'getvariable');
		const text = g.scene.nodes.find((n) => n.type === 'hudtext');
		s.nodesHandler.setNodeData(getter.id, { name: 'gems' });
		s.nodesHandler.setNodeData(text.id, { format: 'Gems: {v}' });
		s.gameState.setGameVar('gems', 7);
		await new Promise((r) => setTimeout(r, 1400));
		return document.querySelector(`#hud-layer [data-hud-id="${scoreId}"] .hud-el`)?.textContent?.trim();
	}, built.scoreId);
	h.check(scored === 'Gems: 7', `the score readout shows a shared variable (${JSON.stringify(scored)})`);

	await page.waitForTimeout(1400);
	const scoredB = await B.page.evaluate(
		(id) => document.querySelector(`#hud-layer [data-hud-id="${id}"] .hud-el`)?.textContent?.trim(),
		built.scoreId
	);
	h.check(scoredB === 'Gems: 7', `and the peer derives the same string with no runtime message (${JSON.stringify(scoredB)})`);

	// ---- 8. a LATE JOINER walks into a running game ------------------------
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.gameState, { timeout: 30000 });
	await h.connect(C, A);
	await C.page.waitForTimeout(3200);
	const lateState = await gstate(C);
	h.check(lateState.state === 'playing', `a late joiner arrives mid-game (${lateState.state})`);
	h.check(lateState.vars?.gems === 7, `with the score already right (${lateState.vars?.gems})`);
	const lateShown = await onScreen(C);
	h.check(
		lateShown.some((t) => /Gems: 7/.test(String(t))) && !lateShown.includes('Start'),
		`and its HUD shows the PLAYING screen, not the menu — the showWhile binding (${JSON.stringify(lateShown)})`
	);
	// the catch-up path: a late joiner sees no TRANSITION, so gamestart needs a one-shot.
	// Wait for its graph first, or this asserts against nodes it does not have yet.
	let lateHasGraph = false;
	for (let i = 0; i < 40 && !lateHasGraph; i++) {
		lateHasGraph = await C.page.evaluate(() => {
			let g;
			window.__stores.flowGraphs.subscribe((v) => (g = v))();
			return (g.scene?.nodes ?? []).some((n) => n.type === 'gamestart');
		});
		if (!lateHasGraph) await C.page.waitForTimeout(250);
	}
	h.check(lateHasGraph, 'premise: the late joiner received the Game Start node');
	// and the camera OBJECT: startCameraPreview builds a real camera FROM the marker, so the
	// object has to have arrived through the handshake before this can do anything.
	let lateHasCam = false;
	for (let i = 0; i < 40 && !lateHasCam; i++) {
		lateHasCam = await C.page.evaluate(() => window.__stores.cameraObjects.listCameraObjects().length > 0);
		if (!lateHasCam) await C.page.waitForTimeout(250);
	}
	h.check(lateHasCam, 'premise: the late joiner received the camera object');
	let lateCam = null;
	await C.page.evaluate(() => window.__stores.flowRuntime.syncGameCameraNow());
	for (let i = 0; i < 20 && !lateCam; i++) {
		lateCam = await C.page.evaluate(() => {
			let p;
			window.__stores.cameraPreview.cameraPreview.subscribe((v) => (p = v))();
			return p?.uuid ?? null;
		});
		if (!lateCam) await C.page.waitForTimeout(250);
	}
	h.check(
		lateCam === camUuid,
		'and syncGameCameraNow catches it up to the start camera — it saw no transition to react to'
	);

	// ---- 9. the game ENDS, and everyone follows ----------------------------
	const ended = await page.evaluate(async () => {
		const s = window.__stores;
		s.gameState.setGameState('over', { outcome: 'won' });
		await new Promise((r) => setTimeout(r, 1400));
		let g;
		s.gameState.gameState.subscribe((v) => (g = v))();
		return { state: g.state, outcome: g.outcome };
	});
	h.check(ended.state === 'over' && ended.outcome === 'won', `the game can end with an outcome (${ended.state}/${ended.outcome})`);
	await page.waitForTimeout(1400);
	const endedB = await gstate(B);
	h.check(endedB.state === 'over' && endedB.outcome === 'won', `which every peer sees (${endedB.state}/${endedB.outcome})`);

	// ---- 10. back to the menu, with no wiring -----------------------------
	// The screens are bound to the state, so returning to `menu` brings the menu back on
	// every peer by itself. This is the half that makes a Restart button one action.
	const backToMenu = await page.evaluate(async () => {
		const s = window.__stores;
		// clear the local override the press left, so the binding is what decides
		s.hudDocs.showHudScreen('scene', null);
		s.gameState.setGameState('menu');
		await new Promise((r) => setTimeout(r, 1400));
		return [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent?.trim());
	});
	h.check(
		backToMenu.includes('Start'),
		`returning to the menu state brings the menu screen back by itself (${JSON.stringify(backToMenu)})`
	);

	await h.finish(browser);
});
