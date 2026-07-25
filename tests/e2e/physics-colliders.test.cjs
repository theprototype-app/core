// PFX-C follow-ups: primitives spawn DYNAMIC by default (fun to throw), colliders
// are ORIENTED (a rotated ramp collides as a ramp, not its world AABB) with new
// shape choices (sphere/capsule/cylinder), and the Inspector gains collapsible
// sections + a property search box.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();

	// throwaway page warms the vite dep-optimizer for the lazy rapier import
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	const A = await h.setupPage(browser, 'A');

	// 1) primitives are dynamic by default; Terrain stays scenery
	const defaults = await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create Terrain 24 48');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children.find((c) => c.name === 'Box');
		const terrain = g.children.find((c) => c.name === 'Terrain');
		window.__box = box;
		return { box: box?.userData?.physics ?? null, terrain: terrain?.userData?.physics ?? null };
	});
	h.check(
		defaults.box?.mode === 'dynamic' && defaults.box?.mass === 1 && defaults.terrain === null,
		`primitives spawn dynamic (mass 1), Terrain stays scenery (${JSON.stringify(defaults)})`
	);

	// 2) ORIENTED collider: a 30°-rotated static ramp + a sphere-collider ball.
	// With the old world-AABB capture the ramp was a fat axis-aligned block (flat
	// top -> the ball just rests); oriented, the ball rolls DOWN the slope.
	const ballUuid = await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 6 0.4 4');
		cmd('/create Sphere 0.5');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const ramp = g.children[g.children.length - 2];
		const ball = g.children[g.children.length - 1];
		ramp.position.set(0, 2, 0);
		ramp.rotation.z = -0.5; // ~-29°, downhill toward +x
		ramp.updateMatrixWorld(true);
		ramp.userData.physics = { mode: 'static' };
		ball.position.set(-0.5, 3.4, 0);
		ball.updateMatrixWorld(true);
		ball.userData.physics = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		// park the default-dynamic box + terrain out of the way
		window.__box.position.set(30, 1, 30);
		window.__box.updateMatrixWorld(true);
		window.__ball = ball;
		return ball.uuid;
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started'
	);
	await h.eventually(
		() => A.page.evaluate(() => ({ x: window.__ball.position.x, y: window.__ball.position.y })),
		(p) => p.x > 1.2,
		'ball rolls DOWN the rotated ramp (oriented collider)',
		15000
	);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(400);

	// 3) Inspector: search filters sections by rendered text; sections collapse
	await A.page.evaluate(() => window.__stores.objectActions.selectObject(window.__box.uuid, true));
	await A.page.waitForTimeout(700);
	const sectionState = (page) =>
		page.evaluate(() => {
			/** @type {Record<string, boolean>} */
			const state = {};
			for (const s of document.querySelectorAll('#inspector .border-b')) {
				const label = s.querySelector('.ui-section-label')?.textContent?.replace(/[−+]\s*$/, '').trim();
				if (label) state[label] = !s.classList.contains('hidden');
			}
			return state;
		});
	await A.page.evaluate(() => window.__stores.inspectorFilter.set('bounciness'));
	await A.page.waitForTimeout(400);
	let vis = await sectionState(A.page);
	h.check(
		vis.Physics === true && vis.Transform === false && vis.Material === false,
		`search "bounciness" leaves only Physics (${JSON.stringify(vis)})`
	);
	await A.page.evaluate(() => window.__stores.inspectorFilter.set('emit'));
	await A.page.waitForTimeout(400);
	vis = await sectionState(A.page);
	h.check(vis.Particles === true && vis.Physics === false, `search "emit" finds Particles (${JSON.stringify(vis)})`);
	await A.page.evaluate(() => window.__stores.inspectorFilter.set(''));
	await A.page.waitForTimeout(400);
	vis = await sectionState(A.page);
	h.check(vis.Transform === true && vis.Physics === true, 'clearing the search restores all sections');

	// collapse toggles + persists
	await A.page.locator('#inspector button.ui-section-label', { hasText: 'Transform' }).click();
	await A.page.waitForTimeout(200);
	const collapsed = await A.page.evaluate(() => ({
		rows: !!document.querySelector('#inspector-position'),
		stored: localStorage.getItem('inspector:sec:Transform')
	}));
	h.check(collapsed.rows === false && collapsed.stored === 'closed', 'section collapses and persists');
	await A.page.locator('#inspector button.ui-section-label', { hasText: 'Transform' }).click();
	await A.page.waitForTimeout(200);
	const reopened = await A.page.evaluate(() => !!document.querySelector('#inspector-position'));
	h.check(reopened === true, 'section reopens');

	await h.finish(browser);
});
