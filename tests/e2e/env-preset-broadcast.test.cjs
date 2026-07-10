// Phase 86: environment preset libraries broadcast — peers can apply your
// presets by name; libraries arrive in the handshake and update on save.
const h = require('./helpers.cjs');

const libsOn = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.environment.peerEnvPresets.subscribe(r)())
	);
const envOf = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.environment.environment.subscribe(r)())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// A saves a preset BEFORE connecting — the handshake should carry it
	await A.page.evaluate(async () => {
		window.__stores.environment.setEnvironment('sunset');
		await window.__stores.environment.saveEnvPreset('HandshakeGlow');
	});

	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await h.eventually(
		() => libsOn(B.page),
		(map) => Object.values(map).some((list) => list.some((p) => p.name === 'HandshakeGlow')),
		'handshake delivered A preset library to B'
	);

	// live update: A saves another preset while connected
	await A.page.evaluate(async () => {
		window.__stores.environment.setEnvironment('night');
		await window.__stores.environment.saveEnvPreset('LiveNight');
	});
	await h.eventually(
		() => libsOn(B.page),
		(map) => Object.values(map).some((list) => list.some((p) => p.name === 'LiveNight')),
		'saving broadcasts the updated library'
	);

	// B applies A's preset by name — replicates the full payload everywhere
	await B.page.evaluate(async () => {
		const map = await new Promise((r) => window.__stores.environment.peerEnvPresets.subscribe(r)());
		const list = Object.values(map)[0];
		const preset = list.find((p) => p.name === 'HandshakeGlow');
		window.__stores.environment.applyCustomPreset(preset.payload);
	});
	await h.eventually(
		() => Promise.all([envOf(A.page), envOf(B.page)]),
		([a, b]) =>
			a.preset === 'custom' &&
			b.preset === 'custom' &&
			a.customPreset?.label === 'HandshakeGlow' &&
			b.customPreset?.label === 'HandshakeGlow',
		'peer preset applies for everyone'
	);

	// deleting broadcasts the shrunken library
	await A.page.evaluate(() => window.__stores.environment.deleteEnvPreset('LiveNight'));
	await h.eventually(
		() => libsOn(B.page),
		(map) => Object.values(map).every((list) => !list.some((p) => p.name === 'LiveNight')),
		'delete broadcasts too'
	);

	await h.finish(browser);
});
