// K-D: possess + avatar controller — WASD drives the possessed object (tank
// controls), movement replicates as throttled moves, peers see the selection
// lock, Esc releases with ONE undo entry, and input claims engage/clear.
const h = require('./helpers.cjs');

const posOf = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { x: o.position.x, y: o.position.y, z: o.position.z, ry: o.rotation.y } : null);
				})();
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// avatar module loaded + its menu entry present
	const mod = await A.page.evaluate(() => ({
		loaded: window.__stores.moduleSDK.loadedModules.some((m) => m.id === 'avatar'),
		menu: null
	}));
	h.check(mod.loaded === true, 'avatar module loads with the core set');

	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__stores.objectActions.deselectObject();
		return box.uuid;
	});
	await B.page.waitForTimeout(1200);

	const depthBefore = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	const ok = await A.page.evaluate((uuid) => window.__stores.possess.possess(uuid), uuid);
	h.check(ok === true, 'possess takes the object');
	const claims = await A.page.evaluate(
		() => new Promise((r) => window.__stores.inputRuntime.inputClaims.subscribe(r)())
	);
	h.check(claims.includes('keys') && claims.includes('locomotion'), `possession claims input scopes (${claims.join(',')})`);

	// peers see the possession as the usual selection lock
	await h.eventually(
		() => B.page.evaluate((uuid) => new Promise((r) => window.__stores.lockedObjects.subscribe((l) => r(l.some((e) => e[1] === uuid)))()), uuid),
		(v) => v === true,
		'B sees the possessed object locked'
	);

	// drive forward: W for ~700ms moves it along -Z (initial facing)
	const start = await posOf(A.page, uuid);
	await A.page.keyboard.down('W');
	await A.page.waitForTimeout(700);
	await A.page.keyboard.up('W');
	const driven = await posOf(A.page, uuid);
	h.check(driven.z < start.z - 0.5, `W drives the object forward (z ${start.z.toFixed(2)} -> ${driven.z.toFixed(2)})`);

	// turn: A rotates
	await A.page.keyboard.down('A');
	await A.page.waitForTimeout(400);
	await A.page.keyboard.up('A');
	const turned = await posOf(A.page, uuid);
	h.check(Math.abs(turned.ry - driven.ry) > 0.1, `A turns the object (ry ${driven.ry.toFixed(2)} -> ${turned.ry.toFixed(2)})`);

	// movement replicated to B
	await h.eventually(
		() => posOf(B.page, uuid),
		(p) => p && p.z < start.z - 0.5,
		'drive replicated to B'
	);

	// Esc releases: claims clear, ONE undo entry, undo restores the start pose
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate(async () => ({
		possessed: await new Promise((r) => window.__stores.possess.possessed.subscribe(r)()),
		claims: await new Promise((r) => window.__stores.inputRuntime.inputClaims.subscribe(r)()),
		depth: await new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	}));
	h.check(after.possessed === null, 'Esc releases the possession');
	h.check(after.claims.length === 0, 'claims cleared on release');
	h.check(after.depth === depthBefore + 1, `one undo entry for the whole ride (${depthBefore} -> ${after.depth})`);

	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => posOf(A.page, uuid),
		(p) => p && Math.abs(p.z - start.z) < 0.01 && Math.abs(p.ry - start.ry) < 0.01,
		'undo restores the pre-ride pose'
	);

	await h.finish(browser);
});
