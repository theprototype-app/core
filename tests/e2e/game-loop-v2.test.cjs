// 21-E8 — THE ACCEPTANCE TEST, SECOND PASS. 21-D8 proved a Start button can start a game;
// this one proves the things E4/E6/E8 were built for actually compose into a GAME:
//
//   a menu you press Start on -> a camera to play from -> a character you walk with ->
//   collectibles that disappear for everyone and count -> a map you hold a key to see ->
//   a pause menu that really pauses -> an ending, and back to the menu.
//
// Everything a user would AUTHOR is authored the way they would: the palette places the
// button, the Actions section binds it (through the NEW E8 actions where they are the
// natural choice), the object menu's recipe builds the collectibles. What is driven
// directly is only what a KEYBOARD or a MOUSE would drive, plus `makeCollectible(uuids)`
// itself — menu clicking is covered in hud-actions, and three gems through a context menu
// would be three menu walks proving the same one thing.
//
// Two peers throughout, because "disappears for everyone" is the assertion that matters,
// and a late joiner at the end for the catch-up half.
//
// Run: $env:APP_URL='https://localhost:5204/'; PEER_CONFIG=...; npm run e2e -- game-loop-v2
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
const visibleOf = (peer, uuids) =>
	peer.page.evaluate((ids) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return ids.map((id) => group?.getObjectByProperty('uuid', id)?.visible ?? null);
	}, uuids);
const gemsOf = (peer) => peer.page.evaluate(() => window.__stores.gameState.gameVar('gems', 0));
/** the world position of the play camera rig (char-controller's reader) */
const camWorld = (peer) =>
	peer.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.playerCam.subscribe((cam) => {
					if (!cam) return resolve(null);
					const w = cam.getWorldPosition(new window.__stores.THREE.Vector3());
					resolve({ x: w.x, y: w.y, z: w.z });
				})();
			})
	);
/** 21-E8: a clean slate has to be cleaned on EVERY peer — `flowNodes.set([])` does not
 * broadcast, and nodesync's hash compare then has the emptier peer PULL the graph back. */
const wipeGraphs = async (peers) => {
	for (const p of peers) await p.page.evaluate(() => window.__stores.clearGraphs());
	await peers[0].page.waitForTimeout(900);
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.gameRecipes, { timeout: 30000 });
	await h.connect(A, B);
	const page = A.page;

	// =======================================================================
	// 1. THE MENU: a play camera, a Start button from the palette, and its
	//    actions assigned from the HUD editor alone
	// =======================================================================
	await wipeGraphs([A, B]);
	const camUuid = await page.evaluate(async () => {
		const s = window.__stores;
		s.gameState.clearGameState();
		s.hudDocs.clearHudDocs();
		s.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 1900));
		const list = s.cameraObjects.listCameraObjects();
		// deselect, or the flow editor's scope follows the camera we just made
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return list.length ? list[0].uuid : null;
	});
	h.check(!!camUuid, 'a play camera exists in the scene');

	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1700);

	const built = await page.evaluate(async () => {
		const s = window.__stores;
		// the palette places the button — the real authoring path
		document.querySelector('#hud-palette [data-hud-kind="button"]')?.click();
		await new Promise((r) => setTimeout(r, 800));
		let doc = s.hudDocs.hudDocOf('scene');
		const menuId = doc.screens[0].id;
		const startBtn = doc.screens[0].elements[doc.screens[0].elements.length - 1];
		s.hudDocs.updateHudElement('scene', menuId, startBtn.id, { label: 'Start', anchor: 'center', w: 180, h: 40 });

		// the IN-GAME screen, the MAP, and the PAUSE menu
		const playId = s.hudDocs.addHudScreen('scene', 'Playing');
		const gems = s.hudDocs.addHudElement('scene', playId, { kind: 'text', label: 'Gems: 0', anchor: 'top-right', x: 24, y: 24 }).id;
		const mapId = s.hudDocs.addHudScreen('scene', 'Map');
		s.hudDocs.addHudElement('scene', mapId, { kind: 'text', label: 'THE MAP', anchor: 'center' });
		const pauseId = s.hudDocs.addHudScreen('scene', 'Paused');
		const resume = s.hudDocs.addHudElement('scene', pauseId, { kind: 'button', label: 'Resume', anchor: 'center', w: 160, h: 36 }).id;
		await new Promise((r) => setTimeout(r, 700));

		// bind the screens to the GAME STATE (menu <-> playing) and mark the pause screen
		// as a MENU for input purposes. Map and Paused get NO showWhile: they are shown by
		// a node, so binding them to a state as well would have two rules fighting.
		doc = s.hudDocs.hudDocOf('scene');
		s.hudDocs.setHudDocFor('scene', {
			...doc,
			screens: doc.screens.map((sc) => ({
				...sc,
				...(sc.id === menuId ? { showWhile: 'menu' } : {}),
				...(sc.id === playId ? { showWhile: 'playing' } : {}),
				...(sc.id === pauseId ? { input: 'menu' } : {})
			}))
		});
		await new Promise((r) => setTimeout(r, 700));
		return { menuId, playId, mapId, pauseId, startId: startBtn.id, gems, resume };
	});
	h.check(!!built.startId, `the palette placed a Start button (${built.startId})`);
	h.check(
		!!built.playId && !!built.mapId && !!built.pauseId,
		'four screens: menu, in-game HUD, map, pause'
	);

	// the actions — 'start' and 'camera' from 21-D, and 'resetcounter' from E8, which is
	// what makes round 2 begin clean
	const bound = await page.evaluate(async (ctx) => {
		const s = window.__stores;
		const start = s.hudActions.addBinding(ctx.startId, 'start');
		const cam = s.hudActions.addBinding(ctx.startId, 'camera');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		s.nodesHandler.setNodeData(g.scene.nodes.find((n) => n.type === 'setcamera').id, { camera: ctx.cam });
		// a Counter shown in the in-game HUD, and a Start that ZEROES it
		const count = s.hudActions.addBinding(ctx.gems, 'showcount');
		const reset = s.hudActions.addBinding(ctx.startId, 'resetcounter');
		await new Promise((r) => setTimeout(r, 900));
		s.flowGraphs.subscribe((v) => (g = v))();
		// the node's `format` owns the string once something is wired - the element's own
		// label is only what it shows UNWIRED, which is why the readout said a bare "0"
		s.nodesHandler.setNodeData(g.scene.nodes.find((n) => n.type === 'hudtext').id, { format: 'Gems: {v}' });
		await new Promise((r) => setTimeout(r, 500));
		s.flowGraphs.subscribe((v) => (g = v))();
		// the reset must reach the counter the readout already shows, not a second one
		const counters = g.scene.nodes.filter((n) => n.type === 'counter');
		const resetEdge = g.scene.edges.find((e) => e.targetHandle === 'reset');
		return {
			ok: start.ok && cam.ok && count.ok && reset.ok,
			presses: g.scene.nodes.filter((n) => n.type === 'hudbutton').length,
			counters: counters.length,
			resetEdge: !!resetEdge,
			bindings: s.hudActions.bindingsFor(ctx.startId).map((b) => b.label)
		};
	}, { startId: built.startId, cam: camUuid, gems: built.gems });
	h.check(bound.ok, 'three actions assigned to Start from the HUD editor alone');
	h.check(bound.presses === 1, `all sharing ONE press node (${bound.presses})`);
	h.check(
		bound.bindings.some((l) => /Reset counter/.test(String(l))),
		`and the pane names the reset for what it does (${JSON.stringify(bound.bindings)})`
	);
	h.check(bound.resetEdge, 'the reset edge really lands on a counter RESET handle');
	// RECORDED, not celebrated: like every catalog action, `resetcounter` CREATES its node,
	// so it zeroes the counter it made and not the one the readout shows. "Which counter"
	// has no unique answer the way "which press node" does (that one is element-scoped), so
	// pointing the edge at the counter you mean stays a node-editor step - the same as the
	// camera action shipping with no camera picked.
	h.check(
		bound.counters === 2,
		`the reset made its OWN counter, so re-pointing it is still a node-editor step (${bound.counters} counters)`
	);

	// a Game Start node names the camera every peer plays from — including a late joiner,
	// which never witnesses the transition
	await page.evaluate(async (cam) => {
		const s = window.__stores;
		s.nodesHandler.createFlowNode(
			{
				id: 'gs-1',
				type: 'gamestart',
				position: { x: 60, y: 900 },
				data: { type: 'gamestart', camera: cam, state: 'playing' },
				class: 'w-[150px]'
			},
			s.SCENE_GRAPH
		);
		await new Promise((r) => setTimeout(r, 600));
	}, camUuid);

	// push the whole graph and WAIT — a peer must not react to a state change it has no
	// nodes for yet
	await page.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	let peerReady = false;
	for (let i = 0; i < 40 && !peerReady; i++) {
		peerReady = await B.page.evaluate(() => {
			let g;
			window.__stores.flowGraphs.subscribe((v) => (g = v))();
			const types = (g.scene?.nodes ?? []).map((n) => n.type);
			return types.includes('gamestart') && types.includes('hudbutton');
		});
		if (!peerReady) await B.page.waitForTimeout(250);
	}
	h.check(peerReady, 'premise: the peer holds the whole graph before anything is pressed');

	await page.evaluate(() => window.__stores.hudEditorClose.set(true));
	await page.waitForTimeout(1300);
	h.check((await onScreen(A)).includes('Start'), 'A sees the menu');
	h.check((await onScreen(B)).includes('Start'), 'and so does B');
	h.check((await gstate(A)).state === 'menu', 'the game has not started');

	// THE PRESS — a real mouse click on the rendered button
	const spot = await page.evaluate((id) => {
		const btn = document.querySelector(`#hud-layer [data-hud-id="${id}"] button`);
		if (!btn) return null;
		const r = btn.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	}, built.startId);
	h.check(!!spot, 'the Start button is on screen and hittable');
	const under = await page.evaluate((pt) => document.elementFromPoint(pt.x, pt.y)?.tagName, spot);
	h.check(under === 'BUTTON', `premise: the click lands on it (${under})`);
	await page.mouse.click(spot.x, spot.y);
	await page.waitForTimeout(2200);

	h.check((await gstate(A)).state === 'playing', 'ONE CLICK started the game for the presser');
	h.check((await gstate(B)).state === 'playing', 'AND FOR THE PEER');
	h.check((await looking(A)) === camUuid, "the presser's view moved to the play camera");
	h.check((await looking(B)) === camUuid, 'AND THE PEER’S — from the replicated state, with no camera message');
	const playing = await onScreen(A);
	h.check(
		!playing.includes('Start') && playing.some((t) => /Gems/.test(String(t))),
		`the menu gave way to the in-game HUD (${JSON.stringify(playing)})`
	);

	// =======================================================================
	// 2. THE CHARACTER: a Character Controller on `walk`, and W moves you
	// =======================================================================
	const declared = await page.evaluate(async () => {
		const s = window.__stores;
		s.nodesHandler.createFlowNode(
			{
				id: 'cc-1',
				type: 'charcontroller',
				position: { x: 60, y: 1100 },
				data: { type: 'charcontroller', mode: 'walk', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7, gravity: true },
				class: 'w-[150px]'
			},
			s.SCENE_GRAPH
		);
		await new Promise((r) => setTimeout(r, 900));
		return s.charController.charControllerDebug();
	});
	h.check(
		declared.control?.mode === 'walk',
		`a Character Controller node DECLARES the movement model (${JSON.stringify(declared.control?.mode)})`
	);

	// enter play, level the rig (a rig aimed steeply upward makes "forward" vertical, and
	// yaw extraction is degenerate at straight up — the char-controller note)
	const walked = await page.evaluate(async () => {
		const s = window.__stores;
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 700));
		let cam = null;
		s.playerCam.subscribe((c) => (cam = c))();
		if (!cam) return null;
		cam.rotation.set(0, 0, 0);
		cam.updateMatrixWorld(true);
		return true;
	});
	h.check(walked === true, 'premise: play mode entered with a level rig');
	const beforeWalk = await camWorld(A);
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(1100);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(200);
	const afterWalk = await camWorld(A);
	const movedXZ = Math.hypot(afterWalk.x - beforeWalk.x, afterWalk.z - beforeWalk.z);
	h.check(movedXZ > 0.2, `W walks the presser after Start (${movedXZ.toFixed(3)}m in XZ)`);

	// =======================================================================
	// 3. THE COLLECTIBLES: the object-menu recipe, on three boxes
	// =======================================================================
	const gems = await page.evaluate(async () => {
		const s = window.__stores;
		/** @type {string[]} */
		const uuids = [];
		for (let i = 0; i < 3; i++) {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1100));
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			uuids.push(group.children[group.children.length - 1].uuid);
		}
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		await new Promise((r) => setTimeout(r, 500));
		// the recipe — one replicated `flownodes` entry PER OBJECT
		const result = s.gameRecipes.makeCollectible(uuids, { quiet: true });
		await new Promise((r) => setTimeout(r, 1000));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const types = g.scene.nodes.map((n) => n.type);
		const countOf = (t) => types.filter((x) => x === t).length;
		return {
			uuids,
			built: result.built.length,
			variable: result.variable,
			latches: countOf('latch'),
			gates: countOf('gate'),
			onces: countOf('once'),
			clicks: countOf('onclick'),
			setvars: countOf('setvariable')
		};
	});
	h.check(gems.built === 3, `three collectibles built from the recipe (${gems.built})`);
	h.check(
		gems.latches === 3 && gems.gates === 3 && gems.onces === 3 && gems.clicks === 3 && gems.setvars === 3,
		`each with its own chain (${gems.latches} latch / ${gems.gates} gate / ${gems.onces} once / ${gems.setvars} set-variable)`
	);
	h.check(gems.variable === 'gems', `counting into "${gems.variable}"`);

	// ONE undo entry PER OBJECT, which is why a mis-click does not throw the other gems
	// away. Checked HERE, before anything is collected: banking a gem writes the
	// game-state singleton, which records a `game` entry of its own, so a moment later the
	// top of the stack is a variable change rather than the recipe.
	const undone = await page.evaluate(async () => {
		const s = window.__stores;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const afterUndo = g.scene.nodes.filter((n) => n.type === 'latch').length;
		s.history.redo();
		await new Promise((r) => setTimeout(r, 900));
		s.flowGraphs.subscribe((v) => (g = v))();
		return { afterUndo, afterRedo: g.scene.nodes.filter((n) => n.type === 'latch').length };
	});
	h.check(undone.afterUndo === 2, `ONE undo removes ONE collectible, not all three (${undone.afterUndo} left)`);
	h.check(undone.afterRedo === 3, `and redo restores it (${undone.afterRedo})`);

	// the peer needs the nodes AND the boxes before anything is clicked
	await page.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	let peerHasGems = false;
	for (let i = 0; i < 40 && !peerHasGems; i++) {
		peerHasGems = await B.page.evaluate((ids) => {
			let g;
			window.__stores.flowGraphs.subscribe((v) => (g = v))();
			const latches = (g.scene?.nodes ?? []).filter((n) => n.type === 'latch').length;
			let group;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const objects = ids.filter((id) => !!group?.getObjectByProperty('uuid', id)).length;
			return latches === 3 && objects === 3;
		}, gems.uuids);
		if (!peerHasGems) await B.page.waitForTimeout(300);
	}
	h.check(peerHasGems, 'premise: the peer holds all three chains AND all three boxes');
	h.check(
		(await visibleOf(B, gems.uuids)).every((v) => v === true),
		'premise: all three are visible on the peer to begin with'
	);

	// collect them, one at a time
	for (const uuid of gems.uuids) {
		await page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
		await page.waitForTimeout(1100);
	}
	await page.waitForTimeout(1200);
	const visA = await visibleOf(A, gems.uuids);
	const visB = await visibleOf(B, gems.uuids);
	h.check(visA.every((v) => v === false), `all three vanished for the collector (${JSON.stringify(visA)})`);
	h.check(
		visB.every((v) => v === false),
		`AND FOR THE PEER — every peer latches from the same replicated stamp and hides it itself (${JSON.stringify(visB)})`
	);
	const gemsA = await gemsOf(A);
	const gemsB = await gemsOf(B);
	h.check(gemsA === 3, `the score reads 3 (${gemsA})`);
	h.check(gemsB === 3, `and the peer derives the same 3 (${gemsB})`);
	const shownGems = await onScreen(A);
	h.check(
		shownGems.some((t) => /Gems/.test(String(t))),
		`the in-game HUD is still up (${JSON.stringify(shownGems)})`
	);

	// clicking a COLLECTED one again must not bank it twice. The Latch holds it hidden, so
	// this looks like a no-op either way — the count is the only thing that tells.
	await page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), gems.uuids[0]);
	await page.waitForTimeout(1500);
	const gemsAgain = await gemsOf(A);
	h.check(gemsAgain === 3, `clicking a collected gem again does NOT count it (${gemsAgain})`);
	h.check(
		(await visibleOf(A, [gems.uuids[0]]))[0] === false,
		'and it stays collected — the Latch persists past the pulse that set it'
	);

	// =======================================================================
	// 4. HOLD A KEY FOR THE MAP: keypress(down) shows, keypress(up) hides
	// =======================================================================
	// E3 added the falling edge for exactly this. Both nodes are LOCAL reads of this peer's
	// own keyboard, and `hudscreen` writes a per-peer override — so a map is mine.
	await page.evaluate(async (ctx) => {
		const s = window.__stores;
		const mk = (id, type, data, y) =>
			s.nodesHandler.createFlowNode(
				{ id, type, position: { x: 60, y }, data: { type, ...data }, class: 'w-[150px]' },
				s.SCENE_GRAPH
			);
		mk('map-down', 'keypress', { code: 'Tab', pulse: 0.3, edge: 'down' }, 1300);
		mk('map-up', 'keypress', { code: 'Tab', pulse: 0.3, edge: 'up' }, 1380);
		mk('map-show', 'hudscreen', { screen: ctx.mapId, action: 'show' }, 1300);
		mk('map-hide', 'hudscreen', { screen: ctx.mapId, action: 'hide' }, 1380);
		const wire = (source, target) =>
			s.nodesHandler.createFlowEdge(
				{ id: 'e-' + source + '-' + target + '.trigger', source, target, targetHandle: 'trigger' },
				s.SCENE_GRAPH
			);
		wire('map-down', 'map-show');
		wire('map-up', 'map-hide');
		await new Promise((r) => setTimeout(r, 800));
	}, { mapId: built.mapId });

	const overrideOf = () =>
		page.evaluate(() => {
			let o;
			window.__stores.hudDocs.hudScreenOverride.subscribe((v) => (o = v))();
			return o.scene ?? null;
		});
	h.check((await overrideOf()) === null, 'premise: no screen override before the key is touched');
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true })));
	await page.waitForTimeout(900);
	const heldOverride = await overrideOf();
	const heldScreen = await onScreen(A);
	h.check(heldOverride === built.mapId, `HOLDING Tab shows the map (${heldOverride})`);
	h.check(
		heldScreen.some((t) => /THE MAP/.test(String(t))),
		`and the map is really on screen (${JSON.stringify(heldScreen)})`
	);
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', bubbles: true })));
	await page.waitForTimeout(900);
	h.check((await overrideOf()) === null, 'RELEASING it hides the map again — E3’s falling edge');
	const backToPlay = await onScreen(A);
	h.check(
		backToPlay.some((t) => /Gems/.test(String(t))) && !backToPlay.some((t) => /THE MAP/.test(String(t))),
		`and the in-game HUD comes back by itself (${JSON.stringify(backToPlay)})`
	);

	// =======================================================================
	// 5. + 6. THE PAUSE MENU: a key opens it, it frees the pointer, it really
	//         pauses the clock, and Resume puts everything back
	// =======================================================================
	const resumeWiring = await page.evaluate(async (ctx) => {
		const s = window.__stores;
		const mk = (id, type, data, y) =>
			s.nodesHandler.createFlowNode(
				{ id, type, position: { x: 60, y }, data: { type, ...data }, class: 'w-[150px]' },
				s.SCENE_GRAPH
			);
		mk('pause-key', 'keypress', { code: 'KeyP', pulse: 0.3, edge: 'down' }, 1500);
		mk('pause-show', 'hudscreen', { screen: ctx.pauseId, action: 'show' }, 1500);
		mk('pause-state', 'setgamestate', { state: 'paused', outcome: '' }, 1580);
		const wire = (source, target) =>
			s.nodesHandler.createFlowEdge(
				{ id: 'e-' + source + '-' + target + '.trigger', source, target, targetHandle: 'trigger' },
				s.SCENE_GRAPH
			);
		wire('pause-key', 'pause-show');
		wire('pause-key', 'pause-state');
		// Resume: the two halves of un-pausing, both from the Actions section
		const back = s.hudActions.addBinding(ctx.resume, 'resume');
		const hide = s.hudActions.addBinding(ctx.resume, 'hidescreen');
		await new Promise((r) => setTimeout(r, 1000));
		return {
			ok: back.ok && hide.ok,
			bindings: s.hudActions.bindingsFor(ctx.resume).map((b) => b.label)
		};
	}, { pauseId: built.pauseId, resume: built.resume });
	h.check(
		resumeWiring.ok && resumeWiring.bindings.length === 2,
		`premise: Resume carries both halves of un-pausing (${JSON.stringify(resumeWiring.bindings)})`
	);

	const elapsedOf = () => page.evaluate(() => window.__stores.gameState.gameElapsed());
	const freeOf = () =>
		page.evaluate(() => {
			let f;
			window.__stores.playPointerFree.subscribe((v) => (f = v))();
			return f;
		});
	h.check((await freeOf()) === false, 'premise: the pointer is captured while playing');
	const runningA = await elapsedOf();
	await page.waitForTimeout(700);
	const runningB = await elapsedOf();
	h.check(runningB > runningA, `premise: the round clock is running (${runningA.toFixed(2)} -> ${runningB.toFixed(2)})`);

	// down AND up: a `down` keypress node RE-STAMPS ~3/s while the key is held (that is
	// what makes a held key read as high), so a key never released keeps re-applying its
	// action - measured here as a pause that overwrote Resume and then the game ending.
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true })));
	await page.waitForTimeout(250);
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true })));
	await page.waitForTimeout(1200);
	const pausedState = await gstate(A);
	const pausedScreen = await onScreen(A);
	h.check(pausedState.state === 'paused', `P opens the pause menu AND pauses the game (${pausedState.state})`);
	h.check(
		pausedScreen.some((t) => /Resume/.test(String(t))),
		`the pause screen is up (${JSON.stringify(pausedScreen)})`
	);
	h.check(
		(await freeOf()) === true,
		'and an input:menu screen FREES the pointer, so the menu is clickable'
	);
	const frozenA = await elapsedOf();
	await page.waitForTimeout(900);
	const frozenB = await elapsedOf();
	h.check(
		Math.abs(frozenB - frozenA) < 0.05,
		`the round clock FREEZES while paused (${frozenA.toFixed(2)} -> ${frozenB.toFixed(2)})`
	);
	h.check((await gstate(B)).state === 'paused', 'and the peer is paused too — one shared state');

	// RESUME, through the button's own path
	await page.evaluate((id) => window.__stores.flowRuntime.fireHudButton(id), built.resume);
	await page.waitForTimeout(1600);
	h.check((await gstate(A)).state === 'playing', 'Resume puts the game back');
	h.check((await freeOf()) === false, 'the pointer is captured again');
	const resumedScreen = await onScreen(A);
	h.check(
		resumedScreen.some((t) => /Gems/.test(String(t))) && !resumedScreen.some((t) => /Resume/.test(String(t))),
		`and the in-game HUD is back (${JSON.stringify(resumedScreen)})`
	);
	const resumedA = await elapsedOf();
	await page.waitForTimeout(800);
	const resumedB = await elapsedOf();
	h.check(resumedB > resumedA, `the clock continues from where it froze (${resumedA.toFixed(2)} -> ${resumedB.toFixed(2)})`);
	// the window has to allow for the 1.6s this suite itself waits after the press, during
	// which the clock is legitimately running again - what is being asserted is that the
	// ~2.1s SPENT PAUSED was not banked, not that no time passed at all
	h.check(
		resumedA >= frozenB - 0.2 && resumedA < frozenB + 2.6,
		`without counting the pause (${frozenB.toFixed(2)} paused -> ${resumedA.toFixed(2)} resumed)`
	);

	// =======================================================================
	// 7. THE END, and back to the menu with no wiring
	// =======================================================================
	await page.evaluate(async () => {
		const s = window.__stores;
		s.gameState.setGameState('over', { outcome: 'won' });
		await new Promise((r) => setTimeout(r, 1200));
	});
	await page.waitForTimeout(1200);
	const overA = await gstate(A);
	const overB = await gstate(B);
	h.check(overA.state === 'over' && overA.outcome === 'won', `the game ends with an outcome (${overA.state}/${overA.outcome})`);
	h.check(overB.state === 'over' && overB.outcome === 'won', 'which every peer sees');

	// ---- a LATE JOINER walks in on the finished round ----------------------
	// out of play mode first: the approval prompt is editor chrome, and a real user is not
	// asked to click it from inside a pointer-locked game either
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(900);
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.gameState, { timeout: 30000 });
	await h.connect(C, A);
	await C.page.waitForTimeout(3400);
	const lateState = await gstate(C);
	h.check(lateState.state === 'over', `a late joiner arrives on the finished round (${lateState.state})`);
	h.check(
		(await gemsOf(C)) === 3,
		`with the score already right — it rides the replicated singleton, not the trigger log (${await gemsOf(C)})`
	);
	// what a late joiner canNOT recover is TRIGGER-derived state: its trigger log starts
	// empty, so each Latch reads "never set". Recorded rather than asserted, because it is
	// E4's documented tradeoff and not this batch's to fix.
	console.log('NOTE late joiner gem visibility (trigger-derived, expected true): ' + JSON.stringify(await visibleOf(C, gems.uuids)));

	// back to the menu: the screens are bound to the STATE, so this needs no wiring at all
	const backToMenu = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.showHudScreen('scene', null);
		s.gameState.setGameState('menu');
		await new Promise((r) => setTimeout(r, 1500));
		return [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent?.trim());
	});
	h.check(
		backToMenu.includes('Start'),
		`returning to the menu state brings the menu screen back by itself — showWhile (${JSON.stringify(backToMenu)})`
	);
	await C.page.waitForTimeout(1600);
	const lateMenu = await onScreen(C);
	h.check(
		lateMenu.includes('Start'),
		`and the late joiner lands on the menu too, having witnessed no transition (${JSON.stringify(lateMenu)})`
	);

	for (const [name, peer] of [['A', A], ['B', B], ['C', C]])
		h.check(h.pageErrors(peer).length === 0, `no render crash on ${name} (${JSON.stringify(h.pageErrors(peer))})`);
	await h.finish(browser);
});
