// Phase 110: VR Edit ring v2 — the continuous color palette (hue/sat disc +
// lightness bar math, open/close wiring, mutual exclusion with the other
// menu-hand panels) and the two-tone wireframe selection indicator that
// replaced the BackSide shell as the default. Actual in-headset painting
// (trigger-held ray over the disc) is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure palette math ---
	const math = await A.page.evaluate(() => {
		const p = window.__stores.vrPalette;
		return {
			red: p.paletteColorAt(1, 0.5, 0.5), // angle 0, full saturation
			center: p.paletteColorAt(0.5, 0.5, 0.5), // saturation 0 = gray
			outside: p.paletteColorAt(0, 0), // disc corner, r > 1
			barLow: p.barValueAt(-1),
			barHigh: p.barValueAt(2),
			barMid: p.barValueAt(0.5),
			texture: (() => {
				const t = p.paletteTexture(64);
				return { isTexture: !!t?.isTexture, size: t?.image?.width };
			})()
		};
	});
	h.check(math.red?.hex === '#ff0000', `disc edge at angle 0 is pure red (${math.red?.hex})`);
	h.check(
		math.center?.s === 0 && math.center?.hex === '#808080',
		`disc center is desaturated gray (${math.center?.hex})`
	);
	h.check(math.outside === null, 'points outside the disc pick nothing');
	h.check(
		math.barLow === 0.02 && math.barHigh === 0.98 && math.barMid === 0.5,
		`lightness bar clamps to 0.02..0.98 (${math.barLow}/${math.barHigh}/${math.barMid})`
	);
	h.check(
		math.texture.isTexture && math.texture.size === 64,
		'paletteTexture renders a canvas texture'
	);

	// --- open/close wiring + mutual exclusion (all panels ride the menu hand) ---
	const wiring = await A.page.evaluate(() => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const s = window.__stores;
		s.vrObjectsPanelOpen.set(true);
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('obj:color');
		const afterColor = {
			palette: read(s.vrPaletteOpen),
			panel: read(s.vrObjectsPanelOpen),
			menu: read(s.vrMenuOpen)
		};
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('objects');
		const afterObjects = { palette: read(s.vrPaletteOpen), panel: read(s.vrObjectsPanelOpen) };
		s.vrControls.executeVRMenuAction('palette:close');
		const closed = read(s.vrPaletteOpen);
		s.vrObjectsPanelOpen.set(false);
		s.vrMenuOpen.set(false);
		return { afterColor, afterObjects, closed };
	});
	h.check(
		wiring.afterColor.palette === true &&
			wiring.afterColor.panel === false &&
			wiring.afterColor.menu === false,
		'Edit - Color opens the palette and closes the ring + objects panel'
	);
	h.check(
		wiring.afterObjects.palette === false && wiring.afterObjects.panel === true,
		'opening the Objects panel closes the palette'
	);
	h.check(wiring.closed === false, 'palette:close closes the panel');
	// with everything closed and unmounted, the raycast helper answers false
	await A.page.waitForTimeout(400);
	const rayClosed = await A.page.evaluate(() => window.__stores.vrControls.raycastPalette(0));
	h.check(rayClosed === false, 'raycastPalette answers false while the palette is closed');

	// --- wireframe toggle: default on, persists, flips the store ---
	const wireframePref = await A.page.evaluate(() => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const s = window.__stores;
		const initial = read(s.vrWireframeSelection);
		s.vrControls.executeVRMenuAction('wireframe');
		const flipped = read(s.vrWireframeSelection);
		const persisted = localStorage.getItem('vrWireframe');
		s.vrControls.executeVRMenuAction('wireframe');
		const restored = read(s.vrWireframeSelection);
		return { initial, flipped, persisted, restored };
	});
	h.check(wireframePref.initial === true, 'wireframe selection is the default');
	h.check(
		wireframePref.flipped === false && wireframePref.persisted === 'false' && wireframePref.restored === true,
		'Edit - Wireframe toggles and persists the preference'
	);

	// --- the indicator builds a two-tone wireframe for mesh selections ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__stores.objectActions.selectObject(box);
		window.__box = box;
		window.__stores.isVRMode.set(true);
	});
	await A.page.waitForTimeout(600);
	const wire = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const shell = scene?.getObjectByName('vr-selection-shell');
					const indicator = shell?.getObjectByName('vr-selection-shell-mesh');
					const lines = [];
					indicator?.traverse((o) => {
						if (o.isLineSegments) lines.push(o.material.color.getHexString());
					});
					resolve({
						visible: shell?.visible,
						isGroup: indicator?.isGroup === true,
						lines
					});
				})();
			})
	);
	h.check(wire.visible === true, 'indicator group activates in VR mode');
	h.check(
		wire.isGroup && wire.lines.length === 2 && wire.lines.includes('ff7a1a') && wire.lines[0] !== wire.lines[1],
		`wireframe is two-tone: bright core + dark halo (${wire.lines.join('/')})`
	);

	// toggling the preference swaps to the legacy BackSide shell live
	await A.page.evaluate(() => window.__stores.vrWireframeSelection.set(false));
	await A.page.waitForTimeout(400);
	const shell = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const indicator = scene
						?.getObjectByName('vr-selection-shell')
						?.getObjectByName('vr-selection-shell-mesh');
					resolve({
						isMesh: indicator?.isMesh === true,
						backSide: indicator?.material?.side === window.__stores.THREE.BackSide
					});
				})();
			})
	);
	h.check(shell.isMesh && shell.backSide, 'toggle swaps back to the inflated BackSide shell');
	await A.page.evaluate(() => {
		window.__stores.vrWireframeSelection.set(true);
		window.__stores.isVRMode.set(false);
	});
	await A.page.waitForTimeout(300);
	const hidden = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) =>
					resolve(scene?.getObjectByName('vr-selection-shell')?.visible)
				)();
			})
	);
	h.check(hidden === false, 'indicator hides outside VR mode');

	await h.finish(browser);
});
