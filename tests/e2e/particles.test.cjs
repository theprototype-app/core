// PFX-A: particle emitters — preset attach via userData.particles, the
// analytic runtime builds one THREE.Points per emitter at the scene root
// (never inside sceneObjects), edits replicate via objectParameters, bursts
// ride the replicated `particleburst` timestamp, undo/redo works through the
// props kind, and the emitter cap holds. Visual look is the user's manual check.
const h = require('./helpers.cjs');

const entriesOn = (page) =>
	page.evaluate(() => window.__stores.particleRuntime.particleEntries());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// surface shader/program errors — a GLSL typo only shows at first render
	const glErrors = [];
	A.page.on('console', (msg) => {
		if (/WebGLProgram|THREE\.WebGLShader/i.test(msg.text())) glErrors.push(msg.text());
	});

	// 1) attach a preset to a box (read the group ref FIRST, mutate after —
	// never write a store from inside its own subscriber)
	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		window.__box = group.children[group.children.length - 1];
		return window.__box.uuid;
	});
	await A.page.evaluate((u) => window.__stores.particleActions.addParticlesPreset(u, 'sparkles'), uuid);
	const cfg = await A.page.evaluate(() => window.__box.userData.particles);
	h.check(cfg?.preset === 'sparkles' && cfg.count > 0, `preset config lands on userData.particles (${cfg?.preset})`);

	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.length === 1 && e[0].key === 'ud:' + uuid && e[0].inRoot === true,
		'runtime builds one Points entry under particle-root'
	);

	// 2) the Points never enter the replicated sceneObjects tree
	const leaked = await A.page.evaluate(() => {
		let found = false;
		window.__box.parent.traverse((o) => {
			if (o.isPoints) found = true;
		});
		return found;
	});
	h.check(leaked === false, 'no THREE.Points inside sceneObjects (GLTF-sync safe)');

	// 3) the analytic clock ticks (uTime advances between samples)
	const t1 = (await entriesOn(A.page))[0].uTime;
	await A.page.waitForTimeout(400);
	const t2 = (await entriesOn(A.page))[0].uTime;
	h.check(t2 > t1, `runtime clock advances (${t1.toFixed(2)} -> ${t2.toFixed(2)})`);

	// 4) edits + bursts broadcast (spy on the instance's send — no second peer
	// needed, and no store replacement)
	const sent = await A.page.evaluate(() => {
		const captured = [];
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		peer.send = (m) => captured.push(m); // instance prop shadows the prototype method
		window.__stores.particleActions.updateObjectParticles(window.__box.uuid, { mode: 'burst', speed: 3 });
		window.__stores.particleActions.burstObjectParticles(window.__box.uuid);
		delete peer.send; // restore the prototype method
		return captured.map((m) => m.type + ':' + (m.parameter ?? ''));
	});
	h.check(
		sent.includes('objectParameters:particles') && sent.includes('particleburst:'),
		`emitter edits + bursts replicate (${sent.join(', ')})`
	);
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e[0]?.burstT >= 0,
		'burst timestamp reaches the shader uniform'
	);

	// 5) receive path: a remote peer's objectParameters lands on userData
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
	});
	const remoteOk = await A.page.evaluate(async () => {
		const g = window.__box.parent;
		const sphere = g.children[g.children.length - 1];
		window.__sphere = sphere;
		await window.__stores.commandsHandler.objectParameters({
			parameter: 'particles',
			uuid: sphere.uuid,
			particles: { preset: 'fire', count: 40, lifetime: 1 }
		});
		return sphere.userData.particles?.preset;
	});
	h.check(remoteOk === 'fire', 'remote objectParameters(particles) applies without re-broadcast');
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.length === 2,
		'second emitter builds from the remote config'
	);

	// 6) remote null removes it
	await A.page.evaluate(() =>
		window.__stores.commandsHandler.objectParameters({
			parameter: 'particles',
			uuid: window.__sphere.uuid,
			particles: null
		})
	);
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.length === 1,
		'remote null clears the emitter'
	);

	// 7) undo removes the attach, redo restores it (props kind)
	// history so far: [create box, attach (props), patch (props), create sphere]
	await A.page.evaluate(() => {
		window.__stores.history.undo(); // create sphere
		window.__stores.history.undo(); // the mode/speed patch
		window.__stores.history.undo(); // the attach
	});
	await h.eventually(
		() => A.page.evaluate(() => !window.__box.userData.particles),
		(v) => v === true,
		'undo clears userData.particles'
	);
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.length === 0,
		'undo disposes the Points entry'
	);
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.length === 1,
		'redo restores the emitter'
	);

	// 8) the object-menu + Add-menu surfaces exist
	const menu = await A.page.evaluate(() => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(window.__box.uuid);
		const effects = items.find((i) => i.label === 'Effects');
		return { hasEffects: !!effects, children: effects?.children?.map((c) => c.label) ?? [] };
	});
	h.check(
		menu.hasEffects && menu.children.length >= 6 && menu.children.some((l) => /Remove particles/.test(l)),
		`object menu Effects submenu (${menu.children.length} items)`
	);

	// 8b) a burst preset auto-fires on attach (immediate local feedback — burst
	// emitters would otherwise sit invisible until an explicit trigger). Runs
	// before the cap test so its entry isn't culled by the emitter cap.
	const burstUuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	await A.page.evaluate((u) => window.__stores.particleActions.addParticlesPreset(u, 'confetti'), burstUuid);
	await h.eventually(
		() => entriesOn(A.page),
		(e) => {
			const c = e.find((x) => x.key === 'ud:' + burstUuid);
			return !!c && c.sprite === 'square' && c.burstT >= 0;
		},
		'burst preset auto-fires on attach (no explicit trigger)'
	);

	// 9) emitter cap: 10 emitters -> at most MAX_EMITTERS render
	await A.page.evaluate(() => {
		for (let i = 0; i < 9; i++) {
			window.__stores.commandsHandler.sceneCommand('/create box');
		}
		const g = window.__box.parent;
		g.children.slice(-9).forEach((o) => window.__stores.particleActions.addParticlesPreset(o.uuid, 'fire'));
	});
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.length === 8,
		'emitter cap holds at MAX_EMITTERS (8)'
	);

	h.check(glErrors.length === 0, `no WebGL shader errors (${glErrors.length ? glErrors[0] : 'clean'})`);

	await h.finish(browser);
});
