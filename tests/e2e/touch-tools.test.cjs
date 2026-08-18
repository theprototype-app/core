// #20 P4 — the touch-tools cluster, and mobile multi-select.
//
// The interesting claim is not that three buttons render. It is that ONE toggle covers
// both gestures a modifier covers on desktop — a tap ADDS, and a drag on empty space
// boxes — by feeding the same two `event.shiftKey` reads in Scene.svelte rather than
// growing a second selection implementation. So the checks drive real taps and a real
// drag, and compare against the Shift behaviour.
//
// Note on what CANNOT be tested here: `(pointer: coarse)` decides the DEFAULT, and a
// desktop context cannot report coarse — but a context created with
// `{ hasTouch: true, isMobile: true }` can, which is the documented way to reach it.
const h = require('./helpers.cjs');

const SELECTION = () => {
	let set;
	window.__stores.selectedObjects.subscribe((v) => (set = v))();
	return set.slice();
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the cluster is OFF by default on a plain desktop context ------------
	const desktopDefault = await A.page.evaluate(() => {
		let on;
		window.__stores.touchTools.subscribe((v) => (on = v))();
		return { on, present: !!document.querySelector('#touch-tools') };
	});
	h.check(
		desktopDefault.on === false && !desktopDefault.present,
		`a desktop window gets no cluster (on=${desktopDefault.on}, present=${desktopDefault.present})`
	);

	// ---- 2. turning it on renders the three buttons -----------------------------
	await A.page.evaluate(() => window.__stores.touchTools.set(true));
	await A.page.waitForTimeout(400);
	const shown = await A.page.evaluate(() => ({
		root: !!document.querySelector('#touch-tools'),
		undo: !!document.querySelector('#touch-undo'),
		redo: !!document.querySelector('#touch-redo'),
		multi: !!document.querySelector('#touch-multiselect'),
		// an icon-only button needs a name, or it is unusable with a screen reader
		labels: [...document.querySelectorAll('#touch-tools button')].map((b) =>
			b.getAttribute('aria-label')
		)
	}));
	h.check(
		shown.root && shown.undo && shown.redo && shown.multi,
		`the cluster renders Undo, Redo and Multi-select (${JSON.stringify(shown)})`
	);
	h.check(
		shown.labels.every((l) => !!l),
		`every icon button is labelled (${JSON.stringify(shown.labels)})`
	);

	// ---- 3. Undo/Redo drive the REAL history ------------------------------------
	const box = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		return { uuid: g.children[g.children.length - 1].uuid, count: g.children.length };
	});
	h.check(!!box.uuid, 'a box exists to undo (premise)');

	// the button must be ENABLED now — a disabled button would swallow the click and
	// the check below would read as a broken feature
	const enabled = await A.page.evaluate(() => !document.querySelector('#touch-undo').disabled);
	h.check(enabled, 'Undo is enabled once there is something to undo (premise)');

	await A.page.locator('#touch-undo').click();
	await A.page.waitForTimeout(600);
	const afterUndo = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	h.check(afterUndo === box.count - 1, `the Undo button removed the box (${box.count} -> ${afterUndo})`);

	await A.page.locator('#touch-redo').click();
	await A.page.waitForTimeout(600);
	const afterRedo = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	h.check(afterRedo === box.count, `and Redo brought it back (${afterRedo})`);

	// ---- 4. Multi-select makes a TAP additive ----------------------------------
	const two = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 700));
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 700));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const a = g.children[g.children.length - 2];
		const b = g.children[g.children.length - 1];
		a.position.set(-2, 0.5, 0);
		b.position.set(2, 0.5, 0);
		w.objectsGroup.update((v) => v);
		w.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 400));
		return { a: a.uuid, b: b.uuid, aPos: a.position.toArray(), bPos: b.position.toArray() };
	});

	const pa = await h.projectPoint(A.page, two.aPos);
	const pb = await h.projectPoint(A.page, two.bPos);

	// mode OFF: the second tap REPLACES
	await A.page.evaluate(() => window.__stores.multiSelectMode.set(false));
	await A.page.mouse.click(pa.x, pa.y);
	await A.page.waitForTimeout(350);
	await A.page.mouse.click(pb.x, pb.y);
	await A.page.waitForTimeout(350);
	const replaced = await A.page.evaluate(SELECTION);
	h.check(
		replaced.length === 1 && replaced[0] === two.b,
		`with the mode off a second tap replaces (${replaced.length} selected)`
	);

	// mode ON: the second tap ADDS
	await A.page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.multiSelectMode.set(true);
	});
	await A.page.waitForTimeout(300);
	await A.page.mouse.click(pa.x, pa.y);
	await A.page.waitForTimeout(350);
	await A.page.mouse.click(pb.x, pb.y);
	await A.page.waitForTimeout(400);
	const added = await A.page.evaluate(SELECTION);
	h.check(
		added.length === 2 && added.includes(two.a) && added.includes(two.b),
		`with the mode on two taps select both (${added.length} selected)`
	);

	// ---- 5. ...and a tap on NOTHING must not wipe the set it is building --------
	// This is the half a naive implementation gets wrong: the "click the background to
	// deselect" path is gated on the same flag, or every near-miss undoes the work.
	const emptySpot = await A.page.evaluate(() => {
		const canvas = document.querySelector('canvas');
		const r = canvas.getBoundingClientRect();
		return { x: Math.round(r.x + r.width * 0.5), y: Math.round(r.y + r.height * 0.12) };
	});
	await A.page.mouse.click(emptySpot.x, emptySpot.y);
	await A.page.waitForTimeout(450);
	const survived = await A.page.evaluate(SELECTION);
	h.check(
		survived.length === 2,
		`a tap on empty space keeps the set while the mode is on (${survived.length} left)`
	);

	// with the mode OFF the same tap clears, which is the behaviour it must not break
	await A.page.evaluate(() => window.__stores.multiSelectMode.set(false));
	await A.page.mouse.click(emptySpot.x, emptySpot.y);
	await A.page.waitForTimeout(450);
	const cleared = await A.page.evaluate(SELECTION);
	h.check(cleared.length === 0, `and clears it with the mode off (${cleared.length} left)`);

	// ---- 6. a drag on empty space BOXES, without Shift --------------------------
	const boxed = await A.page.evaluate(async () => {
		window.__stores.multiSelectMode.set(true);
		await new Promise((r) => setTimeout(r, 250));
		return true;
	});
	h.check(boxed, 'multi-select re-armed for the marquee (premise)');
	// sweep a rectangle that contains both boxes
	const left = Math.min(pa.x, pb.x) - 80;
	const right = Math.max(pa.x, pb.x) + 80;
	const top = Math.min(pa.y, pb.y) - 90;
	const bottom = Math.max(pa.y, pb.y) + 90;
	await A.page.mouse.move(left, top);
	await A.page.mouse.down();
	for (let i = 1; i <= 6; i++)
		await A.page.mouse.move(left + ((right - left) * i) / 6, top + ((bottom - top) * i) / 6, { steps: 2 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(600);
	const marquee = await A.page.evaluate(SELECTION);
	h.check(
		marquee.length >= 2 && marquee.includes(two.a) && marquee.includes(two.b),
		`a drag on empty space box-selected both, with no Shift held (${marquee.length} selected)`
	);

	// ---- 7. the mode is SESSION-only ------------------------------------------
	// A selection mode that survived a reload would silently change what the next tap
	// does, so it is deliberately not persisted (the cluster's own on/off IS).
	await h.freshReload(A);
	const afterReload = await A.page.evaluate(() => {
		let mode, tools;
		window.__stores.multiSelectMode.subscribe((v) => (mode = v))();
		window.__stores.touchTools.subscribe((v) => (tools = v))();
		return { mode, tools };
	});
	h.check(afterReload.mode === false, `multi-select does not survive a reload (${afterReload.mode})`);
	h.check(afterReload.tools === true, `the cluster's own setting does (${afterReload.tools})`);

	// ---- 8. the DEFAULT on a phone-shaped context ------------------------------
	// A desktop context cannot report `(pointer: coarse)`; one built with hasTouch +
	// isMobile can, and that is what decides the default.
	const phone = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		deviceScaleFactor: 2.7,
		ignoreHTTPSErrors: true
	});
	const P = await phone.newPage();
	await P.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
	});
	await P.goto(h.URL, { waitUntil: 'domcontentloaded' });
	await P.waitForFunction(() => !!window.__stores?.moduleSDK, { timeout: 25000 });
	await P.waitForTimeout(1500);
	const onPhone = await P.evaluate(() => {
		let on;
		window.__stores.touchTools.subscribe((v) => (on = v))();
		return { on, coarse: matchMedia('(pointer: coarse)').matches, present: !!document.querySelector('#touch-tools') };
	});
	h.check(onPhone.coarse, `the phone context really reports a coarse pointer (premise: ${onPhone.coarse})`);
	h.check(
		onPhone.on === true && onPhone.present,
		`the cluster is ON by default there (on=${onPhone.on}, present=${onPhone.present})`
	);
	await phone.close();

	// ---- 9. Multi-select works on mesh ELEMENTS too -----------------------------
	// Reported by the user: the mode did nothing inside Edit Mesh. P4 wired it into the two
	// OBJECT selection paths and stopped, but the mesh editor reads its own additive flag
	// from the modifiers — so vertices, edges and faces ignored it entirely.
	const elements = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.children[g.children.length - 1];
		w.objectActions.applySelectionSet([object.uuid]);
		await new Promise((r) => setTimeout(r, 300));
		w.faceEdit.enterFaceEdit(object.uuid);
		await new Promise((r) => setTimeout(r, 600));
		let entered;
		w.faceEdit.faceEditObject.subscribe((v) => (entered = v))();
		return { entered: !!entered, uuid: object.uuid };
	});
	h.check(elements.entered, 'a face session opened for the element check (premise)');

	// Two REAL clicks on two different faces, no modifier held. The bug lives in
	// Scene.svelte's additive flag, so a store-level probe cannot see it: `pickFaceUnit`
	// takes no additive argument at all (the additive path is `toggleFaceSelection`), and
	// re-implementing that branch in the test would assert the test's own logic.
	const faceA = await h.projectPoint(A.page, [0, 0.5, 0]); // top
	const faceB = await h.projectPoint(A.page, [0, 0, 0.5]); // front

	const pickTwice = async (mode) => {
		await A.page.evaluate(async (on) => {
			const w = window.__stores;
			w.multiSelectMode.set(on);
			w.faceEdit.clearFaceSelection();
			await new Promise((r) => setTimeout(r, 250));
		}, mode);
		await A.page.mouse.click(faceA.x, faceA.y);
		await A.page.waitForTimeout(450);
		await A.page.mouse.click(faceB.x, faceB.y);
		await A.page.waitForTimeout(500);
		return A.page.evaluate(() => {
			let tris;
			window.__stores.faceEdit.faceEditSelectedTris.subscribe((v) => (tris = v))();
			return (tris ?? []).length;
		});
	};

	const withMode = await pickTwice(true);
	const withoutMode = await pickTwice(false);
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	h.check(
		withoutMode > 0,
		`a plain face click selects something at all (premise: ${withoutMode} tris)`
	);
	h.check(
		withMode > withoutMode,
		`with Multi-select on, two face clicks ADD instead of replacing (${withMode} tris vs ${withoutMode})`
	);

	// ---- 10. the cluster never covers the logo ---------------------------------
	// Reported by the user: with Connect docked the cluster landed on the logo, because the
	// docked `top` was written straight onto the element and overrode the stacked position.
	const layout = await A.page.evaluate(async () => {
		const w = window.__stores;
		const rect = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
		};
		const overlaps = (a, b) =>
			!!a && !!b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

		w.connectDocked.set(false);
		await new Promise((r) => setTimeout(r, 300));
		const wide = { logo: rect('#logo-menu'), tools: rect('#touch-tools') };
		w.connectDocked.set(true);
		w.connectBarHeight.set(56);
		await new Promise((r) => setTimeout(r, 400));
		const docked = { logo: rect('#logo-menu'), tools: rect('#touch-tools') };
		w.connectDocked.set(false);
		return {
			wideOverlap: overlaps(wide.logo, wide.tools),
			dockedOverlap: overlaps(docked.logo, docked.tools),
			// stacked = a COLUMN below the logo, so it is taller than it is wide
			dockedStacked: !!docked.tools && docked.tools.h > docked.tools.w,
			dockedBelow: !!docked.tools && !!docked.logo && docked.tools.y >= docked.logo.bottom,
			wideBeside: !!wide.tools && !!wide.logo && wide.tools.x >= wide.logo.right
		};
	});
	h.check(!layout.wideOverlap, 'with room, the cluster sits beside the logo and does not overlap it');
	h.check(layout.wideBeside, 'and is genuinely to its right');
	h.check(
		!layout.dockedOverlap,
		'with Connect docked it still does not overlap the logo (the reported bug)'
	);
	h.check(layout.dockedBelow, 'it drops BELOW the logo instead');
	h.check(layout.dockedStacked, 'stacked vertically, not as a row');

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});
