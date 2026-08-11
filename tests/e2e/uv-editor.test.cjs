// UV1: the UV editor is a Flow-family dock tab that shows the selected mesh's
// `uv` attribute and lets you drag its corners. A finished drag commits ONE
// meshgeo snapshot — replicated, undoable, persisted — so the feature needed no
// new wire type and no new history kind.
const h = require('./helpers.cjs');

/** a box with a real uv attribute + a canvas texture, selected */
const texturedBox = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		const c = document.createElement('canvas');
		c.width = c.height = 2;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#f00';
		ctx.fillRect(0, 0, 1, 1);
		ctx.fillStyle = '#0f0';
		ctx.fillRect(1, 1, 1, 1);
		box.material.map = new w.THREE.CanvasTexture(c);
		box.material.needsUpdate = true;
		w.objectActions.selectObject(box.uuid);
		return box.uuid;
	});

/**
 * The uvs INDEX-EXPANDED, i.e. one pair per drawn corner. Comparing the raw
 * attribute across a commit would be apples-to-oranges: a fresh box is indexed
 * (24 uvs for 36 corners) and applyMeshGeo rebuilds it non-indexed (36 uvs), so
 * the same mapping has two different array lengths. Expanded, it doesn't.
 */
const uvExpanded = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const uv = geo.attributes.uv;
		if (!uv) return null;
		const index = geo.index;
		const count = index ? index.count : uv.count;
		const out = [];
		for (let i = 0; i < count; i++) {
			const j = index ? index.getX(i) : i;
			out.push(+uv.getX(j).toFixed(5), +uv.getY(j).toFixed(5));
		}
		return out;
	}, uuid);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- the dock tab ----------
	const uuid = await texturedBox(A.page);
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false); // Node editor too, so the tab strip has siblings
		s.uvEditorClose.set(false);
		s.bottomDock.activateDock('uv');
	});
	await A.page.waitForTimeout(600);

	const tabs = await A.page.evaluate(
		() => new Promise((r) => window.__stores.bottomDock.flowTabs.subscribe((v) => r(v.map((x) => x.key)))())
	);
	h.check(tabs.includes('uv'), `the UV editor is a Flow-family dock tab (${tabs.join(',')})`);
	const occupant = await A.page.evaluate(
		() => new Promise((r) => window.__stores.bottomDock.dockOccupants.subscribe((v) => r(!!v.uv?.present))())
	);
	h.check(occupant, 'the UV editor reports itself as a dock occupant');
	const strip = await A.page.evaluate(() =>
		[...document.querySelectorAll('.tab-note')].map((b) => b.textContent.trim()).filter(Boolean)
	);
	h.check(strip.includes('UV editor'), `the tab strip renders the UV editor tab (${strip.join('|')})`);
	const dockShown = await A.page.evaluate(() => {
		const dock = document.getElementById('uv-dock');
		return !!dock && !dock.classList.contains('hidden');
	});
	h.check(dockShown, 'the UV editor is the visible dock panel after activateDock');

	// the "+" menu offers it (both copies of addItems must carry the entry — the
	// dock strip's and the floating Node editor header's)
	const plusItems = await A.page.evaluate(async () => {
		const plus = [...document.querySelectorAll('.tab-note')].find((b) => b.textContent.trim() === '＋');
		plus?.click();
		await new Promise((r) => setTimeout(r, 250));
		return [...document.querySelectorAll('.ctx-item, [role="menuitem"], button')]
			.map((b) => b.textContent.trim())
			.filter((t) => t.includes('UV editor'));
	});
	h.check(plusItems.length > 0, `the dock "+" menu offers UV editor (${plusItems.join('|')})`);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

	// the Explorer is mutually exclusive with the Flow family in the dock
	await A.page.evaluate(() => {
		window.__stores.explorerClose.set(false);
		window.__stores.bottomDock.activateDock('explorer');
	});
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('uv'));
	await A.page.waitForTimeout(400);
	const explorerClosed = await A.page.evaluate(
		() => new Promise((r) => window.__stores.explorerClose.subscribe((v) => r(v))())
	);
	h.check(explorerClosed, 'activating the UV tab closes a docked Explorer (dock exclusivity)');

	// ---------- the canvas ----------
	const canvas = await A.page.evaluate(() => {
		const el = /** @type {HTMLCanvasElement|null} */ (document.getElementById('uv-canvas'));
		if (!el) return { present: false };
		const r = el.getBoundingClientRect();
		return { present: true, w: Math.round(r.width), h: Math.round(r.height), backing: el.width > 0 };
	});
	h.check(canvas.present, 'the UV canvas renders for a textured selection');
	h.check(canvas.w > 40 && canvas.h > 40, `the UV canvas has real size (${canvas.w}x${canvas.h})`);
	h.check(canvas.backing, 'the UV canvas has a sized backing store (it drew at least once)');

	// gating: a mesh with no uv attribute reports why, and never offers the canvas
	const gate = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const ok = w.uvEditor.uvEditable(box).ok;
		const saved = box.geometry.attributes.uv;
		box.geometry.deleteAttribute('uv');
		const gated = w.uvEditor.uvEditable(box);
		box.geometry.setAttribute('uv', saved); // restore for the drag checks
		return { ok, gatedOk: gated.ok, reason: gated.reason };
	}, uuid);
	h.check(gate.ok, 'a textured box is UV-editable');
	h.check(!gate.gatedOk && /texture coordinates/i.test(gate.reason), `a mesh with no uv attribute is gated (${gate.reason})`);

	// ---------- welded cluster ----------
	const cluster = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const tris = w.uvEditor.uvTriangles(box, 0);
		const first = tris[0].indices[0];
		const found = w.uvEditor.weldedCluster(box.geometry, first);
		const uv = box.geometry.attributes.uv;
		// every member must sit at the SAME uv coordinate as the seed
		const same = found.every(
			(i) => Math.abs(uv.getX(i) - uv.getX(first)) < 1e-5 && Math.abs(uv.getY(i) - uv.getY(first)) < 1e-5
		);
		return { tris: tris.length, size: found.length, same, hasSeed: found.includes(first) };
	}, uuid);
	h.check(cluster.tris === 12, `uvTriangles reads all 12 box triangles for slot 0 (${cluster.tris})`);
	h.check(cluster.hasSeed && cluster.same, `weldedCluster groups only corners at the same uv point (${cluster.size})`);

	// ---------- drag through the lib: one commit, one undo entry ----------
	const before = await uvExpanded(A.page, uuid);
	const depthBefore = await undoDepth(A.page);
	const drag = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const seed = w.uvEditor.uvTriangles(box, 0)[0].indices[0];
		const indices = w.uvEditor.weldedCluster(box.geometry, seed);
		const opened = w.uvEditor.beginUvDrag(uuid);
		// two moves in one gesture — the commit must fold them into ONE entry
		w.uvEditor.moveUvCluster(box, indices, 0.05, 0.02);
		w.uvEditor.moveUvCluster(box, indices, 0.05, 0.02);
		const committed = w.uvEditor.endUvDrag(uuid);
		return { opened, committed, moved: indices.length };
	}, uuid);
	h.check(drag.opened, 'beginUvDrag opens a gesture on a UV-editable mesh');
	h.check(drag.committed, 'endUvDrag commits the gesture');
	const after = await uvExpanded(A.page, uuid);
	const changed = before.length === after.length && before.some((v, i) => Math.abs(v - after[i]) > 1e-4);
	h.check(changed, 'the drag actually moved the uv attribute');
	const depthAfter = await undoDepth(A.page);
	h.check(
		depthAfter === depthBefore + 1,
		`a whole drag gesture records exactly ONE undo entry (${depthBefore}->${depthAfter})`
	);
	const topKind = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v[v.length - 1]?.kind))())
	);
	h.check(topKind === 'meshgeo', `the entry rides the existing meshgeo kind (${topKind})`);

	// the commit normalizes the geometry the way peers and the undo replay hold it
	const shape = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		return {
			indexed: !!geo.index,
			covers: geo.attributes.uv.count === geo.attributes.position.count,
			tris: geo.attributes.position.count / 3
		};
	}, uuid);
	h.check(!shape.indexed, 'the committed geometry is index-expanded (what applyMeshGeo rebuilds)');
	h.check(shape.covers, 'uv.count still equals position.count after the commit (three requires it)');
	h.check(shape.tris === 12, `the box is still 12 triangles after a UV-only edit (${shape.tris})`);

	// ---------- undo restores the mapping ----------
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	const undone = await uvExpanded(A.page, uuid);
	const restored = undone.length === before.length && before.every((v, i) => Math.abs(v - undone[i]) < 1e-4);
	h.check(restored, `ONE undo restores the original UV mapping exactly (${before.length} vs ${undone?.length} corners)`);

	// ---------- a real pointer drag on the canvas ----------
	// The handlers are DIRECT listeners on the canvas and pointermove/up live on
	// window, so this drives exactly the path a user's mouse does. The screen
	// position comes from the component's OWN projection (__uvDebug) — a copy of
	// the projection math in the test could drift and would then "prove" a
	// working feature broken.
	h.check(await A.page.evaluate(() => typeof window.__uvDebug === 'function'), 'the __uvDebug hook is exposed');
	const pointerDrag = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const el = document.getElementById('uv-canvas');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const uv = box.geometry.attributes.uv;
		const dbg = window.__uvDebug();
		// a corner the component itself considers pickable in the active slot
		const seed = w.uvEditor.uvTriangles(box, dbg.slot)[0].indices[0];
		const u = uv.getX(seed);
		const v = uv.getY(seed);
		const local = dbg.project(u, v); // canvas-local px, the component's own math
		const r = el.getBoundingClientRect();
		const x = r.left + local.x;
		const y = r.top + local.y;
		const opt = (cx, cy) => ({ clientX: cx, clientY: cy, bubbles: true, pointerId: 7, pointerType: 'mouse' });
		const uvBefore = [u, v];
		el.dispatchEvent(new PointerEvent('pointerdown', opt(x, y)));
		const mid = window.__uvDebug(); // did it grab a vertex, or start a pan?
		window.dispatchEvent(new PointerEvent('pointermove', opt(x + 24, y)));
		window.dispatchEvent(new PointerEvent('pointerup', opt(x + 24, y)));
		await new Promise((res) => setTimeout(res, 250));
		const fresh = box.geometry.attributes.uv; // the commit swapped the geometry
		return {
			uvBefore,
			uvAfter: [fresh.getX(seed), fresh.getY(seed)],
			view: { w: Math.round(dbg.viewW), h: Math.round(dbg.viewH), span: Math.round(dbg.span), tris: dbg.tris },
			grabbed: mid.gesture,
			selected: mid.selected
		};
	}, uuid);
	h.check(
		pointerDrag.grabbed === 'drag' && pointerDrag.selected > 0,
		`pointerdown on a corner starts a vertex drag, not a pan (${pointerDrag.grabbed}, ${pointerDrag.selected} welded)`
	);
	const du = pointerDrag.uvAfter[0] - pointerDrag.uvBefore[0];
	h.check(du > 0.05, `a real pointer drag on the canvas moves the corner in +u (du=${du.toFixed(4)})`);
	h.check(
		Math.abs(pointerDrag.uvAfter[1] - pointerDrag.uvBefore[1]) < 0.01,
		'a horizontal drag leaves v alone (the y-flip is only in the projection)'
	);

	// ---------- multi-select: shift extends, plain click replaces ----------
	// SHIFT is the primary extend key (the viewport's shift-click convention and
	// every DCC UV editor); CTRL is accepted too because the mesh tools use it.
	const multi = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const el = document.getElementById('uv-canvas');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const dbg = window.__uvDebug();
		const tris = w.uvEditor.uvTriangles(box, dbg.slot);
		const r = el.getBoundingClientRect();
		// two corners at DIFFERENT uv points, so they are separate clusters
		const seen = new Map();
		for (const tri of tris)
			tri.corners.forEach((c, i) => {
				const key = c[0].toFixed(3) + ',' + c[1].toFixed(3);
				if (!seen.has(key)) seen.set(key, { index: tri.indices[i], uv: c });
			});
		const [a, b] = [...seen.values()];
		const click = (corner, mods = {}) => {
			const p = window.__uvDebug().project(corner.uv[0], corner.uv[1]);
			const opt = { clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true, pointerId: 9, pointerType: 'mouse', ...mods };
			el.dispatchEvent(new PointerEvent('pointerdown', opt));
			window.dispatchEvent(new PointerEvent('pointerup', opt));
		};
		click(a);
		const afterFirst = window.__uvDebug().selected;
		click(b, { shiftKey: true });
		const afterShift = window.__uvDebug().selected;
		click(b, { shiftKey: true }); // shift again on the same one TOGGLES it off
		const afterToggle = window.__uvDebug().selected;
		click(b, { ctrlKey: true }); // ctrl works as an alias
		const afterCtrl = window.__uvDebug().selected;
		click(a); // plain click REPLACES the whole selection
		const afterPlain = window.__uvDebug().selected;
		return { afterFirst, afterShift, afterToggle, afterCtrl, afterPlain, distinct: seen.size };
	}, uuid);
	h.check(multi.afterFirst > 0, `a plain click selects one welded cluster (${multi.afterFirst})`);
	h.check(
		multi.afterShift > multi.afterFirst,
		`Shift+click ADDS a second cluster (${multi.afterFirst} -> ${multi.afterShift})`
	);
	h.check(
		multi.afterToggle === multi.afterFirst,
		`Shift+click on an already-selected cluster toggles it OFF (${multi.afterShift} -> ${multi.afterToggle})`
	);
	h.check(multi.afterCtrl > multi.afterToggle, `Ctrl+click extends too (alias, ${multi.afterCtrl})`);
	h.check(
		multi.afterPlain === multi.afterFirst,
		`a plain click REPLACES the selection (${multi.afterCtrl} -> ${multi.afterPlain})`
	);

	// dragging one member of a multi-selection moves the WHOLE selection
	const groupDrag = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const el = document.getElementById('uv-canvas');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const r = el.getBoundingClientRect();
		// select EVERYTHING with a box that covers the whole UV square
		w.uvEditor.uvTool.set('box');
		const p0 = window.__uvDebug().project(-0.2, 1.2);
		const p1 = window.__uvDebug().project(1.2, -0.2);
		const opt = (x, y, mods = {}) => ({ clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 11, pointerType: 'mouse', ...mods });
		el.dispatchEvent(new PointerEvent('pointerdown', opt(p0.x, p0.y)));
		window.dispatchEvent(new PointerEvent('pointermove', opt((p0.x + p1.x) / 2, (p0.y + p1.y) / 2)));
		const mid = window.__uvDebug();
		window.dispatchEvent(new PointerEvent('pointermove', opt(p1.x, p1.y)));
		window.dispatchEvent(new PointerEvent('pointerup', opt(p1.x, p1.y)));
		await new Promise((res) => setTimeout(res, 150));
		const dbg = window.__uvDebug();
		const selected = dbg.selectedIndices.slice();
		const uv = box.geometry.attributes.uv;
		const before = selected.map((i) => [uv.getX(i), uv.getY(i)]);
		// now drag ONE of them; every selected corner must move by the same delta
		const anchor = window.__uvDebug().project(before[0][0], before[0][1]);
		el.dispatchEvent(new PointerEvent('pointerdown', opt(anchor.x, anchor.y)));
		window.dispatchEvent(new PointerEvent('pointermove', opt(anchor.x + 20, anchor.y)));
		window.dispatchEvent(new PointerEvent('pointerup', opt(anchor.x + 20, anchor.y)));
		await new Promise((res) => setTimeout(res, 250));
		const fresh = box.geometry.attributes.uv;
		const deltas = selected.map((i, k) => +(fresh.getX(i) - before[k][0]).toFixed(4));
		w.uvEditor.uvTool.set('select');
		return {
			boxGesture: mid.gesture,
			hadMarquee: !!mid.marquee,
			selected: selected.length,
			minDelta: Math.min(...deltas),
			maxDelta: Math.max(...deltas)
		};
	}, uuid);
	h.check(groupDrag.boxGesture === 'box' && groupDrag.hadMarquee, `box mode drags a marquee, not the view (${groupDrag.boxGesture})`);
	h.check(groupDrag.selected > 8, `a full-square box selects every corner (${groupDrag.selected})`);
	h.check(
		groupDrag.minDelta > 0.02 && Math.abs(groupDrag.maxDelta - groupDrag.minDelta) < 1e-3,
		`dragging one member moves the WHOLE selection by the same delta (${groupDrag.minDelta}..${groupDrag.maxDelta})`
	);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(300);

	// ---------- lasso ----------
	const lassoed = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const el = document.getElementById('uv-canvas');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		w.uvEditor.uvTool.set('lasso');
		const r = el.getBoundingClientRect();
		const opt = (x, y) => ({ clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 13, pointerType: 'mouse' });
		// a triangle-ish loop around the LEFT half of the UV square, started
		// outside the geometry so the press lands on empty space
		const P = (u, v) => window.__uvDebug().project(u, v);
		const path = [P(-0.15, 1.15), P(0.55, 1.15), P(0.55, -0.15), P(-0.15, -0.15)];
		el.dispatchEvent(new PointerEvent('pointerdown', opt(path[0].x, path[0].y)));
		for (const p of path.slice(1)) window.dispatchEvent(new PointerEvent('pointermove', opt(p.x, p.y)));
		const mid = window.__uvDebug();
		window.dispatchEvent(new PointerEvent('pointerup', opt(path[3].x, path[3].y)));
		await new Promise((res) => setTimeout(res, 150));
		const dbg = window.__uvDebug();
		const uv = box.geometry.attributes.uv;
		// every selected corner must really be in the lassoed u range
		const us = dbg.selectedIndices.map((i) => uv.getX(i));
		w.uvEditor.uvTool.set('select');
		return {
			gesture: mid.gesture,
			points: mid.lassoPoints,
			selected: dbg.selected,
			maxU: us.length ? Math.max(...us) : -1,
			cleared: dbg.marquee === null
		};
	}, uuid);
	h.check(lassoed.gesture === 'lasso' && lassoed.points > 2, `lasso mode records a freehand path (${lassoed.points} points)`);
	h.check(lassoed.selected > 0, `the lasso selects the corners it encloses (${lassoed.selected})`);
	h.check(
		lassoed.maxU <= 0.55 + 1e-6,
		`...and ONLY those: nothing selected past the lasso's right edge (max u ${lassoed.maxU.toFixed(3)})`
	);

	// clicking empty space in Select mode deselects
	const cleared = await A.page.evaluate(async () => {
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		const p = window.__uvDebug().project(-0.3, 1.3);
		const opt = { clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true, pointerId: 15, pointerType: 'mouse' };
		el.dispatchEvent(new PointerEvent('pointerdown', opt));
		window.dispatchEvent(new PointerEvent('pointerup', opt));
		await new Promise((res) => setTimeout(res, 120));
		return window.__uvDebug().selected;
	});
	h.check(cleared === 0, `a plain click on empty space deselects (${cleared} left)`);

	// the three tools are real buttons and switch the active tool
	const toolBtns = await A.page.evaluate(async () => {
		const ids = ['uv-tool-select', 'uv-tool-box', 'uv-tool-lasso'];
		const present = ids.filter((id) => !!document.getElementById(id));
		document.getElementById('uv-tool-lasso')?.click();
		await new Promise((r) => setTimeout(r, 120));
		const pressed = document.getElementById('uv-tool-lasso')?.getAttribute('aria-pressed');
		document.getElementById('uv-tool-select')?.click();
		await new Promise((r) => setTimeout(r, 120));
		let active;
		window.__stores.uvEditor.uvTool.subscribe((v) => (active = v))();
		return { present, pressed, active };
	});
	h.check(toolBtns.present.length === 3, `the topbar offers all three tools (${toolBtns.present.join(',')})`);
	h.check(toolBtns.pressed === 'true' && toolBtns.active === 'select', 'the tool buttons switch the active tool and mark it pressed');

	// ---------- zoom / pan ----------
	const zoomed = await A.page.evaluate(async () => {
		const el = document.getElementById('uv-canvas');
		const label = () => {
			const text = [...document.querySelectorAll('#uv-dock span')].map((s) => s.textContent.trim());
			return text.find((t) => /^\d+%$/.test(t)) ?? '';
		};
		const at = label();
		const r = el.getBoundingClientRect();
		el.dispatchEvent(
			new WheelEvent('wheel', { deltaY: -120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })
		);
		await new Promise((res) => setTimeout(res, 200));
		return { before: at, after: label() };
	});
	h.check(
		zoomed.after !== zoomed.before && parseInt(zoomed.after) > parseInt(zoomed.before),
		`scrolling zooms the UV view in (${zoomed.before} -> ${zoomed.after})`
	);

	// ---------- undock into a floating window ----------
	await A.page.evaluate(() => {
		const dock = document.getElementById('uv-dock');
		[...dock.querySelectorAll('button')].find((b) => b.title && b.title.includes('Undock'))?.click();
	});
	await A.page.waitForTimeout(500);
	const floating = await A.page.evaluate(() => {
		const win = document.getElementById('uv-window');
		if (!win) return { win: false };
		const hasCanvas = !!win.querySelector('#uv-canvas');
		const hasShell = !!win.querySelector('.ws-root');
		return { win: true, hasCanvas, hasShell };
	});
	h.check(floating.win, 'the UV editor undocks into a floating window');
	h.check(floating.hasCanvas, 'the floating UV window renders the same canvas');
	h.check(floating.hasShell, 'the floating UV window keeps the WindowShell sidebars');

	await h.finish(browser);
});
