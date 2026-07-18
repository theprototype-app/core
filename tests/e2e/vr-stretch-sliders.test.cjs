// Phase 193: VR stretch is now per-axis infinite sliders in the Edit>Stretch
// menu (replacing the risky two-grip gesture). Each slider scales ONE axis (not
// the whole object). The slider DRAG itself needs a headset (controller motion);
// here we verify the sliders render + the per-axis model (setStretch) they drive.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		window.__box = box;
		s.objectActions.selectObject(box.uuid);
		s.vrEditMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('edit:mode:stretch');
	});
	await A.page.waitForTimeout(400);

	// three W/H/D slider handles render in the stretch tab
	const handles = await A.page.evaluate(() => {
		let g;
		window.__stores.vrControls.vrEditGroup.subscribe((v) => (g = v))();
		if (!g) return [];
		const names = [];
		g.traverse((o) => {
			if (o.name && o.name.startsWith('vrstretch-')) names.push(o.name);
		});
		return names.sort();
	});
	h.check(
		handles.includes('vrstretch-0') && handles.includes('vrstretch-1') && handles.includes('vrstretch-2'),
		`three W/H/D slider handles render (${handles.join(',')})`
	);

	// per-axis model: each slider (setStretch) scales ONLY its axis
	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const vc = s.vrControls;
		const box = window.__box;
		const st = vc.stretchState();
		const dim = () => {
			const p = box.geometry.attributes.position;
			let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
			for (let i = 0; i < p.count; i++) {
				x0 = Math.min(x0, p.getX(i)); x1 = Math.max(x1, p.getX(i));
				y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i));
				z0 = Math.min(z0, p.getZ(i)); z1 = Math.max(z1, p.getZ(i));
			}
			return { w: x1 - x0, h: y1 - y0, d: z1 - z0 };
		};
		const d0 = dim();
		vc.setStretch(0, 2); // width slider x2
		const dW = dim();
		vc.setStretch(1, 0.5); // height slider x0.5 (width stays x2)
		const dH = dim();
		const factors = vc.stretchFactors();
		vc.commitStretch();
		const dCommit = dim();
		s.history.undo();
		const dUndo = dim();
		return { targeted: !!st && st.uuid === box.uuid, d0, dW, dH, factors, dCommit, dUndo };
	});

	h.check(res.targeted, 'stretch targets the selected object');
	h.check(
		res.dW.w > res.d0.w * 1.8 && Math.abs(res.dW.h - res.d0.h) < 0.01 && Math.abs(res.dW.d - res.d0.d) < 0.01,
		'the width slider scales ONLY width (per-axis, not the whole object)'
	);
	h.check(res.dH.h < res.d0.h * 0.6 && res.dH.w > res.d0.w * 1.8, 'the height slider scales height while width stays stretched (independent)');
	h.check(res.factors[0] === 2 && res.factors[1] === 0.5 && res.factors[2] === 1, `factors track per-axis (${res.factors.join(',')})`);
	h.check(Math.abs(res.dCommit.w - res.dW.w) < 0.01, 'commit bakes the per-axis stretch');
	h.check(Math.abs(res.dUndo.w - res.d0.w) < 0.02, 'the stretch is undoable');

	await h.finish(browser);
});
