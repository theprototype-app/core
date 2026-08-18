// 21-D4 — interactive HUD inputs: slider, toggle, dropdown, text field.
//
// A HUD with no input cannot be a settings menu, which is why these exist. The design
// decision worth testing is the DEFAULT: a value is LOCAL to the peer that set it, and an
// element opts INTO sharing. Get that backwards and my own volume slider changes everyone
// else's — a failure nobody files as a sync bug, because it looks like the feature working.
//
// Asserted here:
//   1. the four kinds are in the registry, in the Input group, each `valued`
//   2. each renders a REAL control that writes through setHudValue
//   3. a value is LOCAL by default: the peer does NOT see it
//   4. `shared: true` replicates, latest-wins per element on a monotonic stamp
//   5. a late joiner receives the SHARED values only (gethudvalues), never the local ones
//   6. the `hudinput` node reads a value: as a number, a dropdown INDEX, or text
//   7. the `hudset` node writes one, on the trigger edge and NOT every frame
//   8. the artboard is INERT — dragging a slider while laying out a menu changes nothing
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-inputs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ---- 1. the registry -----------------------------------------------------
	const registry = await page.evaluate(() => {
		const k = window.__stores.hudKinds;
		return ['slider', 'toggle', 'dropdown', 'textfield'].map((key) => {
			const def = k.kindDef(key);
			return {
				key,
				group: def?.group,
				valued: k.isValuedKind(key),
				interactive: k.isInteractiveKind(key),
				hasShared: (def?.fields ?? []).some((f) => f.key === 'shared'),
				fields: (def?.fields ?? []).length
			};
		});
	});
	h.check(
		registry.every((r) => r.group === 'Input' && r.valued && r.interactive),
		`all four input kinds are registered, valued and interactive (${registry.map((r) => r.key).join(', ')})`
	);
	h.check(
		registry.every((r) => r.hasShared),
		'and each carries the `shared` flag, spelled the same way on every one'
	);
	h.check(
		registry.every((r) => r.fields >= 4),
		`with their own parameters (${registry.map((r) => r.key + ':' + r.fields).join(' ')})`
	);

	// ---- 2. they render real controls ----------------------------------------
	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1700);
	const built = await page.evaluate(async () => {
		const s = window.__stores;
		const doc = s.hudDocs.hudDocOf('scene');
		const sid = doc.screens[0].id;
		const mk = (kind, patch) => s.hudDocs.addHudElement('scene', sid, { kind, ...patch }).id;
		const ids = {
			slider: mk('slider', { label: 'Volume', min: 0, max: 100, value: 50, y: 10 }),
			toggle: mk('toggle', { label: 'Invert Y', value: false, y: 60 }),
			dropdown: mk('dropdown', { options: 'Easy, Normal, Hard', value: 'Normal', y: 110 }),
			textfield: mk('textfield', { value: '', placeholder: 'name', y: 160 }),
			// the SHARED one, so both halves of the rule are exercised on one screen
			shared: mk('slider', { label: 'Difficulty', min: 0, max: 10, value: 5, shared: true, y: 210 })
		};
		await new Promise((r) => setTimeout(r, 700));
		return { sid, ids };
	});
	h.check(!!built.ids.slider && !!built.ids.shared, 'premise: five input elements on the screen');

	// D5 hides the HUD in the viewport WHILE AUTHORING (that was the user's report), so the
	// runtime layer renders nothing with the editor open. Turn the preview on rather than
	// closing the editor - it is the same code path a user reaches with the eye toggle, and
	// section 8 needs the artboard back.
	await page.evaluate(() => window.__stores.hudDocs.hudPreviewInViewport.set(true));
	await page.waitForTimeout(700);

	const rendered = await page.evaluate((ids) => {
		const at = (id, sel) => document.querySelector(`#hud-layer [data-hud-id="${id}"] ${sel}`);
		return {
			range: !!at(ids.slider, 'input[type="range"]'),
			toggle: !!at(ids.toggle, 'button.hud-toggle') || !!at(ids.toggle, '[aria-pressed]'),
			select: !!at(ids.dropdown, 'select'),
			text: !!at(ids.textfield, 'input[type="text"]'),
			options: [...(at(ids.dropdown, 'select')?.options ?? [])].map((o) => o.value)
		};
	}, built.ids);
	h.check(rendered.range, 'the slider renders a real range input in the runtime layer');
	h.check(rendered.toggle, 'the toggle renders a pressable control');
	h.check(rendered.select, 'the dropdown renders a select');
	h.check(rendered.text, 'the text field renders a text input');
	h.check(
		JSON.stringify(rendered.options) === JSON.stringify(['Easy', 'Normal', 'Hard']),
		`whose options come from the element's own comma list (${JSON.stringify(rendered.options)})`
	);

	// a REAL drag on the real control, so the write path is the user's
	const dragged = await page.evaluate(async (id) => {
		const el = document.querySelector(`#hud-layer [data-hud-id="${id}"] input[type="range"]`);
		if (!el) return null;
		el.value = '80';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 400));
		return window.__stores.hudDocs.hudValueOf(id);
	}, built.ids.slider);
	h.check(dragged === 80, `moving it writes the value (${dragged})`);

	// ---- 3./4. LOCAL by default, SHARED by flag -------------------------------
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });
	await h.connect(B, A);
	await B.page.waitForTimeout(3000);

	const peerHasDoc = await B.page.evaluate(
		(sid) => !!window.__stores.hudDocs.hudDocOf('scene')?.screens?.some((s) => s.id === sid),
		built.sid
	);
	h.check(peerHasDoc, 'premise: the peer holds the HUD document');

	await page.evaluate(async (ids) => {
		const s = window.__stores;
		s.hudDocs.setHudValue(ids.slider, 33, { shared: false });
		s.hudDocs.setHudValue(ids.shared, 9, { shared: true });
		await new Promise((r) => setTimeout(r, 900));
	}, built.ids);
	await B.page.waitForTimeout(1200);
	const onPeer = await B.page.evaluate(
		(ids) => ({
			local: window.__stores.hudDocs.hudValueOf(ids.slider),
			shared: window.__stores.hudDocs.hudValueOf(ids.shared)
		}),
		built.ids
	);
	h.check(onPeer.local === undefined, `a LOCAL value stays local — the peer never sees it (${onPeer.local})`);
	h.check(onPeer.shared === 9, `a SHARED value replicates (${onPeer.shared})`);

	// monotonic stamps: a burst inside one millisecond must not lose everything after the
	// first write, which is what a `>=` guard on Date.now() does
	const burst = await page.evaluate(async (id) => {
		const s = window.__stores;
		for (let i = 1; i <= 6; i++) s.hudDocs.setHudValue(id, i, { shared: true });
		await new Promise((r) => setTimeout(r, 1000));
		return s.hudDocs.hudValueOf(id);
	}, built.ids.shared);
	await B.page.waitForTimeout(1400);
	const burstPeer = await B.page.evaluate((id) => window.__stores.hudDocs.hudValueOf(id), built.ids.shared);
	h.check(burst === 6, `six writes inside one millisecond all land locally (${burst})`);
	h.check(burstPeer === 6, `and the peer ends on the LAST one, not the first (${burstPeer})`);

	// ---- 5. a late joiner gets the shared values, and only those --------------
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });
	await h.connect(C, A);
	let late = null;
	for (let i = 0; i < 24 && late === undefined ? true : late === null; i++) {
		late = await C.page.evaluate((ids) => {
			const v = window.__stores.hudDocs.hudValueOf(ids.shared);
			return v === undefined ? null : { shared: v, local: window.__stores.hudDocs.hudValueOf(ids.slider) };
		}, built.ids);
		if (!late) await C.page.waitForTimeout(300);
	}
	h.check(late?.shared === 6, `a late joiner is handed the shared value (${JSON.stringify(late)})`);
	h.check(late?.local === undefined, 'and not the local ones — they are nobody else’s business');

	// ---- 6. the hudinput node READS a value ----------------------------------
	await page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.flowGraphClose.set(false);
		window.__stores.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(1400);
	const read = await page.evaluate(async (ids) => {
		const s = window.__stores;
		const mk = (id, type, data) =>
			s.nodesHandler.createFlowNode({ id, type, position: { x: 40, y: 40 }, data: { type, ...data } });
		mk('in-num', 'hudinput', { element: ids.slider, read: 'value', fallback: 0 });
		mk('in-idx', 'hudinput', { element: ids.dropdown, read: 'index', fallback: -1 });
		mk('in-txt', 'hudinput', { element: ids.textfield, read: 'text', fallback: '' });
		mk('in-on', 'hudinput', { element: ids.toggle, read: 'on', fallback: 0 });
		mk('in-miss', 'hudinput', { element: 'no-such-element', read: 'value', fallback: 7 });
		// set the values a player would have set
		s.hudDocs.setHudValue(ids.slider, 42);
		s.hudDocs.setHudValue(ids.dropdown, 'Hard');
		s.hudDocs.setHudValue(ids.textfield, 'Ada');
		s.hudDocs.setHudValue(ids.toggle, true);
		await new Promise((r) => setTimeout(r, 900));
		let v;
		s.flowValues.subscribe((x) => (v = x))();
		return { num: v['in-num'], idx: v['in-idx'], txt: v['in-txt'], on: v['in-on'], miss: v['in-miss'] };
	}, built.ids);
	h.check(read.num === 42, `HUD Input reads a slider as a number (${read.num})`);
	h.check(read.idx === 2, `a dropdown as its INDEX in its own option list, which is what a Switcher wants (${read.idx})`);
	h.check(read.txt === 'Ada', `a text field as text (${JSON.stringify(read.txt)})`);
	h.check(read.on === 1, `a toggle as 1/0, so it can gate a Compare (${read.on})`);
	h.check(read.miss === 7, `and an element nobody has touched reads the FALLBACK (${read.miss})`);

	// The read is LOCAL: the peer holds the same graph and its own (absent) values.
	// `createFlowNode` is the APPLIER and does not broadcast (the flowNodes.set trap), so
	// push the graph rather than waiting on nodesync's periodic hash compare - which would
	// make this pass slowly and racily instead of cleanly.
	await page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), B.id);
	let readB = undefined;
	for (let i = 0; i < 24 && readB === undefined; i++) {
		readB = await B.page.evaluate(() => {
			let g;
			window.__stores.flowGraphs.subscribe((x) => (g = x))();
			if (!(g.scene?.nodes ?? []).some((n) => n.id === 'in-num')) return undefined;
			let v;
			window.__stores.flowValues.subscribe((x) => (v = x))();
			return v['in-num'];
		});
		if (readB === undefined) await B.page.waitForTimeout(300);
	}
	h.check(
		readB === 0,
		`the peer evaluates the same node against ITS OWN value, so a local slider does not leak through the graph (${readB})`
	);

	// ---- 7. hudset writes one, on the trigger EDGE ---------------------------
	const written = await page.evaluate(async (ids) => {
		const s = window.__stores;
		s.nodesHandler.createFlowNode({
			id: 'set-vol',
			type: 'hudset',
			position: { x: 300, y: 40 },
			data: { type: 'hudset', element: ids.slider, value: 11 }
		});
		s.nodesHandler.createFlowNode({
			id: 'set-btn',
			type: 'hudbutton',
			position: { x: 140, y: 40 },
			data: { type: 'hudbutton', element: 'x' }
		});
		s.nodesHandler.createFlowEdge({ id: 'e-set', source: 'set-btn', target: 'set-vol', targetHandle: 'trigger' });
		await new Promise((r) => setTimeout(r, 600));
		const before = s.hudDocs.hudValueOf(ids.slider);
		s.flowRuntime.fireHudButton('x');
		await new Promise((r) => setTimeout(r, 700));
		const after = s.hudDocs.hudValueOf(ids.slider);
		// and NOT every frame: move it by hand and it must STAY moved while the pulse rests
		s.hudDocs.setHudValue(ids.slider, 77);
		await new Promise((r) => setTimeout(r, 900));
		return { before, after, rested: s.hudDocs.hudValueOf(ids.slider) };
	}, built.ids);
	h.check(written.after === 11, `HUD Set Input writes the value on a press (${written.before} -> ${written.after})`);
	h.check(
		written.rested === 77,
		`and only on the trigger EDGE: a resting pulse does not fight the player's own pointer (${written.rested})`
	);

	// ---- 8. the artboard is inert -------------------------------------------
	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1500);
	const inert = await page.evaluate(async (ids) => {
		const before = window.__stores.hudDocs.hudValueOf(ids.slider);
		const el = document.querySelector(`#hud-board [data-hud-item="${ids.slider}"] input[type="range"]`);
		if (!el) return { error: 'no slider on the artboard' };
		const disabled = el.disabled;
		el.value = '3';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 500));
		return { before, disabled, after: window.__stores.hudDocs.hudValueOf(ids.slider) };
	}, built.ids);
	h.check(!inert.error, `premise: the artboard draws the slider (${inert.error ?? 'it does'})`);
	h.check(inert.disabled === true, 'the artboard control is disabled');
	h.check(
		inert.after === inert.before,
		`so laying out a menu cannot set the game's own values (${inert.before} -> ${inert.after})`
	);

	h.check(h.pageErrors(A).length === 0, `no render crash on A (${JSON.stringify(h.pageErrors(A))})`);
	h.check(h.pageErrors(B).length === 0, `nor on the peer (${JSON.stringify(h.pageErrors(B))})`);
	await h.finish(browser);
});
