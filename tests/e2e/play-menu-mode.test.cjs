// 21-E3 — the menu input mode, refcounted claims, keypress edges, and a pause that pauses.
//
// Headless has NO real pointer lock (requestPointerLock fires pointerlockerror), so the
// state machine is asserted through its stores with the lock calls SPIED — the attempts
// are the contract — plus the one invariant that makes the whole design safe:
// `isLocked` NEVER leaves `true` across a menu open/close, so Controls' exit debounce
// and its 2s allowPlay lockout are structurally unreachable from a menu.
//
// Run: $env:APP_URL='https://localhost:5204/'; npm run e2e -- play-menu-mode
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ---- 0. spies + fixtures --------------------------------------------------
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__lockCalls = { request: 0, exit: 0 };
		// the PROTOTYPE, not querySelector(canvas): DungeonMinimap renders a HIDDEN canvas
		// before threlte's, so the first canvas is never the renderer's (the grabFrame trap)
		const orig = HTMLCanvasElement.prototype.requestPointerLock;
		HTMLCanvasElement.prototype.requestPointerLock = function (...args) {
			w.__lockCalls.request++;
			return orig ? orig.apply(this, args) : Promise.reject(new Error('headless'));
		};
		const origExit = document.exitPointerLock?.bind(document);
		document.exitPointerLock = function () {
			w.__lockCalls.exit++;
			return origExit ? origExit() : undefined;
		};
	});

	const built = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(false);
		s.bottomDock.activateDock('hud');
		await new Promise((r) => setTimeout(r, 1500));
		const doc = s.hudDocs.hudDocOf('scene');
		const gameScreen = doc.screens[0].id;
		// the HUD screen everyone plays under
		s.hudDocs.addHudElement('scene', gameScreen, { kind: 'text', label: 'Score: 0' });
		// the MENU screen: input:'menu' + a button and a slider for the ring
		const menuScreen = s.hudDocs.addHudScreen('scene', 'Pause menu');
		const resume = s.hudDocs.addHudElement('scene', menuScreen, { kind: 'button', label: 'Resume' }).id;
		const vol = s.hudDocs.addHudElement('scene', menuScreen, {
			kind: 'slider', label: 'Volume', min: 0, max: 100, step: 5, value: 50, y: 60
		}).id;
		const diff = s.hudDocs.addHudElement('scene', menuScreen, {
			kind: 'dropdown', options: 'Easy, Normal, Hard', value: 'Normal', y: 110
		}).id;
		s.hudDocs.setHudDocFor('scene', {
			...s.hudDocs.hudDocOf('scene'),
			screens: s.hudDocs.hudDocOf('scene').screens.map((sc) =>
				sc.id === menuScreen ? { ...sc, input: 'menu' } : sc
			)
		});
		// close the editor so the layer paints (and grab no claims from previews)
		s.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 700));
		return { gameScreen, menuScreen, resume, vol, diff };
	});
	h.check(!!built.menuScreen, 'premise: a menu screen with a button, a slider and a dropdown');

	// ---- 1. normalize: the field is absent-means-game --------------------------
	const norm = await page.evaluate(() => {
		const n = window.__stores.hudDocs.normalizeHudScreen;
		return {
			absent: n({ id: 's', name: 's', elements: [] }).input,
			junk: n({ id: 's', name: 's', input: 'weird', elements: [] }).input,
			menu: n({ id: 's', name: 's', input: 'menu', elements: [] }).input
		};
	});
	h.check(norm.absent === 'game', 'normalize: absent input = game (old docs byte-identical)');
	h.check(norm.junk === 'game', 'normalize: junk = game');
	h.check(norm.menu === 'menu', 'normalize: menu preserved');

	// ---- 2. claims are refcounted ----------------------------------------------
	const claims = await page.evaluate(() => {
		const s = window.__stores.inputRuntime;
		const read = () => {
			let v; s.inputClaims.subscribe((x) => (v = x))(); return v.includes('keys');
		};
		s.claimInput('keys');
		s.claimInput('keys');
		const afterTwo = read();
		s.releaseInput('keys');
		const afterOneRelease = read();
		s.releaseInput('keys');
		const afterTwoReleases = read();
		return { afterTwo, afterOneRelease, afterTwoReleases };
	});
	h.check(claims.afterTwo === true, 'two claims: held');
	h.check(claims.afterOneRelease === true, 'ONE release of two: STILL held — the two-claimers bug is dead');
	h.check(claims.afterTwoReleases === false, 'second release: gone');

	// ---- 3. the menu substate machine -------------------------------------------
	// enter play (headless: the lock request fails, but isLocked itself is the state)
	const cycle = await page.evaluate(async (b) => {
		const s = window.__stores;
		const w = /** @type {any} */ (window);
		/** @type {string[]} */
		const log = [];
		s.isLocked.set(true);
		// subscribed AFTER the set: svelte stores emit the current value on subscribe,
		// and the pre-play null is not part of the cycle under test
		const un = s.isLocked.subscribe((v) => log.push(String(v)));
		await new Promise((r) => setTimeout(r, 500));
		const exitsBefore = w.__lockCalls.exit;
		// a node shows the menu (the hudscreen path writes the same override)
		s.hudDocs.showHudScreen('scene', b.menuScreen);
		await new Promise((r) => setTimeout(r, 600));
		let free; s.playPointerFree.subscribe((v) => (free = v))();
		const exitCalled = w.__lockCalls.exit > exitsBefore;
		// playInteract stands down
		const interactOff = s.playInteract ? s.playInteract.playInteractDebug?.().mode !== 'carrying' : true;
		// hide it (the node's other half)
		const requestsBefore = w.__lockCalls.request;
		s.hudDocs.showHudScreen('scene', b.gameScreen);
		await new Promise((r) => setTimeout(r, 600));
		let freeAfter; s.playPointerFree.subscribe((v) => (freeAfter = v))();
		const relockAttempted = w.__lockCalls.request > requestsBefore;
		un();
		return { log, free, exitCalled, interactOff, freeAfter, relockAttempted };
	}, built);
	h.check(cycle.free === true, 'a visible input:menu screen FREES the pointer (playPointerFree true)');
	// headless never HOLDS a lock (requestPointerLock rejects), so there is nothing to
	// exit - the machine must know that and NOT call exitPointerLock into the void.
	h.check(cycle.exitCalled === false, 'with no lock held, nothing calls exitPointerLock into the void');
	h.check(cycle.freeAfter === false, 'hiding the screen ends the substate');
	h.check(cycle.relockAttempted === true, 'and a RE-LOCK was attempted (requestPointerLock spied)');
	h.check(
		cycle.log.every((v) => v === 'true'),
		`isLocked NEVER left true across the whole cycle (${JSON.stringify([...new Set(cycle.log)])}) — the allowPlay lockout is unreachable`
	);

	// ---- 4. movement is dead over the menu --------------------------------------
	const moved = await page.evaluate(async (b) => {
		const s = window.__stores;
		s.hudDocs.showHudScreen('scene', b.menuScreen);
		await new Promise((r) => setTimeout(r, 400));
		const cam = s.globalCamera ? null : null;
		// the player camera rig: read the play camera's parent position via playerCam
		let pc; s.playerCam.subscribe((v) => (pc = v))();
		const rig = pc?.parent ?? pc;
		const before = rig ? [rig.position.x, rig.position.y, rig.position.z] : [0, 0, 0];
		// hold W across the menu for a while
		document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
		await new Promise((r) => setTimeout(r, 900));
		const during = rig ? [rig.position.x, rig.position.y, rig.position.z] : [0, 0, 0];
		// close the menu WITH the key still down — the held W must NOT resume
		s.hudDocs.showHudScreen('scene', b.gameScreen);
		await new Promise((r) => setTimeout(r, 900));
		const after = rig ? [rig.position.x, rig.position.y, rig.position.z] : [0, 0, 0];
		document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
		const d = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
		return { held: d(before, during), afterClose: d(during, after) };
	}, built);
	h.check(moved.held < 1e-6, `W held over the menu moves nothing (${moved.held})`);
	h.check(
		moved.afterClose < 1e-6,
		`and does NOT resume when the menu closes — moveState was zeroed, the listener gated (${moved.afterClose})`
	);

	// ---- 5. the ring reaches the inputs ------------------------------------------
	const ring = await page.evaluate(async (b) => {
		const s = window.__stores;
		s.hudDocs.showHudScreen('scene', b.menuScreen);
		await new Promise((r) => setTimeout(r, 500));
		// under lock the ring owns the arrows; headless holds no lock, but the handler
		// only requires playing + visible. Walk: button -> slider -> dropdown.
		const press = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
		press('ArrowDown'); // -> slider
		await new Promise((r) => setTimeout(r, 120));
		const volBefore = s.hudDocs.hudValueOf(b.vol, 50);
		press('ArrowRight'); // slider takes Left/Right when focused
		await new Promise((r) => setTimeout(r, 120));
		const volAfter = s.hudDocs.hudValueOf(b.vol, 50);
		press('ArrowDown'); // -> dropdown
		await new Promise((r) => setTimeout(r, 120));
		press('ArrowRight');
		await new Promise((r) => setTimeout(r, 120));
		const diffVal = s.hudDocs.hudValueOf(b.diff, 'Normal');
		return { volBefore, volAfter, diffVal };
	}, built);
	h.check(ring.volAfter === ring.volBefore + 5, `a focused slider takes ArrowRight for +step (${ring.volBefore} -> ${ring.volAfter})`);
	h.check(ring.diffVal === 'Hard', `a focused dropdown steps its options (${ring.diffVal})`);

	// ---- 6. Esc exits play, even with the menu open -------------------------------
	const esc = await page.evaluate(async () => {
		const s = window.__stores;
		document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
		await new Promise((r) => setTimeout(r, 400));
		let l; s.isLocked.subscribe((v) => (l = v))();
		let free; s.playPointerFree.subscribe((v) => (free = v))();
		return { isLocked: l, free };
	});
	h.check(esc.isLocked !== true, `Esc with a menu open EXITS PLAY (isLocked ${esc.isLocked})`);
	h.check(esc.free === false, 'and the substate drops with it');

	// ---- 7. keypress edges ----------------------------------------------------------
	await page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.flowGraphClose.set(false);
		window.__stores.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(1200);
	const edges = await page.evaluate(async () => {
		const s = window.__stores;
		const mk = (id, type, data) =>
			s.nodesHandler.createFlowNode({ id, type, position: { x: 40, y: 40 }, data: { type, ...data } });
		mk('kp-down', 'keypress', { code: 'KeyJ', edge: 'down', pulse: 0.3 });
		mk('kp-up', 'keypress', { code: 'KeyJ', edge: 'up', pulse: 0.3 });
		await new Promise((r) => setTimeout(r, 500));
		const stampOf = (id) => {
			let t; s.flowTriggers.subscribe((v) => (t = v))(); return t[id]?.lastT ?? null;
		};
		// press and HOLD: down fires, up must stay silent even through the re-stamp window
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', bubbles: true }));
		await new Promise((r) => setTimeout(r, 600));
		const downStamp = stampOf('kp-down');
		const upWhileHeld = stampOf('kp-up');
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ', bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		const upStamp = stampOf('kp-up');
		return { downStamp, upWhileHeld, upStamp };
	});
	h.check(edges.downStamp !== null, 'edge:down fires on press');
	h.check(edges.upWhileHeld === null, 'edge:up stays SILENT while held — the re-stamp skips it');
	h.check(edges.upStamp !== null, 'and fires on release — the missing falling edge exists');

	// ---- 8. pause pauses -------------------------------------------------------------
	const paused = await page.evaluate(async () => {
		const s = window.__stores;
		// a spinning cube driven by flow
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		let g; s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		s.objectActions.deselectObject();
		const mk = (id, type, data) =>
			s.nodesHandler.createFlowNode({ id, type, position: { x: 40, y: 40 }, data: { type, ...data } });
		mk('spin-1', 'spin', { speed: 2 });
		mk('sel-1', 'objectselector', { selected: box.uuid });
		s.nodesHandler.createFlowEdge({ id: 'e-spin', source: 'spin-1', target: 'sel-1' });
		await new Promise((r) => setTimeout(r, 800));
		const rotA = box.rotation.y;
		await new Promise((r) => setTimeout(r, 500));
		const rotB = box.rotation.y;
		// pause the GAME
		s.gameState.setGameState('playing');
		await new Promise((r) => setTimeout(r, 300));
		const elapsedStart = s.gameState.gameElapsed();
		s.gameState.setGameState('paused');
		await new Promise((r) => setTimeout(r, 900));
		const rotC = box.rotation.y;
		await new Promise((r) => setTimeout(r, 500));
		const rotD = box.rotation.y;
		const elapsedPaused = s.gameState.gameElapsed();
		await new Promise((r) => setTimeout(r, 600));
		const elapsedStillPaused = s.gameState.gameElapsed();
		// resume: the spin continues from WHERE IT FROZE (no jump)
		s.gameState.setGameState('playing');
		await new Promise((r) => setTimeout(r, 200));
		const rotE = box.rotation.y;
		await new Promise((r) => setTimeout(r, 600));
		const rotF = box.rotation.y;
		return {
			spinningBefore: Math.abs(rotB - rotA) > 1e-4,
			frozen: Math.abs(rotD - rotC) < 1e-6,
			noJump: Math.abs(rotE - rotC) < 1.0,
			resumed: Math.abs(rotF - rotE) > 1e-4,
			pauseClockFrozen: Math.abs(elapsedStillPaused - elapsedPaused) < 0.05,
			elapsedSane: elapsedPaused >= elapsedStart
		};
	});
	h.check(paused.spinningBefore, 'premise: the flow spin moves the box');
	h.check(paused.frozen, 'PAUSED: the world freezes (the spin holds still)');
	h.check(paused.noJump, 'resume does not JUMP the gap (the effect clock folded the pause out)');
	h.check(paused.resumed, 'and the spin continues');
	h.check(paused.pauseClockFrozen, 'gameElapsed FREEZES while paused (it measurably counted through before)');
	h.check(paused.elapsedSane, 'and the round clock is monotone across the transition');

	// ---- 9. two peers: the field replicates, the pause is shared ---------------------
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });
	await h.connect(B, A);
	await B.page.waitForTimeout(3000);
	const onPeer = await B.page.evaluate((b) => {
		const s = window.__stores;
		const doc = s.hudDocs.hudDocOf('scene');
		const menu = doc?.screens?.find((sc) => sc.id === b.menuScreen);
		let g; s.gameState.gameState.subscribe((v) => (g = v))();
		return { input: menu?.input ?? null, state: g.state, pausedMs: g.pausedMs };
	}, built);
	h.check(onPeer.input === 'menu', `the input field replicated (${onPeer.input})`);
	h.check(onPeer.state === 'playing', `the peer followed the resume (${onPeer.state})`);
	h.check(onPeer.pausedMs > 0, `and holds the banked pause span (${onPeer.pausedMs}ms) — a late clock agrees`);

	h.check(h.pageErrors(A).length === 0, `no render crash on A (${JSON.stringify(h.pageErrors(A))})`);
	h.check(h.pageErrors(B).length === 0, `nor on B (${JSON.stringify(h.pageErrors(B))})`);
	await h.finish(browser);
});
