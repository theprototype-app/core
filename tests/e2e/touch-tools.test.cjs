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
	// NOT "docked means stacked" any more: docking is no longer the trigger, a measured
	// collision is — and a docked Connect bar sits entirely ABOVE the logo, so the row
	// beside the logo is free. What matters here is only that it never covers the logo.
	h.check(
		layout.dockedBelow || layout.wideBeside,
		"docked, it is either beside the logo or below it — never on top of it"
	);

	// ---- 11. BOX SELECT for mesh elements ---------------------------------------
	// The gap behind the second report: a Shift/Ctrl drag has always marquee-selected
	// OBJECTS, and inside a mesh session there was no drag-select of ANY kind — several
	// elements could only be picked one click at a time. The object marquee deliberately
	// excludes a session, so this is its own branch and its own selector.
	const boxSetup = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 2 2 2');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.children[g.children.length - 1];
		object.position.set(0, 1, 0);
		w.objectsGroup.update((v) => v);
		w.objectActions.applySelectionSet([object.uuid]);
		await new Promise((r) => setTimeout(r, 300));
		w.faceEdit.enterFaceEdit(object.uuid);
		await new Promise((r) => setTimeout(r, 700));
		w.faceEdit.clearFaceSelection();
		w.multiSelectMode.set(false);
		await new Promise((r) => setTimeout(r, 300));
		let entered, tris;
		w.faceEdit.faceEditObject.subscribe((v) => (entered = v))();
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (tris = v))();
		return { entered: !!entered, uuid: object.uuid, picked: (tris ?? []).length };
	});
	h.check(boxSetup.entered && boxSetup.picked === 0,
		`a face session on a 2m box with nothing picked (premise: ${boxSetup.picked})`);

	// sweep a Shift-drag across the whole box: several faces must come in at once
	const centre = await h.projectPoint(A.page, [0, 1, 0]);
	await A.page.keyboard.down("Shift");
	await A.page.mouse.move(centre.x - 130, centre.y - 130);
	await A.page.mouse.down();
	for (let i = 1; i <= 8; i++)
		await A.page.mouse.move(centre.x - 130 + (260 * i) / 8, centre.y - 130 + (260 * i) / 8, { steps: 2 });
	await A.page.mouse.up();
	await A.page.keyboard.up("Shift");
	await A.page.waitForTimeout(600);
	const boxed2 = await A.page.evaluate(() => {
		let tris;
		window.__stores.faceEdit.faceEditSelectedTris.subscribe((v) => (tris = v))();
		return (tris ?? []).length;
	});
	h.check(boxed2 > 2, `a Shift-drag box selected several FACES at once (${boxed2} tris)`);
	// and whole pick UNITS, never half a quad — a box goes through the same resolver a
	// click does, so an odd count would mean it took half of one
	h.check(boxed2 % 2 === 0, `in whole quads, not half of one (${boxed2} tris)`);

	// the same gesture in VERTEX mode, which is a different module and a different pick
	const vertBox = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		await new Promise((r) => setTimeout(r, 400));
		w.objectActions.applySelectionSet([uuid]);
		w.meshEdit.enterEditMode(uuid);
		await new Promise((r) => setTimeout(r, 700));
		let editing, size;
		w.meshEdit.editingObject.subscribe((v) => (editing = v))();
		w.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
		return { editing: !!editing, before: size };
	}, boxSetup.uuid);
	h.check(vertBox.editing, `vertex mode opened (premise: ${vertBox.before} picked)`);

	await A.page.keyboard.down("Shift");
	await A.page.mouse.move(centre.x - 130, centre.y - 130);
	await A.page.mouse.down();
	for (let i = 1; i <= 8; i++)
		await A.page.mouse.move(centre.x - 130 + (260 * i) / 8, centre.y - 130 + (260 * i) / 8, { steps: 2 });
	await A.page.mouse.up();
	await A.page.keyboard.up("Shift");
	await A.page.waitForTimeout(600);
	const vertAfter = await A.page.evaluate(() => {
		let size;
		window.__stores.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
		window.__stores.meshEdit.exitEditMode();
		return size;
	});
	h.check(vertAfter > 1, `and box-selected several VERTICES (${vertAfter})`);

	// ---- 12. the stack is MEASURED, and aligns with the bottom-left HUD ---------
	// A width breakpoint stacked on an unfolded phone that had room to spare, so the
	// decision is a measurement now. And when it does stack, its button CENTRES line up
	// with the bottom-left cluster (44px at a 16px inset vs these 48px).
	const placement = await A.page.evaluate(async () => {
		const w = window.__stores;
		const read = () => {
			const el = document.querySelector('#touch-tools');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height, centre: r.x + 24 };
		};
		w.connectDocked.set(false);
		await new Promise((r) => setTimeout(r, 400));
		return { wide: read() };
	});
	h.check(
		!!placement.wide && placement.wide.w > placement.wide.h,
		`with room on a 1280px window it stays a ROW (${JSON.stringify(placement.wide)})`
	);

	// shrink the window until there is genuinely no room, and check it stacks + aligns
	await A.page.setViewportSize({ width: 420, height: 800 });
	await A.page.waitForTimeout(700);
	const narrow = await A.page.evaluate(() => {
		const tools = document.querySelector('#touch-tools')?.getBoundingClientRect();
		const logo = document.querySelector('#logo-menu')?.getBoundingClientRect();
		return tools && logo
			? {
					stacked: tools.height > tools.width,
					belowLogo: tools.y >= logo.bottom,
					// centres of a 48px button at this inset vs the 44px HUD button at 16px
					centre: tools.x + 24,
					hudCentre: 16 + 22
				}
			: null;
	});
	h.check(!!narrow?.stacked, `with no room it stacks vertically (${JSON.stringify(narrow)})`);
	h.check(!!narrow?.belowLogo, "below the logo, not over it");
	h.check(
		!!narrow && Math.abs(narrow.centre - narrow.hudCentre) <= 1,
		`and its centres line up with the bottom-left HUD (${narrow?.centre} vs ${narrow?.hudCentre})`
	);
	await A.page.setViewportSize({ width: 1280, height: 720 });
	await A.page.waitForTimeout(500);

	// ---- 13. a boxed FACE selection seats the GIZMO ----------------------------
	// Reported: multi-select showed no gizmo in faces while it did in vertices. The click
	// path seats it explicitly and the box path never did; vertices got one for free
	// because their own `setAnchor` seats it. Move is the default armed op, so a boxed
	// selection should come up ready to drag.
	const gizmo = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.objectActions.applySelectionSet([uuid]);
		w.faceEdit.enterFaceEdit(uuid);
		await new Promise((r) => setTimeout(r, 700));
		w.faceEdit.setFaceSubmode('faces');
		w.faceEdit.clearFaceSelection();
		await new Promise((r) => setTimeout(r, 400));
		let op, controls;
		w.faceEdit.faceEditOp.subscribe((v) => (op = v))();
		w.TControls.subscribe((v) => (controls = v))();
		return { op, attachedBefore: !!controls?.object };
	}, boxSetup.uuid);
	h.check(gizmo.op === 'move', `Move is the armed op, so a gizmo is expected (premise: ${gizmo.op})`);

	await A.page.keyboard.down("Shift");
	await A.page.mouse.move(centre.x - 130, centre.y - 130);
	await A.page.mouse.down();
	for (let i = 1; i <= 8; i++)
		await A.page.mouse.move(centre.x - 130 + (260 * i) / 8, centre.y - 130 + (260 * i) / 8, { steps: 2 });
	await A.page.mouse.up();
	await A.page.keyboard.up("Shift");
	await A.page.waitForTimeout(700);
	const seated = await A.page.evaluate(() => {
		const w = window.__stores;
		let controls, tris;
		w.TControls.subscribe((v) => (controls = v))();
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (tris = v))();
		return { attached: !!controls?.object, picked: (tris ?? []).length };
	});
	h.check(seated.picked > 2, `the box picked several faces (premise: ${seated.picked} tris)`);
	h.check(seated.attached, `and the gizmo is seated on them (${JSON.stringify(seated)})`);

	// ---- 14. EDGES box-select too -----------------------------------------------
	// Reported as "for edges multiselect does not work". Ctrl-clicking edges was fine; the
	// BOX returned zero, because `edgeKey` takes two welded VERTEX KEYS and it was being
	// handed two positions, so every key it built matched nothing in the real-edge map.
	const edgeBox = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.setFaceSubmode('edges');
		await new Promise((r) => setTimeout(r, 500));
		w.faceEdit.clearEdgeSelection();
		await new Promise((r) => setTimeout(r, 300));
		let sel, sub;
		w.faceEdit.edgeEditSelected.subscribe((v) => (sel = v))();
		w.faceEdit.faceEditSubmode.subscribe((v) => (sub = v))();
		return { sub, before: (sel ?? []).length };
	});
	h.check(edgeBox.sub === 'edges' && edgeBox.before === 0,
		`edge mode with nothing picked (premise: ${JSON.stringify(edgeBox)})`);

	await A.page.keyboard.down("Shift");
	await A.page.mouse.move(centre.x - 130, centre.y - 130);
	await A.page.mouse.down();
	for (let i = 1; i <= 8; i++)
		await A.page.mouse.move(centre.x - 130 + (260 * i) / 8, centre.y - 130 + (260 * i) / 8, { steps: 2 });
	await A.page.mouse.up();
	await A.page.keyboard.up("Shift");
	await A.page.waitForTimeout(700);
	const edgesPicked = await A.page.evaluate(() => {
		let sel;
		window.__stores.faceEdit.edgeEditSelected.subscribe((v) => (sel = v))();
		window.__stores.faceEdit.exitFaceEdit();
		return (sel ?? []).length;
	});
	h.check(edgesPicked > 1, `a box in EDGE mode selected several edges (${edgesPicked})`);

	// ---- 15. the settings DESCRIPTION flows as prose ----------------------------
	// Reported twice as "too many carriage returns". `.sr-desc` is a flex COLUMN (it
	// centres the text vertically), and in a flex container every ELEMENT child becomes
	// its own flex item on its own line — so any description mixing inline markup came
	// out one fragment per line ("Round / Undo / , / Redo / and / Multi-select / …").
	// A single block wrapper gives the cell ONE flex item and the inline content flows.
	// This is a SettingRow bug, not a copy problem: every row with markup had it.
	const desc = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.settingsSection.set('interface'); // rows only render inside an EXPANDED accordion
		w.settingsOpen.set(true);
		await new Promise((r) => setTimeout(r, 1800));
		const rows = [...document.querySelectorAll('.setting-row')];
		const row = rows.find((r) => r.textContent.includes('Touch tools'));
		if (!row) return { found: false, rows: rows.length };
		const body = row.querySelector('.sr-desc-body');
		if (!body) return { found: true, wrapper: false };
		const rect = body.getBoundingClientRect();
		const lh = parseFloat(getComputedStyle(body).lineHeight) || 16;
		// how many INLINE fragments the description is built from — the count that used to
		// become the line count
		const fragments = body.querySelectorAll("strong, kbd, em, code").length;
		w.settingsOpen.set(false);
		return {
			found: true,
			wrapper: true,
			items: body.parentElement.childElementCount,
			lines: Math.round(rect.height / lh),
			width: Math.round(rect.width),
			fragments
		};
	});
	h.check(desc.found && desc.wrapper, `the description is wrapped in one block (${JSON.stringify(desc)})`);
	h.check(desc.items === 1, `so the flex cell has exactly ONE item (${desc.items})`);
	h.check(desc.fragments >= 2, `and the row really does mix inline markup (premise: ${desc.fragments})`);
	h.check(
		desc.lines <= 4,
		`it wraps as prose, not one fragment per line (${desc.lines} lines at ${desc.width}px)`
	);

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});
