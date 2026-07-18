// Phase 151: the 1/2/3 shortcuts drive the toolbar transform tint (via the
// shared transformMode store), and pressing the active mode again deselects +
// detaches the gizmo (a repeat press is "done", not a no-op). Toolbar setter
// and keyboard stay in sync.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = g.children[g.children.length - 1];
		window.__stores.objectActions.selectObject(window.__box.uuid);
	});
	await A.page.waitForTimeout(300);

	const read = () =>
		A.page.evaluate(() => {
			let tm; window.__stores.transformMode.subscribe((v) => (tm = v))();
			let tc; window.__stores.TControls.subscribe((v) => (tc = v))();
			const cls = (t) => {
				const el = document.querySelector(`p[title="${t}"] i`);
				return el ? el.className : '';
			};
			return {
				mode: tm,
				gizmoMode: tc && tc.mode,
				attached: !!(tc && tc.object),
				moveOn: cls('Move (1)').includes('text-primary-500'),
				rotateOn: cls('Rotate (2)').includes('text-primary-500'),
				scaleOn: cls('Scale (3)').includes('text-primary-500')
			};
		});

	// start in Rotate so Move is NOT already the active tint
	await A.page.keyboard.press('2');
	await A.page.waitForTimeout(150);
	let s = await read();
	h.check(s.mode === 'rotate' && s.gizmoMode === 'rotate' && s.rotateOn && !s.moveOn, 'pressing 2 tints Rotate + sets the gizmo mode');

	// pressing 1 now tints Move (the keyboard path drives the tint — the 151 fix)
	await A.page.keyboard.press('1');
	await A.page.waitForTimeout(150);
	s = await read();
	h.check(s.mode === 'translate' && s.gizmoMode === 'translate' && s.moveOn && !s.rotateOn, 'pressing 1 tints Move via the keyboard');
	h.check(s.attached, 'the gizmo stays attached when only the mode changes');

	// pressing 1 AGAIN (active mode) deselects + hides the gizmo
	await A.page.keyboard.press('1');
	await A.page.waitForTimeout(200);
	s = await read();
	h.check(!s.attached && !s.moveOn, 'pressing the active mode again detaches the gizmo + clears the tint (done)');

	// toolbar setter + shortcut share the mode
	await A.page.evaluate(() => {
		window.__stores.objectActions.selectObject(window.__box.uuid);
		window.__stores.objectActions.setTransformMode('scale');
	});
	await A.page.waitForTimeout(150);
	s = await read();
	h.check(s.mode === 'scale' && s.scaleOn, 'the toolbar setter tints Scale');
	await A.page.keyboard.press('2');
	await A.page.waitForTimeout(150);
	s = await read();
	h.check(s.mode === 'rotate' && s.rotateOn && !s.scaleOn, 'keyboard + toolbar share one mode (back to Rotate)');

	await h.finish(browser);
});
