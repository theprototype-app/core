// 30 P3 — FREE-CURSOR GAMES + NO EDITOR GRID IN PLAY (roadmap 30 fork 6).
//
// `scenePhysics.play.cursor: 'free'` enters play WITHOUT a pointer lock: the real cursor
// stays visible and AIMS — a tap fires On Click at the object under the cursor, a
// press-drag carries a dynamic body along the cursor ray — while the crosshair has nothing
// to draw. The field is OMITTED at its default, so a scene that never uses it saves
// byte-identically. Independently, the editor grid is never drawn in play (either cursor).
//
// Real input throughout: page.mouse at an object's PROJECTED pixel, with each target placed
// OFF the view centre, so the crosshair ray (NDC 0,0) would miss it — a pass here cannot be
// the old aim getting lucky.
const h = require('./helpers.cjs');

/** @param {any} page @param {string} body */
const sp = (page, body) => page.evaluate((b) => new Function('sp', b)(window.__stores.scenePhysics), body);

/** place an object in front of the ACTIVE camera, offset sideways (camera right) and up
 * @param {any} page @param {string} uuid @param {number} ahead @param {number} right @param {number} [up] */
const placeInView = (page, uuid, ahead, right, up = 0) =>
	page.evaluate(
		([uuid, ahead, right, up]) => {
			const THREE = window.__stores.THREE;
			let camera = null;
			let group = null;
			window.__stores.globalCamera.subscribe((v) => (camera = v))();
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const pos = camera.getWorldPosition(new THREE.Vector3());
			const dir = camera.getWorldDirection(new THREE.Vector3());
			const side = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
			const upv = new THREE.Vector3().crossVectors(side, dir).normalize();
			const at = pos.addScaledVector(dir, ahead).addScaledVector(side, right).addScaledVector(upv, up);
			const object = group.getObjectByProperty('uuid', uuid);
			object.position.copy(at);
			object.updateMatrixWorld();
			window.__stores.objectsGroup.update((v) => v);
			return at.toArray();
		},
		[uuid, ahead, right, up]
	);

/** @param {any} page @param {string} uuid */
const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group.getObjectByProperty('uuid', uuid)?.position.toArray() ?? null;
	}, uuid);

/** @param {any} page */
const counter = (page) =>
	page.evaluate(() => {
		let map = {};
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map.fcCount?.count ?? 0;
	});

/** @param {any} page */
const status = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let locked;
		let scene;
		s.isLocked.subscribe((v) => (locked = v))();
		s.globalScene.subscribe((v) => (scene = v))();
		let grid = null;
		scene?.traverse((o) => {
			if (o.name === 'editor-grid') grid = o;
		});
		return {
			locked,
			lockCalls: window.__lockCalls ?? 0,
			lockElement: !!document.pointerLockElement,
			reticle: !!document.querySelector('#play-reticle'),
			free: s.playCursor.playCursorFree(),
			grid: !!grid && grid.visible !== false
		};
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		// rapier's wasm is lazy; warm the vite dep cache on a throwaway page first
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 720 } },
		storage: { showGrid: 'true', helpersInPlay: 'false' }
	});
	const page = A.page;
	// count every pointer-lock request the app makes, whatever element it asks for
	await page.evaluate(() => {
		window.__lockCalls = 0;
		const original = Element.prototype.requestPointerLock;
		Element.prototype.requestPointerLock = function (...args) {
			window.__lockCalls++;
			return original.apply(this, args);
		};
	});

	const ids = await page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		let group = null;
		cmd('/create box');
		cmd('/create box');
		cmd('/create box');
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const [target, crate, floor] = group.children.slice(-3);
		target.name = 'Target';
		target.userData.physics = { mode: 'static' };
		crate.name = 'Crate';
		crate.userData.physics = { mode: 'dynamic', mass: 1 };
		floor.name = 'Floor';
		floor.scale.set(20, 0.2, 20);
		floor.position.set(0, -0.1, 0);
		floor.userData.physics = { mode: 'static' };
		window.__stores.objectsGroup.update((v) => v);
		return { target: target.uuid, crate: crate.uuid };
	});
	await page.waitForTimeout(1500);

	// ===================================================================== 1. the field
	const saved = await page.evaluate(() => {
		const sp = window.__stores.scenePhysics;
		sp.setScenePhysics({ gravity: -9 }); // a non-default scene, so a snapshot exists
		const plain = sp.scenePhysicsSnapshot();
		sp.setScenePhysics({ play: { cursor: 'locked' } });
		const locked = sp.scenePhysicsSnapshot();
		sp.setScenePhysics({ play: { cursor: 'nonsense' } });
		const junk = sp.scenePhysicsSnapshot();
		sp.setScenePhysics({ play: { cursor: 'free' } });
		const free = sp.scenePhysicsSnapshot();
		return { plain: plain?.play, locked: locked?.play, junk: junk?.play, free: free?.play };
	});
	h.check(!!saved.plain && !('cursor' in saved.plain), `a scene saved without the field has no cursor key (${JSON.stringify(saved.plain)})`);
	h.check(!('cursor' in (saved.locked ?? {})), "'locked' is the default and is never written");
	h.check(!('cursor' in (saved.junk ?? {})), 'an unknown value normalizes to the default (not written)');
	h.check(saved.free?.cursor === 'free', `'free' is written (${JSON.stringify(saved.free)})`);
	const resolved = await page.evaluate(() => window.__stores.playSettings.resolvePlaySettings(null).cursor);
	h.check(resolved === 'free', `resolvePlaySettings carries it (${resolved})`);

	// ===================================================================== 2. the grid, editor side
	let st = await status(page);
	h.check(st.grid, 'premise: the editor grid is drawn in the editor');

	// ===================================================================== 3. enter play, free
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.playMode.requestPlay());
	await h.eventually(() => status(page), (v) => v.locked === true, 'play mode is on', 5000);
	await page.waitForTimeout(1200);
	st = await status(page);
	h.check(st.free, 'the cursor is free');
	h.check(st.lockCalls === 0, `entering play asked for NO pointer lock (${st.lockCalls} requests)`);
	h.check(!st.lockElement, 'and nothing holds one');
	h.check(!st.reticle, 'the crosshair is not drawn (the cursor aims)');
	h.check(!st.grid, 'the editor grid is hidden in play');

	// ===================================================================== 4. a real click fires On Click
	await page.evaluate((uuid) => {
		const nodes = [
			{ id: 'fcClick', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 }, class: 'w-[150px]' },
			{ id: 'fcSel', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid }, class: 'w-[150px]' },
			{ id: 'fcCount', type: 'counter', position: { x: 0, y: 200 }, data: { type: 'counter', op: 'up', step: 1 }, class: 'w-[150px]' }
		];
		const edges = [
			{ id: 'e-fcClick-fcSel', source: 'fcClick', target: 'fcSel' },
			{ id: 'e-fcClick-fcCount', source: 'fcClick', target: 'fcCount' }
		];
		window.__stores.flowGraphs.update((graphs) => ({ ...graphs, scene: { nodes, edges } }));
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
	}, ids.target);
	// off-centre: 1.6 m right of the view axis at 5 m, so the crosshair would miss it
	const targetAt = await placeInView(page, ids.target, 5, 1.6);
	await page.waitForTimeout(600);
	const tp = await h.projectPoint(page, targetAt);
	const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, tp);
	h.check(under === 'CANVAS', `premise: the target's pixel is the viewport (${under})`);
	h.check(Math.abs(tp.x - 640) > 60, `premise: the target is off the view centre (${Math.round(tp.x)}px)`);
	const before = await counter(page);
	await page.mouse.move(tp.x, tp.y);
	await page.mouse.down();
	await page.waitForTimeout(90);
	await page.mouse.up();
	await h.eventually(() => counter(page), (n) => n > before, `a real click at the target's pixel fires its On Click (${before} -> ?)`, 3000);
	const debugClick = await page.evaluate(() => window.__stores.playInteract.playInteractDebug().lastUp);
	h.check(debugClick === 'click', `recorded as a click on an object (${debugClick})`);

	// ===================================================================== 5. a real press-drag carries a body
	const crateAt = await placeInView(page, ids.crate, 3, -0.9);
	await page.waitForTimeout(500);
	const cp = await h.projectPoint(page, crateAt);
	await page.mouse.move(cp.x, cp.y);
	await page.mouse.down();
	await page.waitForTimeout(250);
	const carrying = await page.evaluate(() => window.__stores.playInteract.playInteractDebug().carrying);
	h.check(carrying === ids.crate, `a press on the crate's pixel grabs it (${carrying === ids.crate})`);
	// drag the cursor 260px to the right; the carried crate follows the cursor ray
	const startPos = await posOf(page, ids.crate);
	for (let i = 1; i <= 10; i++) {
		await page.mouse.move(cp.x + i * 26, cp.y);
		await page.waitForTimeout(40);
	}
	await page.waitForTimeout(700);
	const draggedPos = await posOf(page, ids.crate);
	const moved = Math.hypot(draggedPos[0] - startPos[0], draggedPos[2] - startPos[2]);
	const shown = await h.projectPoint(page, draggedPos);
	h.check(moved > 0.5, `the crate travelled with the cursor (${moved.toFixed(2)} m)`);
	h.check(Math.abs(shown.x - (cp.x + 260)) < 90, `and sits under it on screen (${Math.round(shown.x)}px vs cursor ${Math.round(cp.x + 260)}px)`);
	await page.mouse.up();
	await page.waitForTimeout(300);
	const released = await page.evaluate(() => window.__stores.playInteract.playInteractDebug().carrying);
	h.check(released === null, 'releasing lets go');

	// a click on page CHROME is not a world gesture in a free-cursor game
	const chromeClick = await page.evaluate(() => {
		const before = window.__stores.playInteract.playInteractDebug().lastUp;
		const b = document.createElement('button');
		b.textContent = 'chrome';
		b.style.cssText = 'position:fixed;left:4px;top:300px;z-index:99999';
		document.body.appendChild(b);
		const r = b.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, before };
	});
	const beforeChrome = await counter(page);
	await page.mouse.click(chromeClick.x, chromeClick.y);
	await page.waitForTimeout(400);
	h.check((await counter(page)) === beforeChrome, 'a press on page chrome is not taken as a world tap');

	// ===================================================================== 6. Escape leaves
	await page.keyboard.press('Escape');
	await h.eventually(() => status(page), (v) => v.locked !== true, 'Escape leaves a free-cursor game', 5000);
	await h.eventually(() => status(page), (v) => v.grid, 'the grid is back in the editor', 3000);

	// ===================================================================== 7. locked: the lock IS asked for, the grid still hides
	await sp(page, 'sp.setScenePhysics({ play: { cursor: "locked" } })');
	await page.evaluate(() => {
		window.__lockCalls = 0;
	});
	await page.waitForTimeout(2200); // past the exit settle
	await page.evaluate(() => window.__stores.playMode.requestPlay());
	await h.eventually(() => status(page), (v) => v.locked === true, 'play mode again, cursor locked', 5000);
	await page.waitForTimeout(800);
	st = await status(page);
	h.check(st.lockCalls > 0, `a LOCKED game still asks for the pointer lock (${st.lockCalls}) — the spy works`);
	h.check(!st.free, 'and reads as not free');
	h.check(!st.grid, 'the editor grid is hidden in play with a locked cursor too');
	await page.evaluate(() => window.__stores.playMode.exitPlay());
	await page.waitForTimeout(500);

	await h.finish(browser);
});
