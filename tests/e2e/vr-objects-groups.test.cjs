// Phase 215: VR objects panel — expandable groups. A group row shows a caret
// (vrpanel-expand:<uuid>); toggling it inlines the group's children (indented).
// Tapping a child row selects the child; tapping the group row selects the group.
// On-device pose/feel is the user's manual check.
const h = require('./helpers.cjs');

const panelRows = (A) =>
	A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-objects-panel');
					const selects = [];
					const expands = [];
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrpanel-select:')) selects.push(o.name.slice('vrpanel-select:'.length));
						if (o.name?.startsWith('vrpanel-expand:')) expands.push(o.name.slice('vrpanel-expand:'.length));
					});
					resolve({ selects, expands });
				})();
			})
	);

const selectedUuid = (A) =>
	A.page.evaluate(() => {
		let v;
		window.__stores.selectedObject.subscribe((x) => (v = x))();
		return v?.uuid;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// two boxes grouped, plus one standalone top-level box; open the panel in VR
	const setup = await A.page.evaluate(() => {
		const { commandsHandler, objectActions } = window.__stores;
		const root = () => {
			let v;
			window.__stores.objectsGroup.subscribe((x) => (v = x))();
			return v;
		};
		commandsHandler.sceneCommand('/create box');
		commandsHandler.sceneCommand('/create box');
		let r = root();
		const b1 = r.children[r.children.length - 2].uuid;
		const b2 = r.children[r.children.length - 1].uuid;
		commandsHandler.sceneCommand('/group');
		r = root();
		const grp = r.children.find((c) => c.type === 'Group');
		objectActions.moveObjectToGroup(b1, grp.uuid);
		objectActions.moveObjectToGroup(b2, grp.uuid);
		commandsHandler.sceneCommand('/create box'); // standalone
		r = root();
		const solo = r.children[r.children.length - 1].uuid;
		window.__stores.isVRMode.set(true);
		window.__stores.vrObjectsPanelOpen.set(true);
		return { group: grp.uuid, b1, b2, solo, topCount: r.children.length };
	});
	await A.page.waitForTimeout(500);
	h.check(setup.topCount === 2, `two top-level rows: the group + one standalone (${setup.topCount})`);

	// collapsed: only the two top-level rows, the group carries a caret
	let rows = await panelRows(A);
	h.check(
		rows.selects.length === 2 && rows.selects.includes(setup.group) && rows.selects.includes(setup.solo),
		`collapsed shows the top-level rows only (${rows.selects.length})`
	);
	h.check(
		!rows.selects.includes(setup.b1) && !rows.selects.includes(setup.b2),
		'group children stay hidden while collapsed'
	);
	h.check(rows.expands.length === 1 && rows.expands[0] === setup.group, 'the group row shows an expand caret');

	// expand: children inline
	await A.page.evaluate((g) => window.__stores.vrControls.executeVRMenuAction('panel:expand:' + g), setup.group);
	await A.page.waitForTimeout(400);
	rows = await panelRows(A);
	h.check(
		rows.selects.length === 4 && rows.selects.includes(setup.b1) && rows.selects.includes(setup.b2),
		`expanding the group inlines its two children (${rows.selects.length})`
	);

	// tap a child row selects the child
	await A.page.evaluate((c) => window.__stores.vrControls.executeVRMenuAction('panel:select:' + c), setup.b1);
	h.check((await selectedUuid(A)) === setup.b1, 'tapping a child row selects the child');

	// tap the group row selects the whole group
	await A.page.evaluate((g) => window.__stores.vrControls.executeVRMenuAction('panel:select:' + g), setup.group);
	h.check((await selectedUuid(A)) === setup.group, 'tapping the group row selects the group');

	// collapse: children hidden again
	await A.page.evaluate((g) => window.__stores.vrControls.executeVRMenuAction('panel:expand:' + g), setup.group);
	await A.page.waitForTimeout(400);
	rows = await panelRows(A);
	h.check(
		rows.selects.length === 2 && !rows.selects.includes(setup.b1),
		`collapsing hides the children again (${rows.selects.length})`
	);

	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('panel:close'));
	await h.finish(browser);
});
