// A2 (roadmap #21) — HUD documents: the single write path, the normalize rules, the
// monotonic stamp, the render layer, and the z-tier it lives in.
//
// The design copies shaderGraph.js on purpose, so the checks that matter are the ones
// that copied bug-for-bug WOULD have broken: the monotonic stamp (a fast gesture writes
// several times inside one millisecond and a bare Date.now() makes a latest-wins guard
// drop all but the first) and preserve-unknown (a newer peer's element must survive a
// round trip through our editor).
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-core
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ---- 1. a fresh document normalizes to one screen ------------------------
	const fresh = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const doc = H.setHudDocFor('scene', {});
		return {
			screens: doc.screens.length,
			screenId: doc.screens[0].id,
			active: doc.active,
			stamped: doc.changedAt > 0
		};
	});
	h.check(fresh.screens === 1, `a document always normalizes to at least one screen (${fresh.screens})`);
	h.check(fresh.active === fresh.screenId, `and the active id points at a screen that exists (${fresh.active})`);
	h.check(fresh.stamped, 'and it carries a changedAt stamp');

	// ---- 2. element CRUD through the single write path -----------------------
	const crud = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const screen = H.hudDocOf('scene').screens[0].id;
		const a = H.addHudElement('scene', screen, { kind: 'text', label: 'Gems: 0', anchor: 'top-right', x: 24, y: 24 });
		const b = H.addHudElement('scene', screen, { kind: 'button', label: 'Start', anchor: 'center' });
		H.updateHudElement('scene', screen, a.id, { label: 'Gems: 7', x: 40 });
		const after = H.hudDocOf('scene').screens[0].elements;
		H.removeHudElements('scene', screen, [b.id]);
		const pruned = H.hudDocOf('scene').screens[0].elements;
		return {
			ids: [a.id, b.id],
			unique: a.id !== b.id,
			count: after.length,
			label: after.find((el) => el.id === a.id)?.label,
			x: after.find((el) => el.id === a.id)?.x,
			afterRemove: pruned.length,
			// defaults filled in by normalize
			w: after[0].w,
			h: after[0].h,
			anchor: after.find((el) => el.id === a.id)?.anchor
		};
	});
	h.check(crud.unique, `two elements added in the same millisecond get distinct ids (${crud.ids.join(', ')})`);
	h.check(crud.count === 2, `both land in the screen (${crud.count})`);
	h.check(crud.label === 'Gems: 7' && crud.x === 40, `an update patches only what it names (${crud.label}, x=${crud.x})`);
	h.check(crud.afterRemove === 1, `remove drops just the named element (${crud.afterRemove})`);
	h.check(crud.w > 0 && crud.h > 0, `normalize fills in a size (${crud.w}x${crud.h})`);
	h.check(crud.anchor === 'top-right', `and keeps the authored anchor (${crud.anchor})`);

	// ---- 3. normalize: an UNKNOWN kind and an unknown FIELD both survive -----
	// The scenePost / normalizeAnnotation rule. A newer peer's element must ride through
	// our editor untouched, because deleting it is silent data loss.
	const unknown = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const screen = H.hudDocOf('scene').screens[0].id;
		const doc = H.hudDocOf('scene');
		// craft a document the way a NEWER peer would send one
		H.setHudDocFor('scene', {
			...doc,
			screens: doc.screens.map((s) =>
				s.id === screen
					? {
							...s,
							futureField: 'from a newer build',
							elements: [
								...s.elements,
								{ id: 'future-1', kind: 'minimap', label: 'Map', someNewProp: 42, anchor: 'bottom-left' }
							]
						}
					: s
			)
		});
		const back = H.hudDocOf('scene');
		const el = back.screens[0].elements.find((e) => e.id === 'future-1');
		return {
			kept: !!el,
			kind: el?.kind,
			extraProp: el?.someNewProp,
			screenExtra: back.screens[0].futureField,
			// a bad anchor is CLAMPED (a rendering decision), unlike a kind
			clampedAnchor: H.normalizeHudElement({ anchor: 'nowhere' }).anchor,
			renderable: window.__stores.hudDocs.HUD_KINDS.includes('minimap')
		};
	});
	h.check(unknown.kept, 'an element of an UNKNOWN kind is preserved verbatim, never deleted');
	h.check(unknown.kind === 'minimap', `its kind is kept as authored (${unknown.kind})`);
	h.check(unknown.extraProp === 42, `and so is a property we have never heard of (${unknown.extraProp})`);
	h.check(unknown.screenExtra === 'from a newer build', 'a spread preserves unknown SCREEN fields too');
	h.check(!unknown.renderable, 'it is not in HUD_KINDS, so the layer skips it at RENDER — a rendering decision');
	h.check(unknown.clampedAnchor === 'top-left', `an invalid anchor IS clamped (${unknown.clampedAnchor})`);

	// ---- 4. THE MONOTONIC STAMP -------------------------------------------
	// The measured shader bug: several writes inside one millisecond share a bare
	// Date.now(), and the receiver's latest-wins guard then drops every one after the
	// first — so a drag AND the undo after it silently fail to replicate.
	const stamps = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const screen = H.hudDocOf('scene').screens[0].id;
		const el = H.hudDocOf('scene').screens[0].elements[0].id;
		const out = [];
		// a tight loop is exactly a pointermove burst
		for (let i = 0; i < 25; i++) {
			H.updateHudElement('scene', screen, el, { x: 10 + i });
			out.push(H.hudDocOf('scene').changedAt);
		}
		let strictlyIncreasing = true;
		for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) strictlyIncreasing = false;
		return { strictlyIncreasing, first: out[0], last: out[out.length - 1], span: out.length };
	});
	h.check(
		stamps.strictlyIncreasing,
		`${stamps.span} writes in a burst all get STRICTLY increasing stamps (${stamps.first} -> ${stamps.last})`
	);

	// ---- 5. the LAYER renders, at --z-hud, click-through ---------------------
	const layer = await page.evaluate(() => {
		const el = document.querySelector('#hud-layer');
		if (!el) return { present: false };
		const cs = getComputedStyle(el);
		const hudVar = getComputedStyle(document.documentElement).getPropertyValue('--z-hud').trim();
		const slots = [...el.querySelectorAll('.hud-slot')].map((s) => s.getAttribute('data-hud-kind'));
		return {
			present: true,
			position: cs.position,
			pointerEvents: cs.pointerEvents,
			zIndex: cs.zIndex,
			hudVar,
			slots
		};
	});
	h.check(layer.present, 'the HUD layer is mounted');
	h.check(layer.position === 'fixed', `it is fixed (${layer.position})`);
	h.check(
		layer.pointerEvents === 'none',
		`and pointer-events: none, so the viewport keeps every click (${layer.pointerEvents})`
	);
	h.check(
		layer.zIndex === layer.hudVar && layer.hudVar === '45',
		`it lives at --z-hud with NO new tier (z=${layer.zIndex}, --z-hud=${layer.hudVar})`
	);
	h.check(
		layer.slots.includes('text') && !layer.slots.includes('minimap'),
		`known kinds render and the unknown one is skipped (${JSON.stringify(layer.slots)})`
	);

	// a BUTTON opts back into pointer events, and nothing else does
	const clickThrough = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const screen = H.hudDocOf('scene').screens[0].id;
		const btn = H.addHudElement('scene', screen, {
			kind: 'button',
			label: 'Press',
			anchor: 'top-left',
			x: 400,
			y: 300,
			w: 120,
			h: 36
		});
		return btn.id;
	});
	await page.waitForTimeout(500);
	const pe = await page.evaluate((id) => {
		const slot = document.querySelector(`[data-hud-id="${id}"]`);
		const btn = slot?.querySelector('button');
		const text = document.querySelector('[data-hud-kind="text"] .hud-el');
		const r = btn?.getBoundingClientRect();
		return {
			buttonPE: btn ? getComputedStyle(btn).pointerEvents : null,
			textPE: text ? getComputedStyle(text).pointerEvents : null,
			// the real test of click-through: what does the browser say is under a
			// NON-button HUD pixel?
			atButton: r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName : null
		};
	}, clickThrough);
	h.check(pe.buttonPE === 'auto', `a HUD button opts INTO pointer events (${pe.buttonPE})`);
	h.check(pe.atButton === 'BUTTON', `and is genuinely hittable (elementFromPoint = ${pe.atButton})`);

	// ---- 6. screens: per-peer visibility is LOCAL, `active` is authored ------
	const screensCheck = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const menu = H.addHudScreen('scene', 'Menu');
		const first = H.hudDocOf('scene').screens[0].id;
		H.addHudElement('scene', menu, { kind: 'text', label: 'MAIN MENU', anchor: 'center' });
		await new Promise((r) => setTimeout(r, 400));
		const beforeShow = [...document.querySelectorAll('.hud-slot')].length;
		// the LOCAL override — never replicated, so one player can sit on the menu while
		// another plays
		H.showHudScreen('scene', menu);
		await new Promise((r) => setTimeout(r, 400));
		const onMenu = [...document.querySelectorAll('.hud-slot .hud-el')].map((e) => e.textContent);
		const docActiveUnchanged = H.hudDocOf('scene').active === first;
		// the AUTHORED default is document data
		H.setActiveHudScreen('scene', menu);
		const docActiveNow = H.hudDocOf('scene').active;
		H.showHudScreen('scene', null); // fall back to the document's own active
		await new Promise((r) => setTimeout(r, 400));
		const afterFallback = [...document.querySelectorAll('.hud-slot .hud-el')].map((e) => e.textContent);
		return {
			menu,
			beforeShow,
			onMenu,
			docActiveUnchanged,
			docActiveNow,
			afterFallback,
			cannotRemoveLast: (() => {
				H.removeHudScreen('scene', menu);
				const one = H.hudDocOf('scene').screens.length;
				return H.removeHudScreen('scene', H.hudDocOf('scene').screens[0].id) === false && one === 1;
			})()
		};
	});
	h.check(
		screensCheck.onMenu.includes('MAIN MENU'),
		`showing a screen locally swaps what renders (${JSON.stringify(screensCheck.onMenu)})`
	);
	h.check(
		screensCheck.docActiveUnchanged,
		'a LOCAL show does not touch the document — screen visibility is per-peer on purpose'
	);
	h.check(screensCheck.docActiveNow === screensCheck.menu, 'setActiveHudScreen writes the AUTHORED default');
	h.check(
		screensCheck.afterFallback.includes('MAIN MENU'),
		`clearing the override falls back to the document's active (${JSON.stringify(screensCheck.afterFallback)})`
	);
	h.check(screensCheck.cannotRemoveLast, 'the last screen cannot be removed — a document always has one');

	// ---- 7. the 9-grid places by anchor + PIXEL offset -----------------------
	const grid = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', { screens: [{ id: 'g', name: 'g', elements: [] }], active: 'g' });
		H.showHudScreen('scene', 'g');
		const spec = [
			['top-left', 20, 30],
			['top-right', 20, 30],
			['bottom-left', 20, 30],
			['bottom-right', 20, 30],
			['center', 0, 0]
		];
		for (const [anchor, x, y] of spec)
			H.addHudElement('scene', 'g', { kind: 'text', label: anchor, anchor, x, y, w: 100, h: 20 });
		await new Promise((r) => setTimeout(r, 500));
		const out = {};
		for (const slot of document.querySelectorAll('.hud-slot')) {
			const r = slot.getBoundingClientRect();
			out[slot.querySelector('.hud-el')?.textContent ?? '?'] = {
				l: Math.round(r.left),
				t: Math.round(r.top),
				r: Math.round(window.innerWidth - r.right),
				b: Math.round(window.innerHeight - r.bottom)
			};
		}
		return { out, vw: window.innerWidth, vh: window.innerHeight };
	});
	h.check(
		grid.out['top-left']?.l === 20 && grid.out['top-left']?.t === 30,
		`top-left is offset from the top-left in PIXELS (${JSON.stringify(grid.out['top-left'])})`
	);
	h.check(
		grid.out['top-right']?.r === 20 && grid.out['top-right']?.t === 30,
		`top-right measures from the RIGHT edge (${JSON.stringify(grid.out['top-right'])})`
	);
	h.check(
		grid.out['bottom-right']?.r === 20 && grid.out['bottom-right']?.b === 30,
		`bottom-right measures from both far edges (${JSON.stringify(grid.out['bottom-right'])})`
	);
	h.check(
		Math.abs(grid.out['center']?.l + 50 - grid.vw / 2) <= 2,
		`center is genuinely centred, not offset by half its width (${JSON.stringify(grid.out['center'])}, vw=${grid.vw})`
	);

	// resizing must NOT stretch anything — the reason anchors are pixels, not fractions
	const beforeResize = grid.out['top-right'];
	await page.setViewportSize({ width: 900, height: 700 });
	await page.waitForTimeout(500);
	const afterResize = await page.evaluate(() => {
		const slot = [...document.querySelectorAll('.hud-slot')].find(
			(s) => s.querySelector('.hud-el')?.textContent === 'top-right'
		);
		const r = slot.getBoundingClientRect();
		return { w: Math.round(r.width), r: Math.round(window.innerWidth - r.right), t: Math.round(r.top) };
	});
	h.check(
		afterResize.w === 100 && afterResize.r === beforeResize.r && afterResize.t === beforeResize.t,
		`a viewport resize moves nothing and stretches nothing (${JSON.stringify(afterResize)})`
	);
	await page.setViewportSize({ width: 1280, height: 800 });

	// ---- 8. the HUD survives PLAY MODE (outside {#if !$isLocked}) -----------
	const play = await page.evaluate(async () => {
		const s = window.__stores;
		const before = !!document.querySelector('#hud-layer');
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 600));
		const during = !!document.querySelector('#hud-layer');
		const slots = document.querySelectorAll('#hud-layer .hud-slot').length;
		s.isLocked.set(false);
		await new Promise((r) => setTimeout(r, 400));
		return { before, during, slots };
	});
	h.check(play.before && play.during, 'the HUD renders in PLAY MODE — it is outside the editor-only block');
	h.check(play.slots > 0, `with its elements (${play.slots})`);

	// and NOT in VR: DOM is invisible in a headset
	const vr = await page.evaluate(async () => {
		const s = window.__stores;
		s.isVRMode.set(true);
		await new Promise((r) => setTimeout(r, 500));
		const inVr = !!document.querySelector('#hud-layer');
		s.isVRMode.set(false);
		await new Promise((r) => setTimeout(r, 400));
		return { inVr, back: !!document.querySelector('#hud-layer') };
	});
	h.check(!vr.inVr, 'and NOT in VR, where DOM is invisible — the in-scene path is a later phase');
	h.check(vr.back, 'coming back on exit');

	// ---- 9. delete + the history kind ---------------------------------------
	const undoable = await page.evaluate(async () => {
		const s = window.__stores;
		const H = s.hudDocs;
		const screen = H.hudDocOf('scene').screens[0].id;
		const el = H.addHudElement('scene', screen, { kind: 'text', label: 'undo me' });
		await new Promise((r) => setTimeout(r, 200));
		const added = H.hudDocOf('scene').screens[0].elements.length;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 300));
		const undone = H.hudDocOf('scene').screens[0].elements.length;
		s.history.redo();
		await new Promise((r) => setTimeout(r, 300));
		const redone = H.hudDocOf('scene').screens[0].elements.length;
		return { added, undone, redone, id: el.id };
	});
	h.check(
		undoable.undone === undoable.added - 1,
		`adding an element is ONE undo step (${undoable.added} -> ${undoable.undone})`
	);
	h.check(undoable.redone === undoable.added, `and redo puts it back (${undoable.redone})`);

	const deleted = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', null);
		await new Promise((r) => setTimeout(r, 400));
		return { doc: H.hudDocOf('scene'), layer: !!document.querySelector('#hud-layer') };
	});
	h.check(deleted.doc === null, 'setHudDocFor(key, null) deletes the document');
	h.check(!deleted.layer, 'and the layer renders nothing at all with no document');

	// ---- 10. the gesture collapses a drag to ONE entry and ONE message ------
	const gesture = await page.evaluate(async () => {
		const s = window.__stores;
		const H = s.hudDocs;
		const sent = [];
		const peer = await new Promise((r) => s.peers.subscribe((p) => r(p))());
		const real = peer.send.bind(peer);
		peer.send = (msg) => {
			if (msg?.type === 'hud' || msg?.type === 'huddelete') sent.push(msg.type);
			return real(msg);
		};
		H.setHudDocFor('scene', {});
		const screen = H.hudDocOf('scene').screens[0].id;
		const el = H.addHudElement('scene', screen, { kind: 'text', label: 'drag me' });
		await new Promise((r) => setTimeout(r, 200));
		const baseline = sent.length;
		const depthBefore = s.history.historyDepth ? s.history.historyDepth() : null;

		s.hudSync.beginHudGesture('scene');
		for (let i = 0; i < 20; i++) H.updateHudElement('scene', screen, el.id, { x: 100 + i * 3 });
		const duringGesture = sent.length - baseline;
		s.hudSync.endHudGesture('scene');
		await new Promise((r) => setTimeout(r, 300));
		const afterGesture = sent.length - baseline;
		const movedTo = H.hudDocOf('scene').screens[0].elements.find((e) => e.id === el.id).x;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 300));
		const afterUndo = H.hudDocOf('scene').screens[0].elements.find((e) => e.id === el.id)?.x;
		peer.send = real;
		return { duringGesture, afterGesture, movedTo, afterUndo, depthBefore };
	});
	h.check(
		gesture.duringGesture === 0,
		`20 writes inside a gesture broadcast NOTHING (${gesture.duringGesture})`
	);
	h.check(
		gesture.afterGesture === 1,
		`the gesture end is exactly ONE message (${gesture.afterGesture})`
	);
	h.check(gesture.movedTo === 157, `and the drag landed where it should (x=${gesture.movedTo})`);
	h.check(
		gesture.afterUndo !== gesture.movedTo,
		`ONE undo reverts the WHOLE drag (${gesture.movedTo} -> ${gesture.afterUndo})`
	);

	// ---- 11. the TEMPLATE own bug, found by copying it ----------------------
	// hudSync is deliberately shaderSync shape, and the first version copied its history
	// handler verbatim - including `state.present`, a flag that does not exist on a
	// document. `applyState` passes entry.before or entry.after AS `state`, so the
	// direction is an identity comparison; reading a missing flag made it always falsy, so
	// redo restored `before` and silently did nothing. Measured on release/next: a shader
	// graph went 2 nodes -> undo 1 -> redo 1. Both kinds are checked so neither regresses.
	const shaderRedo = await page.evaluate(async () => {
		const s = window.__stores;
		const SG = s.shaderGraph;
		SG.setShaderGraphFor('scene', { nodes: [{ id: 'n1', type: 'surface', data: {} }], edges: [] });
		await new Promise((r) => setTimeout(r, 300));
		SG.setShaderGraphFor('scene', {
			nodes: [
				{ id: 'n1', type: 'surface', data: {} },
				{ id: 'n2', type: 'colour', data: {} }
			],
			edges: []
		});
		await new Promise((r) => setTimeout(r, 300));
		const two = SG.shaderGraphOf('scene').nodes.length;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 400));
		const undone = SG.shaderGraphOf('scene')?.nodes.length ?? -1;
		s.history.redo();
		await new Promise((r) => setTimeout(r, 400));
		const redone = SG.shaderGraphOf('scene')?.nodes.length ?? -1;
		return { two, undone, redone };
	});
	h.check(
		shaderRedo.two === 2 && shaderRedo.undone === 1,
		`premise: a shader-graph undo works (2 -> ${shaderRedo.undone})`
	);
	h.check(
		shaderRedo.redone === 2,
		`and REDO restores the after state - the fixed template bug (${shaderRedo.redone})`
	);

	await h.finish(browser);
});
