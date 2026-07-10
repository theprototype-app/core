// Phase 70: environment v2 — adopt a scene light into the environment (leaves
// object sync on both peers), convert back, custom presets replicate as full
// payloads, and a late joiner receives the custom state.
const h = require('./helpers.cjs');

const envOf = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.environment.environment.subscribe(r)())
	);
const lightCount = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					let n = 0;
					g?.traverse((o) => {
						if (o.isLight) n++;
					});
					r(n);
				})()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// A creates a normal scene light and adopts it into the environment
	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/light directional');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return g.children.find((c) => c.type === 'DirectionalLight')?.uuid;
	});
	await h.eventually(
		() => lightCount(B.page),
		(n) => n === 1,
		'scene light replicated to B'
	);
	await A.page.evaluate((uuid) => window.__stores.environment.convertToEnvironment(uuid), uuid);
	await h.eventually(
		() => Promise.all([lightCount(A.page), lightCount(B.page)]),
		([a, b]) => a === 0 && b === 0,
		'adopted light left the object tree on both peers'
	);
	let [envA, envB] = await Promise.all([envOf(A.page), envOf(B.page)]);
	h.check(envA.lights.length === 1 && envB.lights.length === 1, 'env light present in both states');
	h.check(envB.lights[0].kind === 'directional', 'kind carried over');

	// the environment group on B actually contains the extra light
	const bHasExtra = await B.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalScene.subscribe((scene) => {
					const root = scene?.getObjectByName('environment-root');
					r(!!root?.children.some((c) => c.name.startsWith('env-extra-')));
				})()
			)
	);
	h.check(bHasExtra, 'B rebuilt the env light under environment-root');

	// rig edit detaches into a live custom payload and replicates
	await A.page.evaluate(() => window.__stores.environment.editRigComponent('sun', { intensity: 3.3 }));
	await h.eventually(
		() => envOf(B.page),
		(env) => env.preset === 'custom' && Math.abs(env.customPreset?.sun?.intensity - 3.3) < 0.01,
		'custom rig edit replicated to B'
	);

	// save + apply a named preset; payload replicates (B needs no file)
	await A.page.evaluate(async () => {
		await window.__stores.environment.saveEnvPreset('TestEnv');
		const list = await new Promise((r) => window.__stores.environment.envPresets.subscribe(r)());
		window.__stores.environment.applyCustomPreset(list.find((p) => p.name === 'TestEnv').payload);
	});
	await h.eventually(
		() => envOf(B.page),
		(env) => env.preset === 'custom' && env.customPreset?.label === 'TestEnv',
		'named preset payload replicated to B'
	);

	// export round-trip: JSON re-imports as a valid payload
	const exported = await A.page.evaluate(() =>
		window.__stores.environment.exportEnvPreset(window.__stores.environment.snapshotPreset('RoundTrip'))
	);
	h.check(JSON.parse(exported).label === 'RoundTrip' && JSON.parse(exported).background, 'export produces a payload JSON');

	// convert the env light back into a scene object — appears on both peers
	const envId = envA.lights[0].id;
	await A.page.evaluate((id) => window.__stores.environment.convertFromEnvironment(id), envId);
	await h.eventually(
		() => Promise.all([lightCount(A.page), lightCount(B.page)]),
		([a, b]) => a === 1 && b === 1,
		'converted-back light replicates as a normal object'
	);

	// late joiner receives the custom environment through the handshake
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(
		() => envOf(C.page),
		(env) => env.preset === 'custom' && env.customPreset?.label === 'TestEnv',
		'late joiner got the custom environment',
		15000
	);

	await h.finish(browser);
});
