// Phase 112: VR Edit ▸ Properties panel — the ring entry + open wiring, the
// rendered control set, snap-aware nudge steps, and every action routing
// through the normal replicated/undoable paths (move, setMaterialParam,
// objectActions). On-device stick/ray feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure step math ---
	const steps = await A.page.evaluate(() => {
		const v = window.__stores.vrControls;
		const s = { translate: 0.5, rotateDeg: 15, scale: 0.1 };
		return {
			posSnap: v.nudgeStep('pos', true, s),
			posFree: v.nudgeStep('pos', false, s),
			rotSnap: v.nudgeStep('rot', true, s),
			rotFree: v.nudgeStep('rot', false, s),
			scaleSnap: v.nudgeStep('scale', true, s),
			rows: v.PROPS_ROWS.join(','),
			pressAxis: v.propsRowAction('pos:x'),
			pressOpacity: v.propsRowAction('opacity'),
			pressDelete: v.propsRowAction('delete')
		};
	});
	h.check(
		steps.posSnap === 0.5 && steps.posFree === 0.1 && steps.scaleSnap === 0.1,
		`pos/scale steps are snap-aware (${steps.posSnap}/${steps.posFree})`
	);
	h.check(
		Math.abs(steps.rotSnap - (15 * Math.PI) / 180) < 1e-9 &&
			Math.abs(steps.rotFree - (5 * Math.PI) / 180) < 1e-9,
		'rotation steps convert degrees to radians'
	);
	h.check(
		steps.rows.startsWith('pos:x,pos:y,pos:z,rot:x') && steps.rows.endsWith('duplicate,delete'),
		`row order: transforms, opacity, color, actions (${steps.rows})`
	);
	h.check(
		steps.pressAxis === 'props:nudge:pos:x:1' &&
			steps.pressOpacity === 'props:opacity:1' &&
			steps.pressDelete === 'props:delete',
		'stick-press maps rows to their actions'
	);

	// --- ring entry opens the panel and closes the other menu-hand surfaces ---
	const wiring = await A.page.evaluate(() => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const s = window.__stores;
		const inRing = s.vrRadialMenu.ringEntries('object').some((e) => e.id === 'obj:props');
		s.vrPaletteOpen.set(true);
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('obj:props');
		return {
			inRing,
			open: read(s.vrPropsPanelOpen),
			palette: read(s.vrPaletteOpen),
			menu: read(s.vrMenuOpen)
		};
	});
	h.check(wiring.inRing, 'Edit ring gained Properties');
	h.check(
		wiring.open === true && wiring.palette === false && wiring.menu === false,
		'Edit - Properties opens the panel and closes ring + palette'
	);

	// --- rendered control set (needs a selection) ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__stores.objectActions.selectObject(box);
		window.__box = box;
	});
	await A.page.waitForTimeout(500);
	const names = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-props-panel');
					const found = [];
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrprops-')) found.push(o.name.slice(8));
					});
					resolve(found);
				})();
			})
	);
	h.check(
		names.includes('nudge:pos:x:-1') &&
			names.includes('nudge:scale:z:1') &&
			names.includes('opacity:1') &&
			names.includes('color') &&
			names.includes('visible') &&
			names.includes('duplicate') &&
			names.includes('delete') &&
			names.includes('close'),
		`panel renders the core control set (${names.length} controls)`
	);

	// --- nudges: local apply + undo entry + replicated move path ---
	const nudge = await A.page.evaluate(() => {
		const v = window.__stores.vrControls;
		const box = window.__box;
		const x0 = box.position.x;
		v.executeVRMenuAction('props:nudge:pos:x:1');
		const x1 = box.position.x;
		const ry0 = box.rotation.y;
		v.executeVRMenuAction('props:nudge:rot:y:-1');
		const ry1 = box.rotation.y;
		const sz0 = box.scale.z;
		v.executeVRMenuAction('props:nudge:scale:z:1');
		const sz1 = box.scale.z;
		window.__stores.history.undo();
		const szAfterUndo = box.scale.z;
		return { dx: x1 - x0, dry: ry1 - ry0, dsz: sz1 - sz0, szAfterUndo, sz0 };
	});
	h.check(Math.abs(nudge.dx - 0.1) < 1e-9, `pos nudge steps by 0.1 unsnapped (${nudge.dx})`);
	h.check(Math.abs(nudge.dry + (5 * Math.PI) / 180) < 1e-9, 'rot nudge steps by -5°');
	h.check(
		Math.abs(nudge.dsz - 0.1) < 1e-9 && Math.abs(nudge.szAfterUndo - nudge.sz0) < 1e-9,
		'scale nudge records an undoable entry'
	);

	// --- opacity routes through setMaterialParam (transparent auto-arms) ---
	const opacity = await A.page.evaluate(() => {
		const v = window.__stores.vrControls;
		const box = window.__box;
		v.executeVRMenuAction('props:opacity:-1');
		return { opacity: box.material.opacity, transparent: box.material.transparent };
	});
	h.check(
		Math.abs(opacity.opacity - 0.9) < 1e-9 && opacity.transparent === true,
		`opacity nudges to 0.9 and arms transparency (${opacity.opacity})`
	);

	// --- visibility, color, duplicate, delete ---
	const actions = await A.page.evaluate(async () => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const s = window.__stores;
		const v = s.vrControls;
		const box = window.__box;
		v.executeVRMenuAction('props:visible');
		const hidden = box.visible === false;
		v.executeVRMenuAction('props:visible');
		v.executeVRMenuAction('props:color');
		const paletteOpen = read(s.vrPaletteOpen);
		const propsClosedByColor = read(s.vrPropsPanelOpen) === false;
		s.vrPaletteOpen.set(false);
		s.vrPropsPanelOpen.set(true);
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const before = group.children.length;
		v.executeVRMenuAction('props:duplicate');
		const afterDup = group.children.length;
		// delete removes the selection and closes the panel
		v.executeVRMenuAction('props:delete');
		const afterDelete = group.children.length;
		const closed = read(s.vrPropsPanelOpen) === false;
		return { hidden, paletteOpen, propsClosedByColor, before, afterDup, afterDelete, closed };
	});
	h.check(actions.hidden, 'Visible row toggles the selection');
	h.check(
		actions.paletteOpen && actions.propsClosedByColor,
		'Color row hands off to the palette panel'
	);
	h.check(
		actions.afterDup === actions.before + 1 && actions.afterDelete === actions.afterDup - 1,
		`Duplicate/Delete route through objectActions (${actions.before}→${actions.afterDup}→${actions.afterDelete})`
	);
	h.check(actions.closed, 'Delete closes the panel');

	await h.finish(browser);
});
