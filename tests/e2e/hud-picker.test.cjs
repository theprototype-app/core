// 21-D3 — the element/screen picker, to DCC standards.
//
// The control it replaces was an `<input list>` + `<datalist>`, and the user's report was
// about MEANING rather than about a bug: a text box whose suggestions narrow as you type
// reads as a FILTER, and it shows a raw id, so a field naming nothing looks exactly like a
// field naming a real button. Everything asserted here is one of those readings:
//
//   1. the field shows the RESOLVED name (label + kind, with the screen beside it)
//   2. a field naming something that is on no screen says so, in amber
//   3. the chevron opens the shared ContextMenu, GROUPED BY SCREEN
//   4. the X clears
//   5. the EYEDROPPER binds by clicking the element on the artboard, and that click does
//      NOT change the selection or nudge the layout
//   6. Escape cancels an armed pick WITHOUT dropping the selection
//   7. a typed id this editor cannot enumerate still works (the constraint the old
//      control got right, kept)
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-picker
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ---- 0. two screens with named elements, so grouping has something to group ----
	// The EDITOR is what creates a document (ensureDoc on open), so open it first — the
	// same order a user works in.
	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1700);
	const built = await page.evaluate(async () => {
		const s = window.__stores;
		const doc = s.hudDocs.hudDocOf('scene');
		const menu = doc.screens[0].id;
		const start = s.hudDocs.addHudElement('scene', menu, { kind: 'button', label: 'Start' }).id;
		const quit = s.hudDocs.addHudElement('scene', menu, { kind: 'button', label: 'Quit', y: 80 }).id;
		// a fresh document names its first screen after its ID, so name it - the menu groups
		// BY SCREEN NAME and 'Menu' is what a user would have called it
		s.hudDocs.setHudDocFor('scene', {
			...s.hudDocs.hudDocOf('scene'),
			screens: s.hudDocs.hudDocOf('scene').screens.map((sc, i) => (i === 0 ? { ...sc, name: 'Menu' } : sc))
		});
		const play = s.hudDocs.addHudScreen('scene', 'Playing');
		const score = s.hudDocs.addHudElement('scene', play, { kind: 'text', label: 'Score' }).id;
		// the artboard draws the ACTIVE screen and the eyedropper section clicks the Start
		// button, so leave the MENU screen active
		s.hudDocs.setActiveHudScreen('scene', menu);
		await new Promise((r) => setTimeout(r, 500));
		return { menu, play, start, quit, score };
	});
	h.check(!!built.start && !!built.score, 'premise: two screens carry three named elements');

	const choices = await page.evaluate(() => window.__stores.hudDocs.elementChoices('scene'));
	h.check(
		choices.length === 3 && choices.every((c) => typeof c.label === 'string'),
		`elementChoices carries the LABEL, which is what a person recognises (${choices.length})`
	);
	h.check(
		choices.some((c) => c.screen === 'Playing'),
		'and the screen each element lives on'
	);

	// resolveElement / resolveScreen are what the field renders from
	const resolved = await page.evaluate(
		(ids) => ({
			hit: window.__stores.hudDocs.resolveElement('scene', ids.start),
			miss: window.__stores.hudDocs.resolveElement('scene', 'no-such-element'),
			byName: window.__stores.hudDocs.resolveScreen(window.__stores.hudDocs.hudDocOf('scene'), 'Playing')?.id,
			byId: window.__stores.hudDocs.resolveScreen(window.__stores.hudDocs.hudDocOf('scene'), ids.play)?.id
		}),
		built
	);
	h.check(resolved.hit?.label === 'Start' && resolved.hit?.kind === 'button', 'a real id resolves to its label + kind');
	h.check(resolved.miss === null, 'and an id on no screen resolves to NOTHING, so the field can say so');
	h.check(resolved.byName === built.play && resolved.byId === built.play, 'a screen resolves by NAME as well as by id');

	// ---- 1. a hud node's field renders the resolved name, not the id ---------
	await page.evaluate(() => {
		// the node editor, scene graph: an object graph would address a different document
		window.__stores.objectActions.deselectObject();
		window.__stores.flowGraphClose.set(false);
		window.__stores.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(1500);
	const nodeId = await page.evaluate(async (id) => {
		const s = window.__stores;
		const nid = 'pick-' + Date.now();
		// createFlowNode takes a WHOLE node - the applier's shape
		s.nodesHandler.createFlowNode({ id: nid, type: 'hudtext', position: { x: 60, y: 60 }, data: { type: 'hudtext', label: 'HUD Text', element: id } });
		await new Promise((r) => setTimeout(r, 900));
		return nid;
	}, built.score);
	h.check(!!nodeId, 'premise: a hudtext node exists in the scene graph');

	const field = await page.evaluate(() => {
		const el = document.querySelector('.hud-ep');
		if (!el) return null;
		return {
			state: el.getAttribute('data-state'),
			name: el.querySelector('.hud-ep-name')?.textContent?.trim() ?? '',
			sub: el.querySelector('.hud-ep-sub')?.textContent?.trim() ?? '',
			hasChevron: !!el.querySelector('.hud-ep-field svg'),
			hasClear: !!el.querySelector('[aria-label="Clear"]'),
			hasPipette: !!el.querySelector('[aria-label="Pick on the artboard"]')
		};
	});
	h.check(!!field, 'the node card renders the picker');
	h.check(
		field.state === 'ready' && /Score/.test(field.name) && /text/.test(field.name),
		`showing the RESOLVED name, never the raw id (${JSON.stringify(field.name)})`
	);
	h.check(field.sub === 'Playing', `with the screen beside it (${JSON.stringify(field.sub)})`);
	h.check(field.hasChevron && field.hasClear && field.hasPipette, 'plus a chevron, a clear X and an eyedropper');

	// ---- 2. the UNRESOLVED state is visible, not silent ----------------------
	const unresolved = await page.evaluate(async (id) => {
		window.__stores.nodesHandler.setNodeData(id, { element: 'ghost-element-id' });
		await new Promise((r) => setTimeout(r, 700));
		const el = document.querySelector('.hud-ep');
		const name = el?.querySelector('.hud-ep-name');
		return {
			state: el?.getAttribute('data-state'),
			shown: name?.textContent?.trim(),
			colour: name ? getComputedStyle(name).color : ''
		};
	}, nodeId);
	h.check(unresolved.state === 'unresolved', 'an id on no screen puts the field in the unresolved state');
	h.check(unresolved.shown === 'ghost-element-id', 'it still SHOWS what the node holds, so nothing is hidden from you');
	// the COMPUTED colour, never the class string (the ToolboxWindow lesson)
	h.check(/^rgb\(251, 191, 36\)/.test(unresolved.colour), `and paints it amber (${unresolved.colour})`);

	// ---- 3. the chevron opens the shared menu, grouped by SCREEN -------------
	await page.evaluate(() => document.querySelector('.hud-ep-field')?.click());
	await page.waitForTimeout(600);
	const menu = await page.evaluate(() => {
		const m = document.querySelector('[role="menu"]');
		if (!m) return null;
		const text = [...m.querySelectorAll('*')].map((el) => (el.textContent ?? '').trim());
		return {
			sections: text.filter((t) => t === 'Menu' || t === 'Playing'),
			hasStart: text.some((t) => /^Start - button/.test(t)),
			hasManual: text.some((t) => /Enter id manually/.test(t))
		};
	});
	h.check(!!menu, 'the chevron opens the shared ContextMenu — portaled, clamped, searchable');
	h.check(menu.sections.length >= 2, `grouped by SCREEN (${JSON.stringify(menu.sections)})`);
	h.check(menu.hasStart, 'each row named by label + kind');
	h.check(menu.hasManual, 'and an "enter id manually" escape hatch, so an id it cannot enumerate still works');

	const picked = await page.evaluate(async () => {
		const row = [...document.querySelectorAll('[role="menu"] *')].find((el) =>
			/^Start - button/.test((el.textContent ?? '').trim())
		);
		row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 800));
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		return g.scene.nodes.find((n) => n.type === 'hudtext')?.data?.element ?? null;
	});
	h.check(picked === built.start, 'picking a row writes that element onto the node');

	// ---- 4. the X clears -----------------------------------------------------
	const cleared = await page.evaluate(async () => {
		document.querySelector('[aria-label="Clear"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 700));
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		const node = g.scene.nodes.find((n) => n.type === 'hudtext');
		return { element: node?.data?.element ?? '', state: document.querySelector('.hud-ep')?.getAttribute('data-state') };
	});
	h.check(cleared.element === '' && cleared.state === 'empty', 'the X clears the reference outright');

	// ---- 5. the EYEDROPPER: arm here, click there ----------------------------
	// The picker lives in the node editor and the artboard in the HUD editor, which is why
	// the seam is two write-once stores rather than a callback.
	const armed = await page.evaluate(async () => {
		document
			.querySelector('[aria-label="Pick on the artboard"]')
			?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		let t;
		window.__stores.hudDocs.hudPickArm.subscribe((v) => (t = v))();
		return { token: t, armedClass: !!document.querySelector('.hud-ep-armed') };
	});
	h.check(!!armed.token, 'the eyedropper arms a token');
	h.check(armed.armedClass, 'and the button shows it is armed');

	// open the HUD editor and click the Start button ON THE ARTBOARD
	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1600);
	const beforePick = await page.evaluate(() => {
		const s = window.__stores;
		let sel;
		s.hudDocs.hudSelection.subscribe((v) => (sel = v))();
		const el = s.hudDocs.hudDocOf('scene').screens[0].elements[0];
		return { picks: JSON.stringify(sel), x: el.x, y: el.y, id: el.id };
	});
	const dropped = await page.evaluate(async (id) => {
		const item = document.querySelector(`#hud-board [data-hud-item="${id}"]`);
		if (!item) return { error: 'the element is not on the artboard' };
		const r = item.getBoundingClientRect();
		item.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				button: 0,
				clientX: Math.round(r.x + r.width / 2),
				clientY: Math.round(r.y + r.height / 2)
			})
		);
		await new Promise((r2) => setTimeout(r2, 800));
		const s = window.__stores;
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		let sel;
		s.hudDocs.hudSelection.subscribe((v) => (sel = v))();
		let arm;
		s.hudDocs.hudPickArm.subscribe((v) => (arm = v))();
		const el = s.hudDocs.hudDocOf('scene').screens[0].elements[0];
		return {
			element: g.scene.nodes.find((n) => n.type === 'hudtext')?.data?.element ?? '',
			picks: JSON.stringify(sel),
			arm,
			x: el.x,
			y: el.y
		};
	}, beforePick.id);
	h.check(!dropped.error, `premise: the artboard shows the element (${dropped.error ?? 'it does'})`);
	h.check(dropped.element === beforePick.id, 'clicking it on the artboard BINDS it to the armed field');
	h.check(dropped.arm === null, 'and disarms');
	// picking a reference is not editing a layout: a pick that also selected the element,
	// or nudged it by a pixel, would be its own bug report
	h.check(dropped.picks === beforePick.picks, `the pick did not change the selection (${dropped.picks})`);
	h.check(dropped.x === beforePick.x && dropped.y === beforePick.y, 'nor move the element');

	// ---- 6. Escape cancels an armed pick and keeps the selection -------------
	const escaped = await page.evaluate(async (id) => {
		const s = window.__stores;
		// select something first, so we can see Escape spare it
		s.hudDocs.hudSelection.set({ [s.hudDocs.hudDocOf('scene').screens[0].id]: [id] });
		s.hudDocs.armHudPick('probe-token');
		await new Promise((r) => setTimeout(r, 250));
		const wrap = document.querySelector('#hud-board-wrap');
		wrap?.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
		await new Promise((r) => setTimeout(r, 400));
		let arm;
		s.hudDocs.hudPickArm.subscribe((v) => (arm = v))();
		let sel;
		s.hudDocs.hudSelection.subscribe((v) => (sel = v))();
		return { arm, picked: (Object.values(sel)[0] ?? []).length };
	}, beforePick.id);
	h.check(escaped.arm === null, 'Escape cancels an armed pick');
	h.check(escaped.picked === 1, 'and stops there — it does not also clear the selection');

	// ---- 7. a typed id this editor cannot enumerate still works --------------
	const manual = await page.evaluate(async () => {
		const s = window.__stores;
		// what "enter id manually" writes: an id from a module, or another document
		const nid = 'manual-' + Date.now();
		s.nodesHandler.createFlowNode({ id: nid, type: 'hudbar', position: { x: 60, y: 220 }, data: { type: 'hudbar', label: 'HUD Bar', element: 'made-by-a-module' } });
		await new Promise((r) => setTimeout(r, 700));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		return g.scene.nodes.find((n) => n.id === nid)?.data?.element;
	});
	h.check(manual === 'made-by-a-module', 'an id the editor cannot enumerate is still accepted and kept');

	h.check(h.pageErrors(A).length === 0, `no render crash (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
