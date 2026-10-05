// 36-fb F23: Add ▸ Water ▸ Fluid — particle fluid poured into the open scene, in the real app.
// Hard caps (particles, lifetime, area), collision with scene meshes and the per-mesh "Fluid
// interaction", pooling into a W1 water volume (sink + ripple), off-screen pause, undo, and the
// settings replicating to a second peer that simulates its own splash. Screenshots to
// FLUID_SHOTS when set (the Inspector in dark + light).
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.FLUID_SHOTS || '';
/** @param {any} page @param {string} name @param {any} [opts] */
async function shot(page, name, opts) {
	if (!SHOTS) return;
	await page.screenshot({ path: path.join(SHOTS, name), ...(opts ?? {}) });
}

/** @param {any} page */
const em = (page) => page.evaluate(() => window.__stores.sim.fluidEmitterDebug()[0] ?? null);

/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__stores.editorCam.subscribe((v) => (cam = v))();
			window.__stores.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			if (orbit?.target) {
				orbit.target.set(t[0], t[1], t[2]);
				orbit.update?.();
			}
			cam.lookAt(t[0], t[1], t[2]);
			cam.updateMatrixWorld(true);
		},
		[pos, target]
	);
}

/** @param {any} page @param {any} patch */
const setEm = (page, patch) => page.evaluate((p) => window.__stores.sim.setFluidEmitterFor(window.__em.uuid, p), patch);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);

	// ---------- Add ▸ Water ▸ Fluid (the real menu builder) ----------
	const made = await A.page.evaluate(() => {
		const water = window.__stores.addObjects.buildAddChildren(() => [2, 0, 0]).find((g) => g.label === 'Water');
		const item = water?.children?.find((c) => c.label === 'Fluid');
		if (!item) return { labels: water?.children?.map((c) => c.label) };
		item.action();
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children.find((c) => c.userData?.fluidEmitter);
		window.__em = o;
		return { labels: water.children.map((c) => c.label), uuid: o?.uuid, y: o?.position.y, name: o?.name, physics: !!o?.userData.physics, shadow: o?.castShadow };
	});
	h.check(made.labels?.includes('Fluid'), `Add ▸ Water lists Fluid (${JSON.stringify(made.labels)})`);
	h.check(!!made.uuid && made.name === 'Fluid emitter', `the item creates a Fluid emitter (${made.name})`);
	h.check(Math.abs(made.y - 1.6) < 1e-6, `it hangs 1.6 m above the clicked point, pouring down (y ${made.y})`);
	h.check(!made.physics && made.shadow === false, 'the spout is scenery: no physics body, no shadow');
	await look(A.page, [2, 2.2, 4.2], [2, 0.4, 0]);

	await h.eventually(() => em(A.page), (e) => !!e && e.count > 150 && e.steps > 30, 'the emitter pours and steps', 20000);
	const e1 = await em(A.page);
	h.check(e1.worker === 'worker', `the solver runs in a Web Worker (${e1.worker})`);
	h.check(e1.mode === 'ssf', `desktop draws the screen-space surface (${e1.mode})`);
	// the water falls and lands: most particles are low (the area floor) after a few seconds
	await A.page.waitForTimeout(2500);
	const fallen = await A.page.evaluate(() => {
		const p = window.__stores.sim.fluidEmitterParticles(window.__em.uuid);
		return { n: p.length, low: p.filter((q) => q[1] < 0.6).length };
	});
	h.check(fallen.n > 200 && fallen.low / fallen.n > 0.5, `the poured water lands on the area floor (${fallen.low}/${fallen.n} below 0.6 m)`);
	// it really draws: the frame with the visual differs from one without
	const setVis = (on) =>
		A.page.evaluate((v) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			g.parent.children.filter((c) => c.userData?.__fluidVisual).forEach((c) => (c.visible = v));
		}, on);
	const withFluid = await h.grabFrame(A);
	await setVis(false);
	await A.page.waitForTimeout(300);
	const without = await h.grabFrame(A);
	await setVis(true);
	const drawn = await h.frameDelta(A.page, without, withFluid, 30);
	h.check(drawn.changed > 4000, `the fluid is drawn on screen (${drawn.changed} px differ)`);
	await A.page.waitForTimeout(600);
	await shot(A.page, '02-fluid-emitter-pour.png');

	// ---------- HARD CAPS ----------
	// max particles: lowered below the live count, the count drops under it and stays there
	await setEm(A.page, { maxParticles: 150, rate: 1500 });
	await A.page.waitForTimeout(500);
	await setEm(A.page, { generation: 1 }); // restart: the cap is the solver's capacity
	await h.eventually(() => em(A.page), (e) => e.cap === 150 && e.count >= 120, 'a restarted emitter refills to its new cap', 10000);
	let peak = 0;
	for (let i = 0; i < 12; i++) {
		peak = Math.max(peak, (await em(A.page)).count);
		await A.page.waitForTimeout(150);
	}
	h.check(peak <= 150, `max particles is a hard cap: a 1500/s stream never holds more than 150 (peak ${peak})`);
	// lifetime: 0.5 s at 200/s holds ~100 (not the 1500 cap)
	await setEm(A.page, { maxParticles: 1500, rate: 200, lifetime: 0.5, generation: 2 });
	await A.page.waitForTimeout(2500);
	let lifePeak = 0;
	for (let i = 0; i < 10; i++) {
		lifePeak = Math.max(lifePeak, (await em(A.page)).count);
		await A.page.waitForTimeout(120);
	}
	h.check(lifePeak > 40 && lifePeak <= 140, `lifetime is a hard cap: 200/s × 0.5 s ≈ 100 alive (peak ${lifePeak})`);
	// area: floor off — nothing piles up; everything stays inside the box while it lives
	await setEm(A.page, { lifetime: 600, floor: false, generation: 3 });
	await A.page.waitForTimeout(3000);
	const open = await A.page.evaluate(() => {
		const p = window.__stores.sim.fluidEmitterParticles(window.__em.uuid);
		const s = window.__em.userData.fluidEmitter;
		const bottom = window.__em.position.y + s.area.offset[1] - s.area.size[1] / 2;
		return { n: p.length, below: p.filter((q) => q[1] < bottom - 0.25).length, bottom };
	});
	h.check(open.n < 500 && open.below === 0, `area is a hard cap: with the floor off the water falls out and is gone (${open.n} alive, ${open.below} below the box)`);
	await setEm(A.page, { floor: true, lifetime: 30, rate: 300, maxParticles: 1800, generation: 4 });

	// ---------- collision: a box under the stream; Fluid interaction None lets it through ----------
	const box = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Box 0.8 0.4 0.8');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const b = g.children[g.children.length - 1];
		delete b.userData.physics; // scenery
		b.position.set(2, 0.5, 0);
		b.updateMatrixWorld(true);
		window.__box = b;
		return b.uuid;
	});
	const onTop = () =>
		A.page.evaluate(() => {
			const p = window.__stores.sim.fluidEmitterParticles(window.__em.uuid);
			return p.filter((q) => Math.abs(q[0] - 2) < 0.4 && Math.abs(q[2]) < 0.4 && q[1] > 0.7 && q[1] < 0.95).length;
		});
	await setEm(A.page, { generation: 5 });
	await A.page.waitForTimeout(3500);
	const resting = await onTop();
	h.check(resting > 25, `the stream lands ON the box: water rests on its top face (${resting} particles)`);
	await shot(A.page, '03-fluid-emitter-on-box.png');
	await A.page.evaluate((uuid) => window.__stores.sim.setFluidInteractionFor([uuid], 'none'), box);
	await setEm(A.page, { generation: 6 });
	await A.page.waitForTimeout(3500);
	const through = await onTop();
	h.check(through < resting / 3, `Fluid interaction "None": the water passes through the box (${through} on top, was ${resting})`);
	const inter = await A.page.evaluate(() => window.__box.userData.fluidInteraction);
	h.check(inter === 'none', 'the interaction is stored on the mesh (userData.fluidInteraction)');
	const peerInter = (uuid) =>
		B.page.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', u)?.userData.fluidInteraction ?? null;
		}, uuid);
	await h.eventually(() => peerInter(box), (v) => v === 'none', 'the interaction replicates to peer B', 8000);
	// undo: change it once more, one Ctrl+Z puts it back (and the peer follows)
	await A.page.evaluate((uuid) => window.__stores.sim.setFluidInteractionFor([uuid], 'float'), box);
	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await A.page.evaluate(() => window.__box.userData.fluidInteraction ?? null);
	h.check(undone === 'none', `one undo puts the interaction back (props undo kind) (${undone})`);
	await h.eventually(() => peerInter(box), (v) => v === 'none', 'the undo replicates to peer B', 8000);
	await A.page.evaluate((uuid) => window.__stores.sim.setFluidInteractionFor([uuid], 'auto'), box);
	const cleared = await A.page.evaluate(() => 'fluidInteraction' in window.__box.userData);
	h.check(!cleared, 'Auto writes no key (a scene that never touched it stays byte-identical)');

	// ---------- pouring into a pool: the water joins it (sink) and ripples it ----------
	await A.page.evaluate(() => {
		window.__box.position.set(9, 0.5, 9); // out of the way
		window.__box.updateMatrixWorld(true);
		window.__stores.waterActions.makeWater(window.__stores.addObjects.spawnAtPoint('/create Box 1.6 0.6 1.6', [2, 0.3, 0]), 'tank');
	});
	await setEm(A.page, { generation: 7, rate: 400 });
	await h.eventually(() => em(A.page), (e) => e.sunk > 100, 'water poured into a pool joins it (sunk)', 12000);
	const pooled = await em(A.page);
	h.check(pooled.count < 900, `the pool swallows the stream instead of letting it pile up (alive ${pooled.count}, joined ${pooled.sunk})`);
	await A.page.waitForTimeout(500);
	await shot(A.page, '04-fluid-emitter-into-pool.png');

	// ---------- off-screen pause ----------
	await look(A.page, [2, 2.2, 4.2], [2, 2.2, 60]);
	await A.page.waitForTimeout(600);
	const s0 = (await em(A.page)).steps;
	await A.page.waitForTimeout(1500);
	const off = await em(A.page);
	h.check(!off.visible && off.steps - s0 <= 1, `off-screen the emitter pauses (steps +${off.steps - s0})`);
	await look(A.page, [2, 2.2, 4.2], [2, 0.4, 0]);
	await h.eventually(() => em(A.page), (e) => e.visible && e.steps > off.steps + 10, 'back on screen it resumes', 8000);

	// ---------- peer B: the same settings, its own simulation ----------
	const peerSpec = () =>
		B.page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', uuid)?.userData.fluidEmitter ?? null;
		}, made.uuid);
	await h.eventually(peerSpec, (s) => !!s && s.generation === 7 && s.rate === 400 && s.maxParticles === 1800, 'the emitter settings (caps included) replicate to peer B', 10000);
	await look(B.page, [2, 2.2, 4.2], [2, 0.4, 0]);
	await h.eventually(() => em(B.page), (e) => !!e && e.steps > 20 && e.count + e.sunk > 50, 'peer B simulates its own fluid from the shared settings', 15000);

	// ---------- undo of a setting; the Inspector in dark + light ----------
	await setEm(A.page, { color: '#d0402a' });
	await A.page.evaluate(() => window.__stores.history.undo());
	const col = await A.page.evaluate(() => window.__em.userData.fluidEmitter.color);
	h.check(col === '#3a92d8', `one undo restores the colour (${col})`);
	await A.page.evaluate(() => window.__stores.objectActions.applySelectionSet([window.__em.uuid], true));
	await A.page.waitForTimeout(500);
	const maxRow = A.page.locator('#fluid-emitter-max').first();
	await maxRow.scrollIntoViewIfNeeded().catch(() => {});
	const sectionShown = await maxRow.isVisible().catch(() => false);
	h.check(sectionShown, 'the Inspector shows the Fluid emitter section for the selected emitter');
	if (sectionShown) {
		for (const theme of ['dark', 'light']) {
			await A.page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
			await A.page.waitForTimeout(400);
			await shot(A.page, `05-inspector-fluid-emitter-${theme}.png`);
		}
		await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));
	}
	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A).slice(0, 2))})`);
	await h.finish(browser);
});
