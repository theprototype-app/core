// Roadmap #15 batch B — UI quick fixes:
//  B2 duplicating a multi-selection no longer bakes the selection highlight
//     into the first clone's material
//  B4 the Connect chevron badges toasts held by a CLOSED drawer
//  B5 Sessions names inline (no window.prompt)
//  B6 an open (non-modal) app modal mutes shortcuts + WASD camera fly
//  B7 dragWindow's opt-in resize persists a window size
//  B8 Edit mesh / Sculpt hide for a multi-selection
// (B1 lives in themed-select.test.cjs, B3 in the explorer/packs suites.)
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- B2: duplicate keeps the sources' real colors ----------
	const dup = await A.page.evaluate(async () => {
		const w = window.__stores;
		const uuids = [];
		for (let i = 0; i < 3; i++) {
			w.commandsHandler.sceneCommand('/create Box 1 1 1');
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			uuids.push(g.children[g.children.length - 1].uuid);
		}
		w.objectActions.applySelectionSet(uuids); // tints all three (member highlight)
		const clones = w.objectActions.duplicateSelection();
		w.objectActions.deselectObject(); // restores originals + clones
		await new Promise((r) => setTimeout(r, 100));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const emissiveOf = (uuid) => g.getObjectByProperty('uuid', uuid)?.material?.emissive?.getHex();
		return {
			count: clones.length,
			sources: uuids.map(emissiveOf),
			clones: clones.map(emissiveOf)
		};
	});
	h.check(dup.count === 3, `duplicated the whole set (${dup.count})`);
	h.check(
		dup.clones.every((hex) => hex === 0),
		`no clone wears the selection tint (${JSON.stringify(dup.clones.map((c) => c.toString(16)))})`
	);
	h.check(
		dup.sources.every((hex) => hex === 0),
		`sources restored too (${JSON.stringify(dup.sources.map((c) => c.toString(16)))})`
	);

	// ---------- B8: single-object modes hide for a set ----------
	const menus = await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const boxes = g.children.filter((c) => c.name?.startsWith('Box')).slice(0, 2);
		const labels = (items) => items.map((i) => i.label);
		w.objectActions.applySelectionSet([boxes[0].uuid]);
		const single = labels(w.objectMenu.buildObjectMenuItems(boxes[0].uuid));
		w.objectActions.applySelectionSet(boxes.map((b) => b.uuid));
		const multi = labels(w.objectMenu.buildObjectMenuItems(boxes[0].uuid));
		w.objectActions.deselectObject();
		return { single, multi };
	});
	h.check(
		menus.single.some((l) => l === 'Edit mesh') && menus.single.some((l) => /^Sculpt /.test(l)),
		`single selection still offers Edit mesh + Sculpt (${menus.single.filter((l) => /Edit mesh|Sculpt/.test(l))})`
	);
	h.check(
		!menus.multi.some((l) => l === 'Edit mesh') && !menus.multi.some((l) => /^Sculpt /.test(l)),
		`multi-selection hides them (${menus.multi.filter((l) => /Edit mesh|Sculpt/.test(l))})`
	);
	h.check(
		menus.multi.some((l) => /^Duplicate \(2\)$/.test(l)),
		'set-wide entries still counted'
	);

	// ---------- B6: a modal mutes shortcuts + the camera ----------
	const gated = await A.page.evaluate(async () => {
		const w = window.__stores;
		const before = await new Promise((r) => w.objectListClose.subscribe(r)());
		w.sessionsOpen.set(true);
		await new Promise((r) => setTimeout(r, 100));
		const modalOpen = await new Promise((r) => w.anyModalOpen.subscribe(r)());
		// 'o' toggles the object list; behind a modal it must do nothing
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
		await new Promise((r) => setTimeout(r, 100));
		const afterKey = await new Promise((r) => w.objectListClose.subscribe(r)());
		// WASD must not reach the fly-navigation either
		const cam = await new Promise((r) => w.globalCamera.subscribe(r)());
		const camBefore = cam.position.clone();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
		await new Promise((r) => setTimeout(r, 500));
		const movedWhileOpen = cam.position.distanceTo(camBefore);
		window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
		w.sessionsOpen.set(false);
		await new Promise((r) => setTimeout(r, 100));
		// and works again once the modal closes
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
		await new Promise((r) => setTimeout(r, 150));
		const afterClose = await new Promise((r) => w.objectListClose.subscribe(r)());
		return { before, modalOpen, afterKey, movedWhileOpen, afterClose };
	});
	h.check(gated.modalOpen === true, 'anyModalOpen tracks the sessions modal');
	h.check(gated.afterKey === gated.before, 'shortcut ignored while a modal is open');
	h.check(gated.movedWhileOpen < 0.001, `camera did not fly behind the modal (${gated.movedWhileOpen.toFixed(3)})`);
	h.check(gated.afterClose !== gated.before, 'the shortcut works again once the modal closes');

	// ---------- B5: Sessions save/rename are inline, no prompt ----------
	let promptCalls = 0;
	A.page.on('dialog', async (d) => {
		promptCalls++;
		await d.dismiss();
	});
	await A.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await A.page.waitForTimeout(500);
	await A.page.evaluate(() => document.querySelector('#session-save')?.click());
	await A.page.waitForTimeout(300);
	const nameInput = await A.page.evaluate(() => {
		const el = document.querySelector('#session-save-name');
		return el ? { visible: true, value: el.value, focused: document.activeElement === el } : null;
	});
	h.check(!!nameInput, 'Save current scene reveals an inline name input');
	h.check(nameInput?.focused === true, 'the input takes focus');
	h.check(/^Session /.test(nameInput?.value ?? ''), `prefilled with a default name ("${nameInput?.value}")`);
	await A.page.fill('#session-save-name', 'B5 inline session');
	await A.page.evaluate(() => document.querySelector('#session-save-confirm')?.click());
	await h.eventually(
		() =>
			A.page.evaluate(
				() => new Promise((r) => window.__stores.sessions.sessions.subscribe((s) => r(s.map((m) => m.name)))())
			),
		(names) => names.includes('B5 inline session'),
		'the named session is saved'
	);
	h.check(promptCalls === 0, `no window.prompt was used (${promptCalls})`);
	await A.page.evaluate(() => window.__stores.sessionsOpen.set(false));

	// ---------- B4: chevron badge counts drawer-only toasts ----------
	const badge = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.toastsInDrawerOnly.set(true);
		w.connectDrawerOpen.set(false);
		w.toastStore.set(['one', 'two']);
		await new Promise((r) => setTimeout(r, 250));
		const closed = document.querySelector('[data-testid="connect-toast-badge"]')?.textContent?.trim() ?? null;
		w.connectDrawerOpen.set(true);
		await new Promise((r) => setTimeout(r, 250));
		const opened = document.querySelector('[data-testid="connect-toast-badge"]');
		w.connectDrawerOpen.set(false);
		w.toastsInDrawerOnly.set(false);
		w.toastStore.set([]);
		await new Promise((r) => setTimeout(r, 250));
		const routedNormally = document.querySelector('[data-testid="connect-toast-badge"]');
		return { closed, hiddenWhenOpen: !opened, hiddenWhenRoutedNormally: !routedNormally };
	});
	h.check(badge.closed === '2', `closed drawer badges the held toasts (${badge.closed})`);
	h.check(badge.hiddenWhenOpen, 'badge hides once the drawer is open');
	h.check(badge.hiddenWhenRoutedNormally, 'badge hides when toasts show in the viewport');

	// ---------- B7: dragWindow resize persists ----------
	const resized = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.whatsNew.openWhatsNew();
		await new Promise((r) => setTimeout(r, 400));
		const win = document.querySelector('#whats-new-window');
		const grab = win?.querySelector('.dw-resize');
		if (!win || !grab) return null;
		const before = { w: win.offsetWidth, h: win.offsetHeight };
		const r0 = grab.getBoundingClientRect();
		const opts = { bubbles: true, pointerId: 1, clientX: r0.left + 4, clientY: r0.top + 4 };
		grab.dispatchEvent(new PointerEvent('pointerdown', opts));
		grab.dispatchEvent(
			new PointerEvent('pointermove', { ...opts, clientX: r0.left + 84, clientY: r0.top + 64, movementX: 80, movementY: 60 })
		);
		grab.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: r0.left + 84, clientY: r0.top + 64 }));
		await new Promise((r) => setTimeout(r, 150));
		const after = { w: win.offsetWidth, h: win.offsetHeight };
		const stored = JSON.parse(localStorage.getItem('win:whatsNewWin') ?? '{}');
		w.whatsNew.closeWhatsNew();
		return { before, after, stored };
	});
	h.check(!!resized, 'the What’s New window renders a resize grabber');
	h.check(
		resized.after.w > resized.before.w && resized.after.h > resized.before.h,
		`dragging the corner resizes it (${resized.before.w}x${resized.before.h} -> ${resized.after.w}x${resized.after.h})`
	);
	h.check(
		typeof resized.stored.w === 'number' && typeof resized.stored.h === 'number',
		`the size persists in win:<key> (${JSON.stringify(resized.stored)})`
	);

	// reopening restores the persisted size (the reveal clamp keeps it on-screen)
	const restored = await A.page.evaluate(async () => {
		window.__stores.whatsNew.openWhatsNew();
		await new Promise((r) => setTimeout(r, 400));
		const win = document.querySelector('#whats-new-window');
		const size = { w: win.offsetWidth, h: win.offsetHeight };
		window.__stores.whatsNew.closeWhatsNew();
		return size;
	});
	h.check(
		Math.abs(restored.w - resized.after.w) < 2 && Math.abs(restored.h - resized.after.h) < 2,
		`reopening restores the size (${restored.w}x${restored.h})`
	);

	await h.finish(browser);
});
