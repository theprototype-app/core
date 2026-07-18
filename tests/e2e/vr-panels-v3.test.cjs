// Phase 120: VR panels v3 — objects list stays open on select, per-row focus
// (dbl-click + ⌖ button) and properties (ⓘ) buttons, scrollbar indicator, and
// the slimmer Edit ▸ Properties row set. Live stick-follow selection and the
// actual VR focus teleport are the user's manual check (session-gated).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const read = (n) =>
		A.page.evaluate((name) => {
			let v;
			window.__stores[name].subscribe((x) => (v = x))();
			return v && v.uuid !== undefined ? v.uuid : v;
		}, n);

	// ten objects so the list scrolls (> 8 rows)
	await A.page.evaluate(async () => {
		for (let i = 0; i < 10; i++) window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__ids = group.children.slice(-10).map((c) => c.uuid);
		window.__stores.isVRMode.set(true);
		window.__stores.vrObjectsPanelOpen.set(true);
	});
	await A.page.waitForTimeout(500);

	// --- select keeps the panel OPEN (120.1) ---
	const sel = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrControls.executeVRMenuAction('panel:select:' + window.__ids[3]);
		let open, selUuid;
		s.vrObjectsPanelOpen.subscribe((v) => (open = v))();
		s.selectedObject.subscribe((v) => (selUuid = v?.uuid))();
		return { open, selUuid };
	});
	h.check(sel.open === true, 'selecting a row keeps the panel open');
	h.check(sel.selUuid === (await A.page.evaluate(() => window.__ids[3])), 'the row selects its object');

	// --- ⓘ properties opens the props panel for that row + closes the list ---
	const props = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrControls.executeVRMenuAction('panel:props:' + window.__ids[5]);
		let propsOpen, listOpen, selUuid;
		s.vrPropsPanelOpen.subscribe((v) => (propsOpen = v))();
		s.vrObjectsPanelOpen.subscribe((v) => (listOpen = v))();
		s.selectedObject.subscribe((v) => (selUuid = v?.uuid))();
		s.vrPropsPanelOpen.set(false);
		s.vrObjectsPanelOpen.set(true);
		return { propsOpen, listOpen, focused: selUuid === window.__ids[5] };
	});
	h.check(props.propsOpen === true && props.listOpen === false, 'ⓘ opens the properties panel and closes the list');
	h.check(props.focused, 'properties opens for the row object');

	// --- ⌖ focus selects the row (the teleport itself is session-gated) ---
	const focus = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrControls.executeVRMenuAction('panel:focus:' + window.__ids[7]);
		let selUuid, open;
		s.selectedObject.subscribe((v) => (selUuid = v?.uuid))();
		s.vrObjectsPanelOpen.subscribe((v) => (open = v))();
		return { focused: selUuid === window.__ids[7], open };
	});
	h.check(focus.focused, 'focus button selects the row object');
	h.check(focus.open === true, 'focus does not close the list');

	// --- double-select on the same row within the window routes to focus ---
	const dbl = await A.page.evaluate(() => {
		const s = window.__stores;
		// two rapid selects on the same uuid — the 2nd is swallowed as focus, no
		// error, panel stays open, selection holds
		s.vrControls.executeVRMenuAction('panel:select:' + window.__ids[2]);
		s.vrControls.executeVRMenuAction('panel:select:' + window.__ids[2]);
		let open, selUuid;
		s.vrObjectsPanelOpen.subscribe((v) => (open = v))();
		s.selectedObject.subscribe((v) => (selUuid = v?.uuid))();
		return { open, focused: selUuid === window.__ids[2] };
	});
	h.check(dbl.open === true && dbl.focused, 'a double-select stays open and keeps the selection (focus path)');

	// --- rendered: cursor row shows focus/props buttons; scrollbar present ---
	const rendered = await A.page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const panel = scene?.getObjectByName('vr-objects-panel');
		const names = [];
		let scrollbarMeshes = 0;
		panel?.traverse((o) => {
			if (o.name?.startsWith('vrpanel-')) names.push(o.name.split(':')[0].slice('vrpanel-'.length));
			if (o.isMesh && Math.abs((o.geometry?.parameters?.width ?? 0) - 0.004) < 1e-6) scrollbarMeshes++;
		});
		return { acts: [...new Set(names)], scrollbarMeshes };
	});
	h.check(
		['select', 'focus', 'visible', 'rename', 'props', 'delete'].every((a) => rendered.acts.includes(a)),
		`cursor row has all row actions (${rendered.acts.join(',')})`
	);
	h.check(rendered.scrollbarMeshes >= 2, `scrollbar track + thumb render for a long list (${rendered.scrollbarMeshes})`);

	// --- Edit ▸ Properties row set slimmed (120.5) ---
	const rows = await A.page.evaluate(() => window.__stores.vrControls.PROPS_ROWS);
	h.check(
		!rows.includes('color') && !rows.includes('duplicate') && !rows.includes('delete') && rows.includes('opacity') && rows.includes('visible'),
		`props rows drop color/dup/delete, keep transforms+opacity+visible (${rows.length})`
	);

	await h.finish(browser);
});
