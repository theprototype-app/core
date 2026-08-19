// 21-B B4 — the scene ground plane, the out-of-bounds rule, and the solver
// defaults worth having.
//
// The load-bearing check is 6.x, the groundHandle ALIASING guard: groundHandle
// is compared by value in queueContact and rapier reuses small integer handles,
// so a stale handle left behind by a disabled ground can alias a real collider
// and silently swallow that body's impacts. It is asserted through On Impact,
// which is the thing a user would notice.

const h = require('./helpers.cjs');

const sp = (page, body) =>
	page.evaluate((b) => new Function('sp', b)(window.__stores.scenePhysics), body);
const phys = (page, body) =>
	page.evaluate((b) => new Function('p', b)(window.__stores.physics), body);

/** drop N boxes at the given poses and return their uuids */
async function makeBoxes(page, specs) {
	return page.evaluate(async (specs) => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		let group = null;
		const made = [];
		for (const spec of specs) {
			cmd('/create box');
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const box = group.children[group.children.length - 1];
			box.name = spec.name;
			box.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
			box.userData.physics = { mode: 'dynamic', mass: 1, ...(spec.physics ?? {}) };
			made.push(box.uuid);
		}
		window.__stores.objectsGroup.update((v) => v);
		return made;
	}, specs);
}

const yOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		return o ? o.position.y : null;
	}, uuid);

const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		return o ? o.position.toArray() : null;
	}, uuid);

async function run(page, ms) {
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(ms);
}
async function stop(page) {
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await page.waitForTimeout(200);
}
async function clearScene(page) {
	await page.evaluate(() => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const uuids = group.children.map((/** @type {any} */ c) => c.uuid);
		window.__stores.objectActions.deleteObjectsByUuid(uuids);
	});
	await page.waitForTimeout(300);
}

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(() => window.__stores.objectActions.deselectObject());

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the ground top face lands on `height` ===');

	let [box] = await makeBoxes(page, [{ name: 'Dropper', pos: [0, 6, 0] }]);
	await sp(page, 'sp.setScenePhysics({ ground: { enabled: true, height: 2 } })');
	await run(page, 3500);
	const restedAt = await yOf(page, box);
	h.check(
		Math.abs(restedAt - 2.5) < 0.15,
		'1.1 a 1m box dropped onto height 2 rests at 2.5 (got ' + restedAt.toFixed(3) + ')'
	);
	const world = await phys(page, 'return p.physicsWorldDebug()');
	h.check(world.groundEnabled === true && world.groundHandle >= 0, '1.2 the ground collider exists');
	await stop(page);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. disabling the ground lets it fall past ===');

	await sp(page, 'sp.setScenePhysics({ ground: { enabled: false }, bounds: { limit: -10000 } })');
	await page.evaluate(
		(uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			group.getObjectByProperty('uuid', uuid).position.set(0, 6, 0);
		},
		box
	);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => yOf(page, box),
		(y) => y < 0,
		'2.1 with no ground the box falls past 0'
	);
	const off = await phys(page, 'return p.physicsWorldDebug()');
	h.check(
		off.groundHandle === -1 && off.groundEnabled === false,
		'2.2 groundHandle is -1 on the disabled path, not a stale value (got ' + off.groundHandle + ')'
	);
	await stop(page);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. a mid-sim height change rebuilds without a restart ===');

	await clearScene(page);
	[box] = await makeBoxes(page, [{ name: 'Dropper', pos: [0, 4, 0] }]);
	await sp(page, 'sp.setScenePhysics({ ground: { enabled: true, height: 0 }, bounds: { limit: -100 } })');
	await run(page, 3000);
	const onFloor = await yOf(page, box);
	h.check(Math.abs(onFloor - 0.5) < 0.15, '3.1 (premise) it rests on the floor at 0.5');
	const bodiesBefore = await phys(page, 'return p.physicsDebug().length');
	// nudge the floor UP by 0.2, i.e. into the resting box: the interesting case,
	// because rapier has to resolve a penetration that appeared out of nothing
	await sp(page, 'sp.setScenePhysics({ ground: { height: 0.2 } })');
	await page.waitForTimeout(1200);
	const stillRunning = await phys(page, 'return p.physicsWorldDebug()');
	h.check(
		stillRunning.running === true && stillRunning.bodies === bodiesBefore,
		'3.2 the run survives the swap — same world, same bodies'
	);
	const settled = await yOf(page, box);
	const vel = await phys(page, 'const v = p.physicsDebug()[0].linvel; return Math.hypot(v.x, v.y, v.z)');
	h.check(
		Math.abs(settled - 0.7) < 0.2,
		'3.3 it settles on the NEW floor without a restart (y = ' + settled.toFixed(2) + ', expected 0.70)'
	);
	h.check(
		vel < 2,
		'3.4 ...and the resolved penetration does not launch it (|v| = ' + vel.toFixed(2) + ' m/s)'
	);
	await stop(page);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. friction actually reaches the ground collider ===');

	await clearScene(page);
	/** slide the same box along an icy vs a grippy floor and compare distance */
	async function slideDistance(friction) {
		await clearScene(page);
		const [slider] = await makeBoxes(page, [{ name: 'Slider', pos: [0, 0.5, 0], physics: { friction: 0.05 } }]);
		await sp(page, 'sp.setScenePhysics({ ground: { enabled: true, height: 0, friction: ' + friction + ' } })');
		await run(page, 300);
		await phys(page, 'return p.applyImpulse("' + slider + '", [6, 0, 0])');
		await page.waitForTimeout(3000);
		const end = await posOf(page, slider);
		await stop(page);
		return end[0];
	}
	const icy = await slideDistance(0.02);
	const grippy = await slideDistance(1.6);
	h.check(
		icy > grippy + 0.2,
		'4.1 a slippery floor slides further than a grippy one (' +
			icy.toFixed(2) +
			' m vs ' +
			grippy.toFixed(2) +
			' m)'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. out of bounds: freeze / respawn / delete ===');

	await clearScene(page);
	const spawn = [1.5, 5, 0];
	let [faller] = await makeBoxes(page, [{ name: 'Faller', pos: spawn }]);
	await sp(
		page,
		'sp.setScenePhysics({ ground: { enabled: false }, bounds: { limit: -6, action: "respawn" } })'
	);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	// A respawn is instantaneous — the frame the body crosses the limit is the
	// frame it is teleported — so "sample it while it is below" is a race by
	// construction. Nothing else moves a FALLING body upward, so detect the JUMP.
	let minSeen = Infinity;
	/** @type {number[]|null} */ let afterJump = null;
	let previous = await posOf(page, faller);
	for (let i = 0; i < 40; i++) {
		await page.waitForTimeout(120);
		const pos = await posOf(page, faller);
		minSeen = Math.min(minSeen, pos[1]);
		if (!afterJump && pos[1] - previous[1] > 3) afterJump = pos;
		previous = pos;
	}
	h.check(minSeen < 0, '5.1 (premise) it fell well below its start (min y ' + minSeen.toFixed(2) + ')');
	h.check(
		!!afterJump,
		'5.2 something moved the falling body UP, which only a respawn does'
	);
	h.check(
		!!afterJump && Math.abs(afterJump[1] - spawn[1]) < 1.2 && Math.abs(afterJump[0] - spawn[0]) < 0.05,
		'5.3 ...and it landed back on its sim-start pose (' +
			(afterJump ?? []).map((v) => v.toFixed(2)).join(', ') +
			' vs ' +
			spawn.join(', ') +
			')'
	);
	await stop(page);

	await sp(page, 'sp.setScenePhysics({ bounds: { action: "freeze" } })');
	await page.evaluate(
		([uuid, spawn]) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			group.getObjectByProperty('uuid', uuid).position.set(spawn[0], spawn[1], spawn[2]);
		},
		[faller, spawn]
	);
	await run(page, 4000);
	const frozen = await phys(page, 'return p.physicsDebug()[0]');
	const frozenY = await yOf(page, faller);
	await page.waitForTimeout(1200);
	const stillY = await yOf(page, faller);
	h.check(frozen?.oob === true, '5.4 freeze marks the body out of bounds');
	h.check(
		Math.abs(stillY - frozenY) < 0.01,
		'5.5 ...and it stops falling (' + frozenY.toFixed(2) + ' -> ' + stillY.toFixed(2) + ')'
	);
	await stop(page);

	await clearScene(page);
	const [doomed] = await makeBoxes(page, [{ name: 'Doomed', pos: [0, 2, 0] }]);
	await sp(page, 'sp.setScenePhysics({ bounds: { action: "delete" } })');
	await run(page, 4500);
	const gone = await page.evaluate((uuid) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return !group.getObjectByProperty('uuid', uuid);
	}, doomed);
	h.check(gone, '5.6 delete removes the object from the scene (replicated + undoable)');
	const undone = await page.evaluate(async (uuid) => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 400));
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return !!group.getObjectByProperty('uuid', uuid);
	}, doomed);
	h.check(undone, '5.7 ...and Ctrl+Z brings it back, so it went through the real delete path');
	await stop(page);

	// three at once -> exactly ONE toast
	await clearScene(page);
	await makeBoxes(page, [
		{ name: 'F1', pos: [-1, 2, 0] },
		{ name: 'F2', pos: [0, 2, 0] },
		{ name: 'F3', pos: [1, 2, 0] }
	]);
	await sp(page, 'sp.setScenePhysics({ bounds: { limit: -6, action: "respawn" } })');
	await page.evaluate(() => window.__stores.clearToast());
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	const readToasts = () =>
		page.evaluate(() => {
			let list = [];
			window.__stores.toastStore.subscribe((v) => (list = v))();
			return list.map((t) => (typeof t === 'string' ? t : t.text));
		});
	// respawn RE-ARMS the bodies, so they fall again and a long window would
	// legitimately produce a second burst — watch exactly ONE burst
	await h.eventually(
		async () => (await readToasts()).filter((t) => String(t).includes('out of bounds')).length,
		(n) => n > 0,
		'5.8 (premise) the first out-of-bounds burst produced a toast'
	);
	await page.waitForTimeout(700);
	const toasts = await readToasts();
	const oobToasts = toasts.filter((t) => String(t).includes('out of bounds'));
	h.check(
		oobToasts.length === 1,
		'5.9 three simultaneous OOB bodies produce exactly ONE toast (' +
			oobToasts.length +
			': ' +
			JSON.stringify(oobToasts) +
			')'
	);
	h.check(
		String(oobToasts[0] ?? '').includes('3 objects'),
		'5.10 ...and it counts them (' + oobToasts[0] + ')'
	);
	await stop(page);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. the groundHandle aliasing guard ===');

	// groundHandle is compared BY VALUE in queueContact, and rapier reuses small
	// integer handles. If the disabled path left a stale handle behind, it could
	// equal a REAL collider's handle and that body's impacts would be skipped in
	// silence. So: no ground at all, one box dropped on a static pad, and an On
	// Impact node that must still fire. The check prints the dropper's own
	// collider handle, which is exactly the value a stale groundHandle would have
	// carried — that is what makes this an aliasing guard and not a smoke test.
	await clearScene(page);
	const [pad, dropper] = await makeBoxes(page, [
		{ name: 'Pad', pos: [0, 0.5, 0], physics: { mode: 'static' } },
		{ name: 'Dropper', pos: [0, 5, 0] }
	]);
	void pad;
	// what handle does the ground take when it exists? That is the value a stale
	// groundHandle would carry into the run below.
	await sp(page, 'sp.setScenePhysics({ ground: { enabled: true, height: 0 }, bounds: { limit: -50 } })');
	await run(page, 300);
	const groundHandleWhenOn = (await phys(page, 'return p.physicsWorldDebug()')).groundHandle;
	await stop(page);
	await sp(page, 'sp.setScenePhysics({ ground: { enabled: false } })');
	await page.evaluate(
		([a, b]) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			group.getObjectByProperty('uuid', a).position.set(0, 0.5, 0);
			group.getObjectByProperty('uuid', b).position.set(0, 5, 0);
		},
		[pad, dropper]
	);
	await page.evaluate((uuid) => {
		const nodes = [
			{ id: 'imp1', type: 'onimpact', position: { x: 0, y: 0 }, data: { type: 'onimpact', pulse: 0.3, minStrength: 0.5 }, class: 'w-[150px]' },
			{ id: 'selI', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid }, class: 'w-[150px]' },
			{ id: 'cnt1', type: 'counter', position: { x: 0, y: 200 }, data: { type: 'counter', op: 'up', step: 1 }, class: 'w-[150px]' }
		];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set([
			{ id: 'e-imp1-selI', source: 'imp1', target: 'selI' },
			{ id: 'e-imp1-cnt1', source: 'imp1', target: 'cnt1' }
		]);
	}, dropper);
	await page.waitForTimeout(400);

	await run(page, 3500);
	const world6 = await phys(page, 'return p.physicsWorldDebug()');
	h.check(
		world6.groundHandle === -1,
		'6.1 the ground is off and its handle is -1 (got ' + world6.groundHandle + ')'
	);
	const landed = await yOf(page, dropper);
	h.check(
		landed > 0.9 && landed < 2.5,
		'6.2 (premise) the box really landed on the pad (y = ' + landed.toFixed(2) + ')'
	);
	const owned = world6.ownerHandles;
	h.check(
		owned.some((v) => v === groundHandleWhenOn),
		'6.3 (premise) a REAL collider now holds the handle the ground used to have — ' +
			'exactly the aliasing a stale groundHandle would cause (' +
			JSON.stringify(owned) +
			' contains ' +
			groundHandleWhenOn +
			')'
	);
	const triggers = await page.evaluate(() => {
		let map = {};
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map;
	});
	h.check(
		(triggers.cnt1?.count ?? 0) > 0,
		'6.4 On Impact still fired with no ground collider present (counter = ' +
			(triggers.cnt1?.count ?? 0) +
			')'
	);
	await stop(page);
	await page.evaluate(() => {
		window.__stores.flowNodes.set([]);
		window.__stores.flowEdges.set([]);
	});

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. time scale, damping and CCD ===');

	await clearScene(page);
	/** how far a box falls in a fixed WALL-CLOCK window at a given time scale */
	async function fallIn(timeScale, ms) {
		await clearScene(page);
		const [f] = await makeBoxes(page, [{ name: 'Timed', pos: [0, 40, 0] }]);
		await sp(
			page,
			'sp.setScenePhysics({ timeScale: ' +
				timeScale +
				', ground: { enabled: false }, bounds: { limit: -10000 } })'
		);
		await run(page, ms);
		const y = await yOf(page, f);
		await stop(page);
		return 40 - y;
	}
	const fullSpeed = await fallIn(1, 1200);
	const quarter = await fallIn(0.25, 1200);
	h.check(
		quarter < fullSpeed * 0.35 && quarter > 0.01,
		'7.1 timeScale 0.25 falls far less in the same wall-clock window (' +
			quarter.toFixed(2) +
			' m vs ' +
			fullSpeed.toFixed(2) +
			' m)'
	);
	await sp(page, 'sp.setScenePhysics({ timeScale: 1 })');

	await clearScene(page);
	const [damped] = await makeBoxes(page, [{ name: 'Damped', pos: [0, 0.5, 0] }]);
	await sp(page, 'sp.setScenePhysics({ ground: { enabled: true, height: 0 }, damping: { linear: 0 } })');
	await run(page, 400);
	const dampingApplied = await phys(page, 'return p.physicsDebug()[0]');
	h.check(!!dampingApplied, '7.2 (premise) a dynamic body exists for the damping check');
	await sp(page, 'sp.setScenePhysics({ damping: { linear: 4 } })');
	await page.waitForTimeout(300);
	await phys(page, 'return p.applyImpulse("' + damped + '", [6, 0, 0])');
	await page.waitForTimeout(2500);
	const dampedX = (await posOf(page, damped))[0];
	await stop(page);
	await sp(page, 'sp.setScenePhysics({ damping: { linear: 0 } })');
	await clearScene(page);
	const [free] = await makeBoxes(page, [{ name: 'Free', pos: [0, 0.5, 0] }]);
	await run(page, 400);
	await phys(page, 'return p.applyImpulse("' + free + '", [6, 0, 0])');
	await page.waitForTimeout(2500);
	const freeX = (await posOf(page, free))[0];
	await stop(page);
	h.check(
		freeX > dampedX + 0.2,
		'7.3 linear damping applied LIVE shortens the slide (' +
			dampedX.toFixed(2) +
			' m damped vs ' +
			freeX.toFixed(2) +
			' m free)'
	);

	await clearScene(page);
	const [fast] = await makeBoxes(page, [{ name: 'Fast', pos: [0, 0.5, 0] }]);
	await sp(page, 'sp.setScenePhysics({ ccd: true })');
	await run(page, 400);
	const ccdState = await phys(page, 'return p.physicsDebug()[0]');
	h.check(ccdState?.ccd === true, '7.4 the scene CCD toggle reaches the body');
	await sp(page, 'sp.setScenePhysics({ ccd: false })');
	await page.waitForTimeout(300);
	const ccdOff = await phys(page, 'return p.physicsDebug()[0]');
	h.check(ccdOff?.ccd === false, '7.5 ...and turning it off reaches it too, mid-sim');
	// a fast RELEASE turns it on regardless of the scene toggle
	await phys(page, 'return p.holdBody("' + fast + '")');
	const thrown = await phys(
		page,
		'p.releaseBody("' + fast + '", { linvel: [12, 0, 0], angvel: [0, 0, 0] }); return p.physicsDebug()[0]'
	);
	h.check(
		thrown?.ccd === true,
		'7.6 a fast throw enables CCD for itself whatever the scene says (the tunnelling case)'
	);
	await stop(page);

	// ---------------------------------------------------------------- section 8
	console.log('\n=== 8. the ground affordance follows showColliders ===');

	await sp(page, 'sp.setScenePhysics({ ground: { enabled: true, height: 1.25 } })');
	await page.evaluate(() => window.__stores.colliderHelpers.showColliders.set(true));
	await page.waitForTimeout(400);
	const shown = await page.evaluate(() => window.__stores.colliderHelpers.groundHelperDebug());
	h.check(shown && Math.abs(shown.y - 1.25) < 1e-6, '8.1 the proxy sits at the ground height');
	await page.evaluate(() => window.__stores.colliderHelpers.showColliders.set(false));
	await page.waitForTimeout(400);
	const hidden = await page.evaluate(() => window.__stores.colliderHelpers.groundHelperDebug());
	h.check(hidden === null, '8.2 ...and disappears with the collider toggle (a LOCAL pref)');

	await h.finish(browser);
});
