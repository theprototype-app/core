// 36-fb-water S8: every NEW setting of this lane replicates to a peer and undoes / redoes as
// ONE step on both: the water's Flow up + Bob damping (F12), a pour emitter (add, edit, remove;
// F17), a fluid tank's spill limits (F16), a standalone bubble emitter (F18) and the scene's
// "Start simulation on load" (F14). Each case: A writes through the app's own write path, B
// must show the value; Ctrl+Z on A, B shows the old one; Ctrl+Y, the new one again.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1100, height: 700 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 900, height: 600 } } });
	// the objects exist before B joins (a late joiner gets them through the handshake)
	const ids = await A.page.evaluate(() => {
		const st = window.__stores;
		const cmd = st.commandsHandler.sceneCommand;
		let g;
		st.objectsGroup.subscribe((v) => (g = v))();
		const last = () => g.children[g.children.length - 1];
		cmd('/create Box 2 1.2 1');
		const tank = last();
		st.waterActions.makeWater(tank, 'tank');
		cmd('/create Box 0.4 0.4 0.4');
		const box = last();
		delete box.userData.physics;
		cmd('/create FluidTank 1.2 0.8 0.8');
		const fluid = last();
		fluid.position.set(3, 0.5, 0);
		return { tank: tank.uuid, box: box.uuid, fluid: fluid.uuid };
	});
	await A.page.evaluate(() => window.__stores.simOnLoad); // prime the undoable setting's module
	await h.connect(B, A);
	/** read a path of an object's userData (or the scene physics) on a peer */
	const read = (peer, uuid, key) =>
		peer.page.evaluate(
			([u, k]) => {
				if (u === 'scene') {
					let s;
					window.__stores.scenePhysics.scenePhysicsState_.subscribe((v) => (s = v))();
					return JSON.stringify(s[k] ?? null);
				}
				let o;
				window.__stores.objectsGroup.subscribe((g) => (o = g?.getObjectByProperty('uuid', u)))();
				const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o?.userData);
				return JSON.stringify(v ?? null);
			},
			[uuid, key]
		);
	await h.eventually(() => read(B, ids.tank, 'water.preset'), (v) => v === '"aquarium"', 'B holds the Water tank', 30000);
	/** one setting: write on A (fn), expect `want` on B, undo -> `old` on B, redo -> `want` */
	async function prove(label, uuid, key, fn, want) {
		const old = await read(A, uuid, key);
		await A.page.evaluate(fn, ids);
		const wantJ = JSON.stringify(want);
		h.check((await read(A, uuid, key)) === wantJ, `${label}: A shows it`);
		await h.eventually(() => read(B, uuid, key), (v) => v === wantJ, `${label}: replicates to B`, 15000);
		await A.page.evaluate(() => window.__stores.history.undo());
		h.check((await read(A, uuid, key)) === old, `${label}: ONE undo reverts it on A (${old})`);
		await h.eventually(() => read(B, uuid, key), (v) => v === old, `${label}: ...and on B`, 15000);
		await A.page.evaluate(() => window.__stores.history.redo());
		h.check((await read(A, uuid, key)) === wantJ, `${label}: redo puts it back on A`);
		await h.eventually(() => read(B, uuid, key), (v) => v === wantJ, `${label}: ...and on B`, 15000);
	}
	await prove('Water ▸ Bob damping', ids.tank, 'water.heaveDrag', (i) => window.__stores.waterActions.updateObjectWater(i.tank, { heaveDrag: 1.5 }, { immediate: true }), 1.5);
	await prove('Water ▸ Flow up', ids.tank, 'water.flow', (i) => window.__stores.waterActions.updateObjectWater(i.tank, { flow: [0, 0.8, 0] }, { immediate: true }), [0, 0.8, 0]);
	await prove('Water ▸ Opacity (the remapped look)', ids.tank, 'water.look.opacity', (i) => window.__stores.waterActions.updateObjectWater(i.tank, { look: { opacity: 0.97 } }, { immediate: true }), 0.97);
	await prove('Pour emitter on a Water tank', ids.tank, 'pour.enabled', (i) => window.__stores.waterActions.setObjectPour(i.tank, {}), true);
	await prove('Pour ▸ Rate', ids.tank, 'pour.rate', (i) => window.__stores.waterActions.updateObjectPour(i.tank, { rate: 140 }, { immediate: true }), 140);
	await prove('Pour ▸ Max drops', ids.tank, 'pour.maxParticles', (i) => window.__stores.waterActions.updateObjectPour(i.tank, { maxParticles: 120 }, { immediate: true }), 120);
	await prove('Bubble emitter on a box', ids.box, 'bubbles.enabled', (i) => window.__stores.waterActions.setObjectBubbles(i.box, { spread: 0.3 }), true);
	await prove('Fluid tank ▸ Spill when tipped', ids.fluid, 'fluid.spill.on', (i) => window.__stores.sim.setFluidFor(i.fluid, { spill: { on: false } }), false);
	await prove('Fluid tank ▸ Max spilled drops', ids.fluid, 'fluid.spill.maxDrops', (i) => window.__stores.sim.setFluidFor(i.fluid, { spill: { maxDrops: 150 } }), 150);
	await prove('Start simulation on load', 'scene', 'simOnLoad', () => window.__stores.simOnLoad.setSimOnLoad(true), true);
	// removing a pour emitter is one undo step too
	await prove('Remove the pour emitter', ids.tank, 'pour', (i) => window.__stores.waterActions.setObjectPour(i.tank, null), null);
	await h.finish(browser);
});
