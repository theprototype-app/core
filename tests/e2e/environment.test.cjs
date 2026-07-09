// Phase 48: environment rig + presets — lit by default, never duplicated on
// connect, presets replicate (latest wins), user lights dim the rig.
const h = require('./helpers.cjs');

const rigInfo = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					window.__stores.globalRenderer.subscribe((renderer) => {
						let hemis = 0;
						let suns = 0;
						scene?.traverse((o) => {
							if (o.name === 'env-rig-hemi') hemis++;
							if (o.name === 'env-rig-sun') suns++;
						});
						const sun = scene?.getObjectByName('env-rig-sun');
						resolve({
							hemis,
							suns,
							sunIntensity: sun?.intensity ?? null,
							toneMapping: renderer?.toneMapping ?? null,
							background: scene?.background?.getHexString?.() ?? null
						});
					})();
				})();
			})
	);

const presetOf = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.environment.environment.subscribe((e) => r(e.preset))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	let rig = await rigInfo(A.page);
	h.check(rig.hemis === 1 && rig.suns === 1, 'default rig present (hemi + sun)');
	h.check(rig.toneMapping === 4, `ACES tone mapping active (${rig.toneMapping})`);
	const inObjects = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g?.children.some((c) => c.name?.startsWith('env-rig')) ?? false)
				)()
			)
	);
	h.check(inObjects === false, 'rig lives at the scene root, not in the synced objects');

	// studio preset means no "no light" nag
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(400);
	const fixLight = await A.page.evaluate(
		() => new Promise((r) => window.__stores.fixLight.subscribe(r)())
	);
	h.check(fixLight === false, 'no missing-light toast under the rig');

	// connect B: still exactly one rig there
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	rig = await rigInfo(B.page);
	h.check(rig.hemis === 1 && rig.suns === 1, 'connecting does not duplicate the rig');

	// preset change replicates
	await A.page.evaluate(() => window.__stores.environment.setEnvironment('night'));
	await h.eventually(() => presetOf(B.page), (p) => p === 'night', 'preset replicated to B');
	const bRig = await rigInfo(B.page);
	h.check(bRig.background === '0b0e1a', `background followed the preset (${bRig.background})`);

	// late joiner adopts the current preset via the handshake
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(() => presetOf(C.page), (p) => p === 'night', 'late joiner adopts the preset');

	// a user light dims the rig
	const before = (await rigInfo(A.page)).sunIntensity;
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/light point'));
	await h.eventually(
		() => rigInfo(A.page),
		(r) => r.sunIntensity !== null && r.sunIntensity < before,
		`user light dims the rig (was ${before})`
	);

	await h.finish(browser);
});
