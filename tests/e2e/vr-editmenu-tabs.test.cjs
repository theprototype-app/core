// Phase 181: the VR Edit-Mesh and Snap menus lay their modes out as a horizontal
// TAB bar (one row, left-to-right) with an X close control in the corner
// (replacing the "Done" row). Verified structurally by traversing the mounted
// control-mesh groups; on-device feel is the user's manual check.
const h = require('./helpers.cjs');

const meshesOf = (page, groupKey, prefix) =>
	page.evaluate(
		({ groupKey, prefix }) => {
			let g;
			window.__stores.vrControls[groupKey].subscribe((v) => (g = v))();
			if (!g) return null;
			const m = {};
			g.traverse((o) => {
				if (o.name && o.name.startsWith(prefix)) m[o.name] = { x: +o.position.x.toFixed(3), y: +o.position.y.toFixed(3) };
			});
			return m;
		},
		{ groupKey, prefix }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the Edit-Mesh menu in vertices mode
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		s.meshEdit.enterEditMode(box.uuid);
		s.vrEditMenuOpen.set(true);
	});
	await A.page.waitForTimeout(500);

	const edit = await meshesOf(A.page, 'vrEditGroup', 'vredit-');
	h.check(!!edit, 'the VR edit menu group mounts headlessly');
	const et = ['vredit-edit:mode:vertices', 'vredit-edit:mode:faces', 'vredit-edit:mode:stretch'].map((n) => edit && edit[n]);
	h.check(et.every(Boolean), 'the three Edit mode tabs render');
	h.check(Math.abs(et[0].y - et[1].y) < 1e-6 && Math.abs(et[1].y - et[2].y) < 1e-6, 'Edit mode tabs share one row (horizontal tab bar)');
	h.check(et[0].x < et[1].x && et[1].x < et[2].x, 'Edit mode tabs run left-to-right');
	h.check(!!(edit && edit['vredit-edit:close']), 'the Edit menu has an X close control (not a Done row)');
	h.check(edit['vredit-edit:close'].y > et[0].y, 'the close sits in the corner, above the tab bar');

	// open the Snap menu
	await A.page.evaluate(() => window.__stores.vrSnapMenuOpen.set(true));
	await A.page.waitForTimeout(400);
	const snap = await meshesOf(A.page, 'vrSnapGroup', 'vrsnap-');
	h.check(!!snap, 'the VR snap menu group mounts');
	const st = ['vrsnap-snap:mode:off', 'vrsnap-snap:mode:grid', 'vrsnap-snap:mode:surface', 'vrsnap-snap:mode:rotation'].map((n) => snap && snap[n]);
	h.check(st.every(Boolean), 'the four Snap mode tabs render');
	h.check(st.every((t, i) => i === 0 || Math.abs(t.y - st[0].y) < 1e-6), 'Snap mode tabs share one row (horizontal tab bar)');
	h.check(st[0].x < st[1].x && st[1].x < st[2].x && st[2].x < st[3].x, 'Snap mode tabs run left-to-right');
	h.check(!!(snap && snap['vrsnap-snap:close']), 'the Snap menu has an X close control');

	await h.finish(browser);
});
