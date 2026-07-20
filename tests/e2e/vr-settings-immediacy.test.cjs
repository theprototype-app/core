// R-2: VR settings immediacy — the snap-turn angle cycle is unified across the
// radial, the VR settings panel, and desktop Settings ([0,15,30,45], 0 = Off),
// the radial label reflects the current value live, and toggles write the store
// that vrControls reads live each frame. Headless (state + entry label); the
// in-headset feel is the user's check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// the radial snapangle entry has a LIVE label reflecting the store
	const label0 = await A.page.evaluate(() => {
		window.__stores.vrSnapAngle.set(0);
		const e = window.__stores.vrRadialMenu.findMenuEntry('snapangle');
		return typeof e.label === 'function' ? e.label() : e.label;
	});
	h.check(/off/i.test(label0), `radial snap label shows Off at 0 (${label0})`);
	const label45 = await A.page.evaluate(() => {
		window.__stores.vrSnapAngle.set(45);
		const e = window.__stores.vrRadialMenu.findMenuEntry('snapangle');
		return typeof e.label === 'function' ? e.label() : e.label;
	});
	h.check(/45/.test(label45), `radial snap label updates to 45 live (${label45})`);

	// cycling from the radial reaches Off (0) — the unified [0,15,30,45] cycle
	const seq = await A.page.evaluate(async () => {
		const e = window.__stores.vrRadialMenu.findMenuEntry('snapangle');
		const read = () => new Promise((r) => window.__stores.vrSnapAngle.subscribe((v) => r(v))());
		window.__stores.vrSnapAngle.set(45);
		const out = [];
		for (let i = 0; i < 4; i++) {
			e.action();
			out.push(await read());
		}
		return out;
	});
	h.check(seq.includes(0), `radial cycle reaches Off (${seq.join(' -> ')})`);
	h.check(new Set(seq).size === 4, `radial cycles through all four steps (${seq.join(',')})`);

	// teleport toggle writes the store vrControls reads live each frame
	const before = await A.page.evaluate(() => new Promise((r) => window.__stores.vrTeleportEnabled.subscribe((v) => r(v))()));
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('settings:teleport'));
	const after = await A.page.evaluate(() => new Promise((r) => window.__stores.vrTeleportEnabled.subscribe((v) => r(v))()));
	h.check(before !== after, `settings:teleport flips the live-read store (${before} -> ${after})`);

	await h.finish(browser);
});
