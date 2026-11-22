// 102b row 1: per-object GRAVITY SCALE and LINEAR / ANGULAR DAMPING (Inspector ▸ Physics, dynamic
// bodies; userData.physics.{gravityScale, linearDamping, angularDamping}; set_physics). Four balls drop
// side by side in one run: a plain one (the counterfactual: it falls like every ball before 102b), one
// at gravity 0 (stays where it is), one at gravity -0.5 (rises) and one with air drag 5 (falls, but far
// slower). The Inspector row is typed into (the keyboard path), the value replicates to the peer, a
// PEER's own run reads it, a mid-run change reaches the live body with no restart, Reset removes the
// key (an untouched scene saves byte-identical), the set_physics agent tool clamps, and a reload brings
// the values back. Red on v1.70.0: there is no row, no key is read, physicsDebug has no gravityScale.
const h = require('./helpers.cjs');

/** reload ALONE (peers closed first, so nothing can come back from them) and restore the autosave
 * through restoreSnapshot (what the Restore button runs); long waits — a loaded slot boots slowly */
async function reloadAndRestore(peer, others) {
	for (const o of others) await o.ctx.close().catch(() => {});
	await peer.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	await peer.page.waitForTimeout(2000);
	await peer.page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
	await peer.page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 180000 });
	await peer.page.waitForFunction(
		() => {
			let v;
			window.__tp.test.v1.autosave.restoreAvailable.subscribe((x) => (v = x))();
			return !!v;
		},
		null,
		{ timeout: 60000, polling: 250 }
	);
	await peer.page.evaluate(() => window.__tp.test.v1.autosave.restoreSnapshot());
}

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const ids = await A.page.evaluate(() => {
		const s = window.__tp.test.v1;
		const cmd = s.commandsHandler.sceneCommand;
		const names = ['Plain', 'Float', 'Riser', 'Feather'];
		for (let i = 0; i < names.length; i++) cmd('/create Sphere 0.25');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const balls = g.children.slice(-names.length);
		const out = {};
		balls.forEach((ball, i) => {
			ball.name = names[i];
			s.physics.setPhysicsFor(ball.uuid, { mode: 'dynamic', mass: 1, collider: 'sphere' });
			out[names[i]] = ball.uuid;
		});
		return out;
	});
	const place = (page) =>
		page.evaluate((u) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			Object.values(u).forEach((uuid, i) => {
				const o = g.getObjectByProperty('uuid', uuid);
				o.position.set(-3 + i * 2, 5, 0);
				o.quaternion.set(0, 0, 0, 1);
				o.updateMatrixWorld(true);
			});
		}, ids);
	const heights = (page) =>
		page.evaluate((u) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			return Object.fromEntries(Object.entries(u).map(([n, uuid]) => [n, g.getObjectByProperty('uuid', uuid).position.y]));
		}, ids);
	const physicsOf = (page, name) =>
		page.evaluate((uuid) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			return JSON.parse(JSON.stringify(g.getObjectByProperty('uuid', uuid)?.userData?.physics ?? null));
		}, ids[name]);
	const simOn = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.physics.simulating.subscribe(r)()));
	const debugOf = (page, name) =>
		page.evaluate((uuid) => window.__tp.test.v1.physics.physicsDebug().find((e) => e.uuid === uuid) ?? null, ids[name]);
	/** run the simulation on `page` until the PLAIN ball has dropped `fall` metres (sim time, not wall time:
	 * a loaded slot steps slowly), then return the heights */
	const drop = async (page, label, fall = 1.5, { stop = true } = {}) => {
		if (!(await simOn(page))) await page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
		await h.eventually(() => page.evaluate((u) => window.__tp.test.v1.physics.physicsDebug().filter((e) => Object.values(u).includes(e.uuid)).length, ids), (n) => n === 4, `${label}: four bodies`, 15000);
		await h.eventually(() => heights(page), (y) => y.Plain < 5 - fall, `${label}: the plain ball falls ${fall} m`, 30000);
		const out = await heights(page);
		if (stop) await page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
		return out;
	};

	// 1) the counterfactual: nothing set — all four fall alike, and the body reads the scene's values
	await place(A.page);
	const before = await drop(A.page, 'untouched', 1.5, { stop: false });
	const plainBody = await debugOf(A.page, 'Plain');
	await A.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
	const spread = Math.max(...Object.values(before)) - Math.min(...Object.values(before));
	h.check(spread < 0.05, `COUNTERFACTUAL: with no own values the four balls fall together (${JSON.stringify(before)})`);
	h.check(plainBody?.gravityScale === 1 && Math.abs(plainBody.angularDamping - 0.05) < 1e-6 && plainBody.linearDamping === 0, `an untouched body = gravity 1 and the scene damping (${JSON.stringify({ g: plainBody?.gravityScale, l: plainBody?.linearDamping, a: plainBody?.angularDamping })})`);
	h.check((await physicsOf(A.page, 'Plain')) && !('gravityScale' in (await physicsOf(A.page, 'Plain'))), 'and writes no key');

	// 2) the real Inspector row, typed into (the keyboard path)
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u.Float, true), ids);
	await h.eventually(() => A.page.evaluate(() => !!document.querySelector('#physics-gravity-scale')), (v) => v, 'the Gravity row renders for a dynamic body', 15000);
	const row = await A.page.evaluate(() => ({
		own: document.querySelector('#physics-gravity-scale-row')?.dataset.own,
		value: document.querySelector('#physics-gravity-scale')?.value,
		title: document.querySelector('#physics-gravity-scale-row [title]')?.getAttribute('title') ?? '',
		drag: !!document.querySelector('#physics-linear-damping') && !!document.querySelector('#physics-angular-damping')
	}));
	h.check(row.own === '0' && Number(row.value) === 1, `the row starts at 1 with no own value (${JSON.stringify(row)})`);
	h.check(/gravity/i.test(row.title) && row.drag, 'the rows carry a tooltip, and both drag rows render');
	const field = A.page.locator('#physics-gravity-scale');
	await field.click();
	await A.page.keyboard.press('Control+A');
	await A.page.keyboard.type('0');
	await A.page.keyboard.press('Tab');
	await h.eventually(() => physicsOf(A.page, 'Float'), (p) => p?.gravityScale === 0, 'typing 0 writes gravityScale 0 on the object', 8000);
	await h.eventually(() => physicsOf(B.page, 'Float'), (p) => p?.gravityScale === 0, 'and it replicates to the peer', 10000);
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());

	// 3) the other two through the shared write path; the agent tool clamps
	const tool = await A.page.evaluate(
		(u) =>
			window.__tp.test.v1.aiTools
				.executeAiTool('set_physics', { updates: [{ uuid: u.Riser, gravityScale: -0.5 }, { uuid: u.Feather, linearDamping: 99 }] }, { physics: true })
				.catch((e) => ({ error: String(e) })),
		ids
	);
	h.check(!tool.error && tool.updated?.length === 2, `set_physics takes the new keys (${JSON.stringify(tool).slice(0, 200)})`);
	h.check((await physicsOf(A.page, 'Feather'))?.linearDamping === 5, 'set_physics clamps air drag to 5');

	// 4) one run: float stays, riser rises, feather falls slower than plain
	await place(A.page);
	const run = await drop(A.page, 'tuned', 2.5, { stop: false });
	const floatBody = await debugOf(A.page, 'Float');
	await A.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
	h.check(Math.abs(run.Float - 5) < 0.02, `gravity 0: the ball stays where it is (y ${run.Float.toFixed(3)})`);
	h.check(floatBody?.gravityScale === 0, `the live body holds gravity scale 0 (${floatBody?.gravityScale})`);
	h.check(run.Riser > 5.05, `gravity -0.5: the ball rises (y ${run.Riser.toFixed(3)})`);
	h.check(run.Feather < 5 && 5 - run.Feather < 0.7 * (5 - run.Plain), `air drag 5: it falls, far slower than the plain ball (${run.Feather.toFixed(2)} vs ${run.Plain.toFixed(2)})`);

	// 5) a PEER's own run reads the replicated values
	await h.eventually(() => physicsOf(B.page, 'Feather'), (p) => p?.linearDamping === 5, 'premise: the peer holds the drag', 10000);
	await place(B.page);
	const peerRun = await drop(B.page, 'peer run', 2.5);
	h.check(Math.abs(peerRun.Float - 5) < 0.02 && peerRun.Riser > 5.05, `the peer's run floats and lifts the same balls (${JSON.stringify(peerRun)})`);
	await A.page.waitForTimeout(1500);

	// 6) a mid-run change reaches the live body with no restart
	await place(A.page);
	await drop(A.page, 'live', 0.3, { stop: false });
	const y0 = (await heights(A.page)).Float;
	await A.page.evaluate((u) => window.__tp.test.v1.physics.setPhysicsFor(u.Float, { gravityScale: 1 }), ids);
	let y1 = y0;
	await h.eventually(async () => (y1 = (await heights(A.page)).Float), (y) => y < y0 - 0.3, 'setting gravity 1 mid-run drops the floating ball with no restart', 30000);
	await A.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
	h.check(y1 < y0 - 0.3, `the floating ball fell after the mid-run change (${y0.toFixed(2)} -> ${y1.toFixed(2)})`);

	// 7) Reset = no key (the scene's value again); undo puts the value back
	await A.page.evaluate((u) => window.__tp.test.v1.physics.setPhysicsFor(u.Float, { gravityScale: null }), ids);
	h.check(!('gravityScale' in ((await physicsOf(A.page, 'Float')) ?? {})), 'Reset removes the key — the object saves as it did before 102b');
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	h.check((await physicsOf(A.page, 'Float'))?.gravityScale === 1, 'undo puts the value back');
	await A.page.evaluate((u) => window.__tp.test.v1.physics.setPhysicsFor(u.Float, { gravityScale: 0 }), ids);

	// 8) reload: the values come back from the autosave (LAST — a reload gives A a new peer id)
	await reloadAndRestore(A, [B]);
	await h.eventually(() => physicsOf(A.page, 'Feather').catch(() => null), (p) => p?.linearDamping === 5, 'after a reload the air drag is back', 30000);
	const reloaded = { float: await physicsOf(A.page, 'Float'), riser: await physicsOf(A.page, 'Riser') };
	h.check(reloaded.float?.gravityScale === 0 && reloaded.riser?.gravityScale === -0.5, `and both gravity scales (${JSON.stringify(reloaded)})`);

	await h.finish(browser);
});
