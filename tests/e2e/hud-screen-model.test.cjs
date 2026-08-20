// 21-E2 — THE SCREEN MODEL: a nullable default, one doc-key resolution, and direct
// manipulation in the viewport.
//
// The counterfactuals, because every section here fixes something that was WRONG:
//
//   * `normalizeHudDoc` FORCED `active` onto an existing screen, so one screen always
//     rendered and "only when asked" was unimplementable for the document (E2.1). The
//     migration half matters just as much: a doc with NO `active` field must still behave
//     exactly as it did, or every saved scene changes on load.
//   * in an object graph the doc key was the OBJECT UUID, and almost no object has a HUD
//     document — so the picker enumerated nothing and `hudscreen` wrote an override for a
//     document that cannot exist. A cube's graph could not reach the HUD at all (E2.2).
//   * the picker's empty state was one disabled row: true, and useless (E2.3).
//   * you could not move a HUD element while looking at the scene it sits over (E2.4).
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-screen-model
const h = require('./helpers.cjs');

/** the HUD editor, opened the way the deep link does */
async function openEditor(page) {
	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1400);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ======================================================================
	// 1. E2.1 — a nullable default screen
	// ======================================================================
	// (a) AN OLD-SHAPED DOCUMENT, with no `active` field at all, must behave as it always
	// did. This is the migration rule, and it is the reason the opt-out is an explicit
	// empty string rather than "absent".
	const oldShape = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		H.clearHudDocs();
		const norm = H.normalizeHudDoc({
			screens: [
				{ id: 'menu', name: 'Menu', elements: [{ id: 'a', kind: 'text', label: 'MENU' }] },
				{ id: 'play', name: 'Play', elements: [{ id: 'b', kind: 'text', label: 'PLAY' }] }
			]
		});
		return { active: norm.active, hasField: 'active' in norm };
	});
	h.check(
		oldShape.active === 'menu',
		`an OLD doc with no \`active\` still resolves to its first screen (${JSON.stringify(oldShape)})`
	);

	// and it renders, exactly as before
	const oldRenders = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.hudPreviewInViewport.set(true);
		H.hudDocsRestore(
			{
				scene: {
					screens: [
						{ id: 'menu', name: 'Menu', elements: [{ id: 'a', kind: 'text', label: 'MENU' }] },
						{ id: 'play', name: 'Play', elements: [{ id: 'b', kind: 'text', label: 'PLAY' }] }
					]
				}
			},
			true
		);
		await new Promise((r) => setTimeout(r, 900));
		return {
			active: H.hudDocOf('scene').active,
			visible: H.visibleScreen('scene')?.id ?? null,
			painted: document.querySelectorAll('#hud-layer [data-hud-id]').length
		};
	});
	h.check(
		oldRenders.visible === 'menu' && oldRenders.painted === 1,
		`a RESTORED old-shape document paints its first screen (active=${oldRenders.active}, painted=${oldRenders.painted})`
	);

	// (b) an EXPLICITLY EMPTY active is the new state: nothing renders until asked
	const unstarred = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const doc = H.hudDocOf('scene');
		H.setHudDocFor('scene', { ...doc, active: '' });
		await new Promise((r) => setTimeout(r, 800));
		return {
			active: H.hudDocOf('scene').active,
			visible: H.visibleScreen('scene')?.id ?? null,
			layer: !!document.querySelector('#hud-layer'),
			painted: document.querySelectorAll('#hud-layer [data-hud-id]').length
		};
	});
	h.check(unstarred.active === '', `normalize PRESERVES an explicit empty active (${JSON.stringify(unstarred.active)})`);
	h.check(
		unstarred.visible === null && unstarred.painted === 0,
		`and nothing renders — "no default screen" is real now (visible=${unstarred.visible}, painted=${unstarred.painted})`
	);

	// ...until something asks. A per-peer request is exactly the mechanism a menu uses.
	const asked = await page.evaluate(async () => {
		window.__stores.hudDocs.showHudScreen('scene', 'play');
		await new Promise((r) => setTimeout(r, 700));
		return {
			visible: window.__stores.hudDocs.visibleScreen('scene')?.id ?? null,
			painted: [...document.querySelectorAll('#hud-layer [data-hud-id]')].map((e) => e.getAttribute('data-hud-id'))
		};
	});
	h.check(
		asked.visible === 'play' && asked.painted.length === 1,
		`asking for a screen still shows it (${asked.visible}, ${JSON.stringify(asked.painted)})`
	);
	await page.evaluate(() => window.__stores.hudDocs.showHudScreen('scene', null));
	await page.waitForTimeout(400);

	// (c) it survives the SAVE paths and the WIRE — the normalize-at-every-boundary rule
	const roundTrip = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const S = window.__stores.hudSync;
		const snap = JSON.parse(JSON.stringify(H.hudDocsSnapshot()));
		const savedActive = snap.scene.active;
		// a save/load round trip
		H.hudDocsRestore(snap, true);
		const afterRestore = H.hudDocOf('scene').active;
		// and the WIRE: the applier a peer runs, with a newer stamp so it is not refused
		S.applyRemoteHud({ key: 'scene', doc: { ...snap.scene, changedAt: Date.now() + 5000 } });
		return { savedActive, afterRestore, afterWire: H.hudDocOf('scene').active };
	});
	h.check(
		roundTrip.savedActive === '' && roundTrip.afterRestore === '' && roundTrip.afterWire === '',
		`the empty active survives snapshot, restore AND the wire (${JSON.stringify(roundTrip)})`
	);

	// (d) the ★ is a TOGGLE, through the real UI
	await openEditor(page);
	const starUi = await page.evaluate(() => {
		const stars = [...document.querySelectorAll('#hud-dock [data-hud-star]')];
		return {
			count: stars.length,
			pressed: stars.map((s) => s.getAttribute('aria-pressed')),
			ids: stars.map((s) => s.getAttribute('data-hud-star'))
		};
	});
	h.check(starUi.count >= 2, `premise: the editor lists both screens with a star each (${starUi.count})`);
	h.check(
		starUi.pressed.every((p) => p === 'false'),
		`with none starred, since the document has no default (${JSON.stringify(starUi.pressed)})`
	);
	await page.locator('#hud-dock [data-hud-star]').first().click();
	await page.waitForTimeout(600);
	const starred = await page.evaluate(() => window.__stores.hudDocs.hudDocOf('scene').active);
	h.check(!!starred, `clicking a star sets the default (${starred})`);
	await page.locator(`#hud-dock [data-hud-star="${starred}"]`).click();
	await page.waitForTimeout(600);
	const unstarredUi = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const active = H.hudDocOf('scene').active;
		// the editor pins the local override to the screen it is EDITING, and an override
		// outranks the default (step 1 of visibleScreen) — so close it before reading what a
		// viewer would see
		window.__stores.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 900));
		return { active, visible: H.visibleScreen('scene')?.id ?? null };
	});
	h.check(
		unstarredUi.active === '',
		`clicking the STARRED one un-stars it — the only way to say "no default" (active=${JSON.stringify(unstarredUi.active)})`
	);
	h.check(
		unstarredUi.visible === null,
		`and with the editor closed a viewer then sees NOTHING (${unstarredUi.visible})`
	);

	// ======================================================================
	// 2. E2.2 — one doc-key resolution, and the stranded object graph
	// ======================================================================
	const keys = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const s = window.__stores;
		// a real object with a real object graph, the case that stranded
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1400));
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		s.flowGraphsCtl.createObjectGraph(box.uuid);
		await new Promise((r) => setTimeout(r, 500));
		// a camera-shaped document: a key that DOES have a doc must still win
		H.setHudDocFor('cam-uuid-1', { screens: [{ id: 'hud', name: 'Cam', elements: [] }] });
		await new Promise((r) => setTimeout(r, 400));
		return {
			uuid: box.uuid,
			forObject: H.hudDocKeyFor(box.uuid),
			forScene: H.hudDocKeyFor('scene'),
			forEmpty: H.hudDocKeyFor(''),
			forCamera: H.hudDocKeyFor('cam-uuid-1'),
			// THE COUNTERFACTUAL, computed in-test: the OLD resolution was the graph id
			// itself, which enumerates nothing
			oldWay: H.elementChoices(box.uuid).length,
			newWay: H.elementChoices(H.hudDocKeyFor(box.uuid)).length
		};
	});
	h.check(
		keys.forObject === 'scene',
		`an OBJECT graph with no HUD of its own resolves to the scene HUD (${keys.forObject})`
	);
	h.check(keys.forScene === 'scene' && keys.forEmpty === 'scene', 'the scene graph and an empty id both answer scene');
	h.check(
		keys.forCamera === 'cam-uuid-1',
		`a key that HAS a document keeps it — a camera HUD stays reachable from its own graph (${keys.forCamera})`
	);
	h.check(
		keys.oldWay === 0 && keys.newWay > 0,
		`COUNTERFACTUAL: the old key enumerated ${keys.oldWay} elements, the shared helper finds ${keys.newWay}`
	);

	// and the RUNTIME half: a hudscreen node inside that object's graph switches the SCENE
	// screen. It used to write an override for a document that does not exist.
	const runtime = await page.evaluate(async (uuid) => {
		const s = window.__stores;
		const H = s.hudDocs;
		H.showHudScreen('scene', null);
		// the SOURCE lives in the same object graph: a trigger reaches a node through an
		// incoming edge (`triggerStampFor` walks the edges), never by stamping the node
		s.nodesHandler.createFlowNode(
			{ id: 'e2-press', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			uuid
		);
		s.nodesHandler.createFlowNode(
			{
				id: 'e2-screen',
				type: 'hudscreen',
				position: { x: 240, y: 0 },
				data: { type: 'hudscreen', screen: 'play', action: 'show' }
			},
			uuid
		);
		s.nodesHandler.createFlowEdge(
			{ id: 'e2-edge', source: 'e2-press', target: 'e2-screen', targetHandle: 'trigger' },
			uuid
		);
		await new Promise((r) => setTimeout(r, 900));
		const before = H.visibleScreen('scene')?.id ?? null;
		// a SECONDS-scale synced-clock stamp, the hud-nodes recipe
		s.flowRuntime.applyNodeTrigger('e2-press', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 1100));
		return { before, after: H.visibleScreen('scene')?.id ?? null };
	}, keys.uuid);
	h.check(runtime.before === null, `premise: nothing is showing before the pulse (${runtime.before})`);
	h.check(
		runtime.after === 'play',
		`a hudscreen node in an OBJECT graph reaches the SCENE HUD (${runtime.before} -> ${runtime.after})`
	);

	// the picker NAMES the document it enumerates, so "these are my object's screens" —
	// which they are not — cannot be read into it
	const header = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(true);
		s.flowGraphClose.set(false);
		s.bottomDock.activateDock('flow');
		await new Promise((r) => setTimeout(r, 1200));
		const field = document.querySelector('.hud-ep-field');
		if (!field) return { noField: true };
		field.click();
		await new Promise((r) => setTimeout(r, 700));
		const rows = [...document.querySelectorAll('[role="menu"] *')]
			.map((el) => (el.textContent ?? '').trim())
			.filter(Boolean);
		return { rows };
	});
	h.check(!header.noField, 'premise: the hudscreen node card shows its picker');
	h.check(
		!!header.rows && header.rows.some((r) => /Scene HUD/.test(r)),
		`the picker names the document it is enumerating (${JSON.stringify((header.rows ?? []).slice(0, 4))})`
	);

	// ======================================================================
	// 3. E2.3 — "New screen..." and "Open HUD editor" in the picker
	// ======================================================================
	const before = await page.evaluate(() => ({
		screens: window.__stores.hudDocs.hudDocOf('scene').screens.length,
		entries: window.__stores.history.historyLength?.() ?? null
	}));
	const madeScreen = await page.evaluate(async () => {
		const rows = [...document.querySelectorAll('[role="menu"] *')].filter((el) => el.children.length === 0);
		const row = rows.find((el) => /New screen/.test(el.textContent ?? ''));
		if (!row) return { missing: true, labels: rows.map((r) => (r.textContent ?? '').trim()) };
		row.click();
		await new Promise((r) => setTimeout(r, 900));
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		let nodes;
		window.__stores.flowGraphs.subscribe((g) => (nodes = g))();
		const graph = Object.values(nodes ?? {}).find((g) => g.nodes?.some((n) => n.id === 'e2-screen'));
		const node = graph?.nodes.find((n) => n.id === 'e2-screen');
		return {
			screens: doc.screens.length,
			last: doc.screens[doc.screens.length - 1],
			nodeScreen: node?.data?.screen ?? null
		};
	});
	h.check(!madeScreen.missing, `the picker offers "New screen..." (${JSON.stringify(madeScreen.labels ?? '')})`);
	h.check(
		madeScreen.screens === before.screens + 1,
		`it creates one (${before.screens} -> ${madeScreen.screens})`
	);
	h.check(
		!!madeScreen.last?.name,
		`with a default name, so no prompt is needed inside a context menu inside a node card (${madeScreen.last?.name})`
	);
	h.check(
		madeScreen.nodeScreen === madeScreen.last?.id,
		`and SELECTS it as the node's value (${madeScreen.nodeScreen})`
	);
	const undone = await page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 700));
		return window.__stores.hudDocs.hudDocOf('scene').screens.length;
	});
	h.check(
		undone === before.screens,
		`ONE undo removes the new screen — one entry for the whole thing (${madeScreen.screens} -> ${undone})`
	);

	// "Open HUD editor" — the openShaderEditor deep-link shape
	const deepLink = await page.evaluate(async () => {
		window.__stores.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 400));
		const field = document.querySelector('.hud-ep-field');
		field?.click();
		await new Promise((r) => setTimeout(r, 700));
		const row = [...document.querySelectorAll('[role="menu"] *')]
			.filter((el) => el.children.length === 0)
			.find((el) => /Open HUD editor/.test(el.textContent ?? ''));
		if (!row) return { missing: true };
		row.click();
		await new Promise((r) => setTimeout(r, 1500));
		let closed, dock;
		window.__stores.hudEditorClose.subscribe((v) => (closed = v))();
		window.__stores.bottomDock.visibleDockKey.subscribe((v) => (dock = v))();
		return { closed, dock, board: !!document.querySelector('#hud-board') };
	});
	h.check(!deepLink.missing, 'the picker offers "Open HUD editor"');
	h.check(
		deepLink.closed === false && deepLink.dock === 'hud' && deepLink.board,
		`and it really opens the tab (close=${deepLink.closed}, dock=${deepLink.dock}, board=${deepLink.board})`
	);

	// ======================================================================
	// 4. E2.4 — right-drag an element in the VIEWPORT
	// ======================================================================
	const setup = await page.evaluate(async () => {
		const s = window.__stores;
		const H = s.hudDocs;
		// the editor closed, the preview on, not playing: the state the gate describes
		s.hudEditorClose.set(true);
		s.flowGraphClose.set(true);
		s.isLocked.set(null);
		H.hudPreviewInViewport.set(true);
		H.clearHudDocs();
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'main',
					name: 'Main',
					elements: [
						{ id: 'drag-me', kind: 'panel', anchor: 'top-left', x: 300, y: 200, w: 180, h: 90 }
					]
				}
			],
			active: 'main'
		});
		await new Promise((r) => setTimeout(r, 1000));
		const slot = document.querySelector('#hud-layer [data-hud-id="drag-me"]');
		const r = slot?.getBoundingClientRect();
		return {
			allowed: s.hudViewportDrag.hudViewportDragAllowed(),
			rect: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null,
			// the layer is pointer-events: none, so hit testing CANNOT see the element —
			// which is why the gesture finds it by rect instead
			hitTest: document.elementFromPoint(
				Math.round((r?.x ?? 0) + (r?.width ?? 0) / 2),
				Math.round((r?.y ?? 0) + (r?.height ?? 0) / 2)
			)?.tagName,
			found: s.hudViewportDrag.hudElementAt(
				Math.round((r?.x ?? 0) + (r?.width ?? 0) / 2),
				Math.round((r?.y ?? 0) + (r?.height ?? 0) / 2)
			)
		};
	});
	h.check(setup.allowed, `premise: the gate allows a viewport drag (preview on, not playing)`);
	h.check(!!setup.rect, 'premise: the element is painted in the viewport');
	h.check(
		setup.hitTest === 'CANVAS',
		`premise: hit-testing sees the CANVAS through the layer, not the element (${setup.hitTest}) — so the gesture finds it by RECT`
	);
	h.check(
		setup.found?.id === 'drag-me' && setup.found?.key === 'scene' && setup.found?.screen === 'main',
		`and the gesture locates it anyway (${JSON.stringify(setup.found)})`
	);

	const beforeDrag = await page.evaluate(() => {
		const el = window.__stores.hudDocs.elementById('scene', 'drag-me');
		return { x: el.x, y: el.y };
	});
	await page.mouse.move(setup.rect.x, setup.rect.y);
	await page.mouse.down({ button: 'right' });
	for (let i = 1; i <= 10; i++) await page.mouse.move(setup.rect.x + i * 8, setup.rect.y + i * 4);
	const midDrag = await page.evaluate(() => window.__stores.hudViewportDrag.hudViewportDragging());
	await page.mouse.up({ button: 'right' });
	await page.waitForTimeout(800);
	const afterDrag = await page.evaluate(() => {
		const el = window.__stores.hudDocs.elementById('scene', 'drag-me');
		return { x: el.x, y: el.y };
	});
	h.check(midDrag, 'a right-drag on the element opens a HUD gesture');
	h.check(
		afterDrag.x === beforeDrag.x + 80 && afterDrag.y === beforeDrag.y + 40,
		`and moves it by the pointer delta, in its OWN anchor frame (${beforeDrag.x},${beforeDrag.y} -> ${afterDrag.x},${afterDrag.y}; expected +80,+40)`
	);
	const dragUndone = await page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 700));
		const el = window.__stores.hudDocs.elementById('scene', 'drag-me');
		return { x: el.x, y: el.y };
	});
	h.check(
		dragUndone.x === beforeDrag.x && dragUndone.y === beforeDrag.y,
		`ONE undo reverts the WHOLE drag (${dragUndone.x},${dragUndone.y})`
	);

	// ANCHOR AWARENESS: a bottom-right element's x/y count from the other corner, so the
	// SAME pointer motion must write the opposite sign
	const anchored = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.updateHudElement('scene', 'main', 'drag-me', { anchor: 'bottom-right', x: 200, y: 150 });
		await new Promise((r) => setTimeout(r, 800));
		const slot = document.querySelector('#hud-layer [data-hud-id="drag-me"]');
		const r = slot.getBoundingClientRect();
		return {
			x: Math.round(r.x + r.width / 2),
			y: Math.round(r.y + r.height / 2),
			before: { ...H.elementById('scene', 'drag-me') }
		};
	});
	await page.mouse.move(anchored.x, anchored.y);
	await page.mouse.down({ button: 'right' });
	for (let i = 1; i <= 8; i++) await page.mouse.move(anchored.x + i * 5, anchored.y + i * 5);
	await page.mouse.up({ button: 'right' });
	await page.waitForTimeout(800);
	const anchoredAfter = await page.evaluate(() => {
		const el = window.__stores.hudDocs.elementById('scene', 'drag-me');
		return { x: el.x, y: el.y };
	});
	h.check(
		anchoredAfter.x === anchored.before.x - 40 && anchoredAfter.y === anchored.before.y - 40,
		`dragging DOWN-RIGHT decreases a bottom-right element's offsets (${anchored.before.x},${anchored.before.y} -> ${anchoredAfter.x},${anchoredAfter.y}; expected -40,-40)`
	);

	// A SUB-THRESHOLD RIGHT-CLICK STILL MENUS. Suppressing the canvas press also suppresses
	// the viewport menu, and "right-click does nothing over my HUD" is the worse bug.
	const tapMenu = await page.evaluate(() => {
		window.__stores.viewportMenu.set(null);
		window.__stores.objectContextMenu.set(null);
		const slot = document.querySelector('#hud-layer [data-hud-id="drag-me"]');
		const r = slot.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	await page.mouse.click(tapMenu.x, tapMenu.y, { button: 'right' });
	await page.waitForTimeout(900);
	const menuOpened = await page.evaluate(() => {
		let vp, obj;
		window.__stores.viewportMenu.subscribe((v) => (vp = v))();
		window.__stores.objectContextMenu.subscribe((v) => (obj = v))();
		return {
			vp: !!vp,
			obj: !!obj,
			dom: !!document.querySelector('[role="menu"]'),
			moved: window.__stores.hudDocs.elementById('scene', 'drag-me')
		};
	});
	h.check(
		menuOpened.vp || menuOpened.obj || menuOpened.dom,
		`a short right-CLICK on the element still opens the viewport menu (viewport=${menuOpened.vp}, object=${menuOpened.obj}, dom=${menuOpened.dom})`
	);
	h.check(
		menuOpened.moved.x === anchoredAfter.x && menuOpened.moved.y === anchoredAfter.y,
		`and moves nothing (${menuOpened.moved.x},${menuOpened.moved.y})`
	);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);

	// the GATE: play mode with the preview off is the one state where the HUD is a game's
	// UI and must not be editable by a right-drag
	const gated = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.hudPreviewInViewport.set(false);
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 700));
		const playing = s.hudViewportDrag.hudViewportDragAllowed();
		s.isLocked.set(null);
		await new Promise((r) => setTimeout(r, 600));
		const editorNoPreview = s.hudViewportDragAllowed?.() ?? s.hudViewportDrag.hudViewportDragAllowed();
		return { playing, editorNoPreview };
	});
	h.check(!gated.playing, `the gate REFUSES in play mode (${gated.playing})`);
	h.check(
		!gated.editorNoPreview,
		`and refuses in the editor with the preview off, so a right-drag stays a camera pan (${gated.editorNoPreview})`
	);

	// ======================================================================
	// 5. E2.5 — camera attach clarity, and no paint when the preview is off
	// ======================================================================
	const noPaint = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(false);
		s.bottomDock.activateDock('hud');
		s.hudDocs.hudPreviewInViewport.set(false);
		await new Promise((r) => setTimeout(r, 1400));
		return {
			board: !!document.querySelector('#hud-board'),
			layer: !!document.querySelector('#hud-layer'),
			ref: document.querySelector('#hud-stage-ref')?.textContent?.trim() ?? ''
		};
	});
	h.check(noPaint.board, 'premise: the editor is open with its artboard');
	h.check(
		!noPaint.layer,
		'with the preview off, the HUD is NOT painted over the viewport — you author on the artboard'
	);
	h.check(/1280/.test(noPaint.ref), `and the topbar states the reference resolution (${noPaint.ref})`);

	const camDoc = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create camera');
		await new Promise((r) => setTimeout(r, 1600));
		const cams = s.cameraObjects.listCameraObjects();
		if (!cams.length) return { noCamera: true };
		const cam = cams[0];
		const select = document.querySelector('#hud-doc-key');
		if (!select) return { noSelect: true };
		select.value = cam.uuid;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1200));
		return {
			name: cam.name,
			ref: document.querySelector('#hud-stage-ref')?.textContent?.trim() ?? ''
		};
	});
	h.check(!camDoc.noCamera && !camDoc.noSelect, 'premise: a camera exists and the editor can be pointed at its HUD');
	h.check(
		!!camDoc.name && camDoc.ref.includes(camDoc.name),
		`the topbar NAMES the attached camera (${camDoc.ref})`
	);

	// ======================================================================
	// 6. review feedback — the focus RING is play-only too
	// ======================================================================
	const ring = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(true);
		s.hudDocs.hudPreviewInViewport.set(true);
		s.hudDocs.clearHudDocs();
		s.hudDocs.setHudDocFor('scene', {
			screens: [{ id: 'menu', name: 'Menu', elements: [{ id: 'go', kind: 'button', label: 'Go' }] }],
			active: 'menu'
		});
		await new Promise((r) => setTimeout(r, 1000));
		const editor = document.querySelectorAll('#hud-layer .hud-focused').length;
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 900));
		const playing = document.querySelectorAll('#hud-layer .hud-focused').length;
		s.isLocked.set(null);
		await new Promise((r) => setTimeout(r, 600));
		return { editor, playing, painted: document.querySelectorAll('#hud-layer [data-hud-id]').length };
	});
	h.check(ring.painted === 1, `premise: a button IS painted in both states (${ring.painted})`);
	h.check(
		ring.editor === 0,
		`outside play there is NO focus ring — E1.5 made its keys inert, so the outline was a lie (${ring.editor})`
	);
	h.check(ring.playing === 1, `and in play mode the ring is back (${ring.playing})`);

	await h.finish(browser);
});
