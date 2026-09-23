// 30 P0 — CONSOLE HYGIENE. Three warnings every session printed, each a real fault in
// miniature and each reported from the diagnostics log of a user's Quest:
//
//   1. `WebGLShadowMap: PCFSoftShadowMap has been deprecated. Using PCFShadowMap instead.`
//      threlte's <Canvas> defaults `shadows` to PCFSoftShadowMap; three 0.185 downgrades
//      it on the first shadow render. App.svelte asks for PCFShadowMap directly now —
//      the identical picture, and this suite also asserts the renderer's type IS PCF.
//   2. `Avoid using history.pushState(...)` — SvelteKit's router, answering the play
//      marker's raw pushState. playMode.js pushes a SvelteKit SHALLOW entry instead.
//   3. `using deprecated parameters for the initialization function` — wasm-bindgen,
//      answering rapier-compat's own init(). physics.js filters exactly that line for
//      the length of the call (the call is inside rapier, which is a frozen dependency).
//
// The console is read from BEFORE the first navigation (helpers.setupPage attaches its
// listener ahead of page.goto), because the PCF warning fires on the very first frame
// with a shadow-casting light — a listener attached after boot would never see it and
// this suite would pass over the bug.
const h = require('./helpers.cjs');

const BANNED = [
	{ id: 'pcf', re: /PCFSoftShadowMap has been deprecated/ },
	{ id: 'pushState', re: /Avoid using `history\.pushState/ },
	{ id: 'wasm-init', re: /using deprecated parameters for the initialization function/ }
];

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	/** @param {string} id */
	const seen = (id) => {
		const rule = BANNED.find((b) => b.id === id);
		return (page.__console ?? []).filter((m) => rule.re.test(m.text));
	};

	h.check(Array.isArray(page.__console), 'the console is captured from before the first navigation');

	// a lit, shadow-casting scene: a box under the default environment's sun
	await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 800));
	});
	await page.waitForTimeout(1500);

	// ---- 1. the shadow map --------------------------------------------------------
	const shadow = await page.evaluate(() => {
		const THREE = window.__stores.THREE;
		let renderer;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		return {
			enabled: !!renderer?.shadowMap?.enabled,
			type: renderer?.shadowMap?.type,
			pcf: THREE.PCFShadowMap,
			soft: THREE.PCFSoftShadowMap,
			lights: (() => {
				let n = 0;
				let scene;
				window.__stores.globalScene.subscribe((v) => (scene = v))();
				scene?.traverse((o) => {
					if (o.isLight && o.castShadow) n++;
				});
				return n;
			})()
		};
	});
	h.check(shadow.lights > 0, `premise: a shadow-casting light is in the scene (${shadow.lights})`);
	h.check(shadow.enabled, 'shadows stay enabled');
	h.check(shadow.type === shadow.pcf, `the renderer asks for PCFShadowMap (type ${shadow.type}, PCF ${shadow.pcf}, soft ${shadow.soft})`);
	h.check(seen('pcf').length === 0, `no PCFSoftShadowMap deprecation warning (${seen('pcf').length})`);

	// ---- 2 + 3. enter play (pushes the back marker, warms rapier), exit ---------------
	await page.evaluate(async () => {
		const s = window.__stores;
		await s.physics.warmup();
		s.playMode.requestPlay();
	});
	await h.eventually(
		() => page.evaluate(() => window.__stores.playMode.playBackMarker()),
		(v) => v === true,
		'entering play pushes the back marker',
		6000
	);
	const marker = await page.evaluate(() => window.__stores.playMode.playMarkerState?.() ?? false);
	h.check(marker === true, 'the marker is a SvelteKit shallow entry (sveltekit:states.tpPlay)');
	await page.evaluate(() => window.__stores.playMode.exitPlay());
	await h.eventually(
		() => page.evaluate(() => window.__stores.playMode.playBackMarker()),
		(v) => v === false,
		'leaving play spends the marker',
		6000
	);
	await h.eventually(
		() => page.evaluate(() => { let v; window.__stores.isLocked.subscribe((x) => (v = x))(); return v; }),
		(v) => v === null,
		'and play settles back to the editor',
		6000
	);
	await page.waitForTimeout(600);
	const rapierReady = await page.evaluate(async () => {
		try {
			await window.__stores.physics.warmup();
			return true;
		} catch {
			return false;
		}
	});
	h.check(rapierReady, 'premise: rapier initialised (its init is what prints the wasm warning)');
	h.check(seen('pushState').length === 0, `no SvelteKit router pushState warning (${seen('pushState').length})`);
	h.check(seen('wasm-init').length === 0, `no wasm "deprecated parameters" warning (${seen('wasm-init').length})`);

	// the filter must not eat anything ELSE: an ordinary warning still gets through
	await page.evaluate(() => console.warn('console-hygiene: an ordinary warning'));
	await page.waitForTimeout(200);
	h.check(
		(page.__console ?? []).some((m) => /console-hygiene: an ordinary warning/.test(m.text)),
		'an ordinary console.warn still reaches the console (the filter is scoped to one call)'
	);

	await h.finish(browser);
});
