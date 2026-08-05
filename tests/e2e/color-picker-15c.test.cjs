// Roadmap #15 batch C — the color picker went dead in the deps migration:
// svelte-awesome-color-picker 3.x -> 4.1.3 is a runes rewrite with NO component
// events, so every `on:input` handler silently never fired (bind:hex still
// tracked, which is why the swatch moved while nothing applied). The fix is the
// `onInput` PROP + `c.hex`. C2 enables the picker's hex/rgb/hsv text inputs.
//
// Test hook: the picker's OWN hex field (rendered by C2) calls the very same
// `onInput` prop the drag surface does — far more stable than canvas-drag math,
// and it fails loudly against the pre-fix `on:input` wiring. The app's separate
// hex box below the picker is a different control (it always worked).
const h = require('./helpers.cjs');

/** type a hex into the Nth picker's own text field (fires the lib's onInput) */
const typeIntoPicker = (page, index, hex) =>
	page.evaluate(
		([i, value]) => {
			const wrapper = document.querySelectorAll('.wrapper')[i];
			const input = wrapper?.querySelector('input');
			if (!input) return false;
			input.value = value;
			// delegated attribute-form handlers need a BUBBLING event
			input.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		},
		[index, hex]
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a white box, selected with the Properties inspector open
	await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		window.__box = box;
		box.material.color.set('#ffffff');
		w.objectActions.selectObject(box.uuid, true);
	});
	await A.page.waitForTimeout(700);

	// ---- C2: the hex/rgb/hsv text inputs render (were disabled everywhere) ----
	const ui = await A.page.evaluate(() => {
		const wrapper = document.querySelector('.wrapper');
		if (!wrapper) return null;
		return {
			inputs: wrapper.querySelectorAll('input').length,
			modeToggle: (wrapper.querySelector('button')?.textContent ?? '').trim()
		};
	});
	h.check(!!ui, 'the material color picker renders');
	h.check(ui.inputs > 0, `the picker exposes a text input (${ui?.inputs})`);
	h.check(/rgb|hsv|hex/i.test(ui.modeToggle), `a mode cycle button is offered ("${ui?.modeToggle}")`);

	// ---- C1: the picker's onInput applies + replicates (was a silent no-op) ----
	await A.page.evaluate(async () => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		window.__sentColors = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			if (m && m.type === 'color') window.__sentColors.push(m.color);
			return orig(m);
		};
	});
	h.check(await typeIntoPicker(A.page, 0, '#3366ff'), 'the picker hex field is reachable');
	await A.page.waitForTimeout(200);
	const applied = await A.page.evaluate(() => ({
		hex: window.__box.material.color.getHexString(),
		sends: window.__sentColors.slice()
	}));
	h.check(applied.hex === '3366ff', `the picker applies to the material (${applied.hex})`);
	h.check(
		applied.sends.includes('#3366ff'),
		`the change replicates as {type:'color'} (${JSON.stringify(applied.sends)})`
	);

	// one DEBOUNCED undo entry per gesture, and undo restores the old color.
	// (the first change's 600ms timer must FIRE before the second starts, or
	// both collapse into one gesture — which is the intended live-drag behavior)
	await A.page.waitForTimeout(900);
	const depthBefore = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	await typeIntoPicker(A.page, 0, '#22cc55');
	await A.page.waitForTimeout(900); // past the 600ms gesture debounce
	const afterGesture = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	h.check(
		afterGesture === depthBefore + 1,
		`a color gesture records exactly one undo entry (${depthBefore} -> ${afterGesture})`
	);
	const undone = await A.page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 200));
		return window.__box.material.color.getHexString();
	});
	h.check(undone === '3366ff', `undo steps back one color change (${undone})`);

	// ---- C1: the SCENE pickers (Configure scene ▸ background / fog) ----
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(600);
	const wrappers = await A.page.evaluate(() => document.querySelectorAll('.wrapper').length);
	h.check(wrappers >= 2, `the scene inspector renders background + fog pickers (${wrappers})`);

	h.check(await typeIntoPicker(A.page, 0, '#123456'), 'the background picker hex field is reachable');
	await A.page.waitForTimeout(250);
	const bg = await A.page.evaluate(async () => {
		const store = await new Promise((r) => window.__stores.backgroundColor.subscribe((v) => r(v))());
		const scene = await new Promise((r) => window.__stores.globalScene.subscribe((s) => r(s))());
		return { store, applied: '#' + (scene.background?.getHexString?.() ?? '') };
	});
	h.check(String(bg.store).toLowerCase() === '#123456', `the background store follows (${bg.store})`);
	h.check(bg.applied.toLowerCase() === '#123456', `the three.js scene background applies (${bg.applied})`);

	await h.finish(browser);
});
