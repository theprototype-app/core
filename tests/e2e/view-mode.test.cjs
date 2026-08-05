// V-2: viewport view modes (Shaded / Shaded+AO / Wireframe) — a LOCAL per-viewer
// pref. Wireframe uses scene.overrideMaterial (local-only, never touches
// replicated materials) and hides the shadow catcher. AO is a desktop-visual
// pass (on by default via 'shaded-ao'); its look is the user's screenshot check.
const h = require('./helpers.cjs');

const overrideState = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const om = scene?.overrideMaterial;
					const catcher = scene?.getObjectByName('env-shadow-catcher');
					resolve({ hasOverride: !!om, wireframe: om?.wireframe === true, catcherVisible: catcher ? catcher.visible : null });
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// default is Shaded + AO
	const def = await A.page.evaluate(() => new Promise((r) => window.__stores.viewMode.subscribe((m) => r(m))()));
	h.check(def === 'shaded-ao', `default view mode is Shaded + AO (${def})`);

	// shaded: no override material
	await A.page.evaluate(() => window.__stores.viewMode.set('shaded'));
	await A.page.waitForTimeout(200);
	let s = await overrideState(A.page);
	h.check(s.hasOverride === false, 'Shaded mode uses no override material');

	// wireframe: scene override is a wireframe material, catcher hidden
	await A.page.evaluate(() => window.__stores.viewMode.set('wireframe'));
	await A.page.waitForTimeout(250);
	s = await overrideState(A.page);
	h.check(s.hasOverride === true && s.wireframe === true, 'Wireframe sets a wireframe scene override (local-only)');
	h.check(s.catcherVisible === false, 'shadow catcher hides in wireframe mode');

	// back to shaded-ao: override cleared, catcher back
	await A.page.evaluate(() => window.__stores.viewMode.set('shaded-ao'));
	await A.page.waitForTimeout(600);
	s = await overrideState(A.page);
	h.check(s.hasOverride === false, 'leaving wireframe clears the override');
	h.check(s.catcherVisible === true, 'shadow catcher returns when not in wireframe');

	// the choice is a persisted LOCAL pref (never on the wire)
	const persisted = await A.page.evaluate(() => localStorage.getItem('viewMode'));
	h.check(persisted === 'shaded-ao', `view mode persists locally (${persisted})`);

	// --- the AO capability gate reads the BRAND LIST, not the UA string --------
	// A desktop Chrome 151 with DevTools device emulation left on reported "126" and
	// lost AO: emulation rewrites navigator.userAgent (its presets carry a canned,
	// much older Chrome) but the real engine version is in userAgentData.brands.
	const gate = await A.page.evaluate(() => {
		const vm = window.__stores.viewModeCtl;
		const brands = navigator.userAgentData?.brands ?? [];
		const brandVersion = Number(
			brands.find((b) => /Google Chrome|Chromium/i.test(b.brand))?.version ?? 0
		);
		return { major: vm.chromiumMajor(), supported: vm.aoSupported(), brandVersion };
	});
	h.check(
		gate.brandVersion > 0 && gate.major === gate.brandVersion,
		`the AO gate takes the engine version from userAgentData.brands (${gate.major} vs brand ${gate.brandVersion})`
	);
	h.check(
		gate.supported === gate.major >= 151,
		`aoSupported follows that version (${gate.major} -> ${gate.supported})`
	);
	// a stale/spoofed UA string must NOT be able to drag the gate backwards
	const spoofed = await A.page.evaluate(() => {
		const original = navigator.userAgent;
		Object.defineProperty(navigator, 'userAgent', {
			value: original.replace(/Chrom(e|ium)\/\d+/, 'Chrome/126'),
			configurable: true
		});
		const out = window.__stores.viewModeCtl.chromiumMajor();
		Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true });
		return out;
	});
	h.check(
		spoofed === gate.brandVersion,
		`an overridden UA string cannot fake the engine version (${spoofed})`
	);

	await h.finish(browser);
});
