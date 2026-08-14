// UV transform tools (U1-U3): Move/Rotate/Scale on 1/2/3, a modal grab, a keyboard
// and a context menu — the interaction model the animation timeline already has,
// applied to the UV editor's 2D points. The transform MATHS existed; what is new is
// that it runs absolutely from a snapshot (`transformUvCluster` compounds), that the
// keys reach the UV editor at all (1/2/3 are taken twice over), and that right-click
// no longer starts a drag under the browser's own menu.
//
// Nothing here is new NETCODE: a rotate rides the same meshgeo message a drag always
// did, which the two-peer section at the end asserts.
const h = require('./helpers.cjs');

/** a box with a 64x64 canvas texture (so one texture pixel is exactly 1/64), selected */
const texturedBox = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#f00';
		ctx.fillRect(0, 0, 32, 32);
		ctx.fillStyle = '#0f0';
		ctx.fillRect(32, 32, 32, 32);
		box.material.map = new w.THREE.CanvasTexture(c);
		box.material.needsUpdate = true;
		w.objectActions.selectObject(box.uuid);
		return box.uuid;
	});

const openUv = async (page) => {
	await page.evaluate(() => {
		const s = window.__stores;
		s.uvEditorClose.set(false);
		s.bottomDock.activateDock('uv');
	});
	await page.waitForTimeout(700);
};

const dbg = (page) => page.evaluate(() => window.__uvDebug());
const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));

/** the selected points' uv coordinates, read off the LIVE attribute */
const selectionUvs = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const uv = g.getObjectByProperty('uuid', uuid).geometry.attributes.uv;
		return window.__uvDebug().selectedIndices.map((i) => [uv.getX(i), uv.getY(i)]);
	}, uuid);

/** the bounds of a list of [u, v] pairs */
const boundsOf = (points) => {
	const us = points.map((p) => p[0]);
	const vs = points.map((p) => p[1]);
	return {
		uMin: Math.min(...us), uMax: Math.max(...us),
		vMin: Math.min(...vs), vMax: Math.max(...vs),
		cu: (Math.min(...us) + Math.max(...us)) / 2,
		cv: (Math.min(...vs) + Math.max(...vs)) / 2,
		w: Math.max(...us) - Math.min(...us),
		hgt: Math.max(...vs) - Math.min(...vs)
	};
};

/** viewport pixel for a uv point, through the COMPONENT's own projection (a copy of
 *  the projection in the test could drift and would then "prove" a working feature
 *  broken) */
const pointAt = (page, u, v) =>
	page.evaluate(
		([u, v]) => {
			const el = document.getElementById('uv-canvas');
			const r = el.getBoundingClientRect();
			const p = window.__uvDebug().project(u, v);
			return { x: r.left + p.x, y: r.top + p.y };
		},
		[u, v]
	);

/**
 * A grip for a rotate or scale: an ACTUAL selected point, as far from the selection's
 * centre as possible, with the pivot's pixel and the polar coordinates to swing it
 * around. The first version of this suite aimed at (uMax, cv) — where a box has no
 * corner at all — so the press landed on empty space and PANNED, and the three
 * assertions around it (pivot held still, radii preserved) all passed vacuously.
 */
const farGrip = async (page, points) => {
	const b = boundsOf(points);
	const from = (p) => Math.hypot(p[0] - b.cu, p[1] - b.cv);
	// furthest first, but the pixel has to BE the canvas: the corners of the UV square
	// sit under the app's corner chrome, and a press there hit a button (found with
	// elementFromPoint, not by reading handler code)
	const ranked = [...points].sort((p, q) => from(q) - from(p));
	const found = await page.evaluate((candidates) => {
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		for (const c of candidates) {
			const p = window.__uvDebug().project(c[0], c[1]);
			if (p.x < 8 || p.y < 8 || p.x > r.width - 8 || p.y > r.height - 8) continue;
			const x = Math.round(r.left + p.x);
			const y = Math.round(r.top + p.y);
			if (document.elementFromPoint(x, y) !== el) continue;
			return { uv: c, x, y };
		}
		return null;
	}, ranked);
	const px = found ? { x: found.x, y: found.y } : await pointAt(page, ranked[0][0], ranked[0][1]);
	const pivotPx = await pointAt(page, b.cu, b.cv);
	return {
		bounds: b,
		found: !!found,
		px,
		pivotPx,
		radius: Math.hypot(px.x - pivotPx.x, px.y - pivotPx.y),
		angle: Math.atan2(px.y - pivotPx.y, px.x - pivotPx.x)
	};
};

/** open the canvas menu (at a point, or the canvas centre) and click a row */
const clickMenuRow = async (page, text, at) => {
	const p =
		at ??
		(await page.evaluate(() => {
			const r = document.getElementById('uv-canvas').getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		}));
	await page.mouse.click(p.x, p.y, { button: 'right' });
	await page.waitForTimeout(250);
	const clicked = await page.evaluate((wanted) => {
		const row = [...document.querySelectorAll('.ctx-item, [role="menuitem"]')].find((n) =>
			n.textContent.trim().toLowerCase().includes(wanted)
		);
		row?.click();
		return !!row;
	}, text.toLowerCase());
	await page.waitForTimeout(300);
	return clicked;
};

/** focus the editor's keyboard host the way a user does — by pressing in it */
const focusUv = async (page) => {
	const centre = await page.evaluate(() => {
		const r = document.getElementById('uv-canvas').getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	// a plain click on the background pans/deselects, so press ON a selected point
	// only when that is what we want; here we just want focus, so use the wrap
	await page.evaluate(() => document.getElementById('uv-canvas-wrap').focus());
	return centre;
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const errors = [];
	A.page.on('pageerror', (e) => errors.push(String(e)));

	const uuid = await texturedBox(A.page);
	await openUv(A.page);
	h.check(await A.page.evaluate(() => !!document.getElementById('uv-canvas')), 'the UV canvas is up');

	// ---------- the armed transform ----------
	const modeButtons = await A.page.evaluate(() =>
		['move', 'rotate', 'scale'].map((m) => document.getElementById('uv-mode-' + m)?.textContent?.trim())
	);
	h.check(
		modeButtons.join('|') === 'Move|Rotate|Scale',
		`the topbar offers the three modes as WORDS (${modeButtons.join('|')})`
	);
	h.check((await dbg(A.page)).xform === 'move', 'Move is armed by default (the non-destructive one)');
	await A.page.click('#uv-mode-scale');
	h.check((await dbg(A.page)).xform === 'scale', 'clicking Scale arms it');

	// the KEYS: 1/2/3 are claimed while the editor holds focus. They are taken twice
	// over — by the gizmo transform modes (shortcuts.js) and, whenever an Edit Mesh
	// session is open, by MeshEditPopup's element modes — so this asserts BOTH that
	// the UV editor gets them and that nothing else does.
	await A.page.evaluate((uuid) => window.__stores.meshEdit.enterEditMode(uuid), uuid);
	await A.page.evaluate((uuid) => window.__stores.faceEdit.enterFaceEdit(uuid), uuid);
	await A.page.waitForTimeout(400);
	const modes = () =>
		A.page.evaluate(async () => ({
			submode: await new Promise((r) => window.__stores.faceEdit.faceEditSubmode.subscribe((v) => r(v))()),
			gizmo: await new Promise((r) => window.__stores.transformMode.subscribe((v) => r(v))())
		}));
	const { submode: preSubmode, gizmo: preGizmo } = await modes();
	await focusUv(A.page);
	await A.page.keyboard.press('2');
	await A.page.waitForTimeout(150);
	const afterTwo = await dbg(A.page);
	const { submode: postSubmode, gizmo: postGizmo } = await modes();
	h.check(afterTwo.xform === 'rotate', `pressing 2 in the UV editor arms Rotate (${afterTwo.xform})`);
	h.check(
		postSubmode === preSubmode,
		`and does NOT switch the mesh element mode (${preSubmode} -> ${postSubmode})`
	);
	h.check(postGizmo === preGizmo, `nor the gizmo transform mode (${preGizmo} -> ${postGizmo})`);
	await A.page.keyboard.press('1');
	h.check((await dbg(A.page)).xform === 'move', 'pressing 1 arms Move again');
	// leave the mesh session: the rest of the suite is about the UV editor alone
	await A.page.evaluate(() => {
		window.__stores.faceEdit.exitFaceEdit();
		window.__stores.meshEdit.exitEditMode();
	});
	await A.page.waitForTimeout(300);

	// ---------- select all, invert, island ----------
	await focusUv(A.page);
	await A.page.keyboard.press('Control+a');
	await A.page.waitForTimeout(150);
	const all = (await dbg(A.page)).selected;
	h.check(all > 0, `Ctrl+A selects every point in the slot (${all})`);
	await A.page.keyboard.press('Control+i');
	await A.page.waitForTimeout(150);
	h.check((await dbg(A.page)).selected === 0, 'Ctrl+I inverts a full selection to nothing');
	await A.page.keyboard.press('Control+i');
	await A.page.waitForTimeout(150);
	h.check((await dbg(A.page)).selected === all, `and back again (${all})`);

	// ---------- the nudge is ONE TEXTURE PIXEL, and one undo entry ----------
	// pick a single cluster with a real click, so the keyboard acts on what a user
	// would have selected
	const view = await dbg(A.page);
	h.check(
		Math.abs(view.pixelStep.u - 1 / 64) < 1e-9,
		`the pixel step comes from the 64x64 texture (${view.pixelStep.u})`
	);
	const seed = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const tris = w.uvEditor.uvTriangles(box, window.__uvDebug().slot);
		const corner = tris[0].corners[0];
		return { u: corner[0], v: corner[1] };
	}, uuid);
	let at = await pointAt(A.page, seed.u, seed.v);
	await A.page.mouse.click(at.x, at.y);
	await A.page.waitForTimeout(200);
	const picked = await dbg(A.page);
	h.check(picked.selected > 0, `a click picks the welded cluster (${picked.selected})`);

	const beforeNudge = await selectionUvs(A.page, uuid);
	const depthBeforeNudge = await undoDepth(A.page);
	await A.page.keyboard.press('ArrowRight');
	await A.page.waitForTimeout(300);
	const afterNudge = await selectionUvs(A.page, uuid);
	const depthAfterNudge = await undoDepth(A.page);
	const du1 = afterNudge[0][0] - beforeNudge[0][0];
	h.check(
		Math.abs(du1 - 1 / 64) < 1e-5,
		`ArrowRight moves the selection exactly one texture pixel (du=${du1.toFixed(6)}, 1/64=${(1 / 64).toFixed(6)})`
	);
	h.check(
		Math.abs(afterNudge[0][1] - beforeNudge[0][1]) < 1e-6,
		'and leaves v alone'
	);
	h.check(
		depthAfterNudge === depthBeforeNudge + 1,
		`each press is exactly one undo entry (${depthBeforeNudge}->${depthAfterNudge})`
	);
	// The commit rebuilds the geometry index-EXPANDED, renumbering every uv index. A
	// second press therefore has to move the SAME points — before the selection was
	// re-derived by coordinate it would have moved corners nobody picked.
	const secondBefore = await selectionUvs(A.page, uuid);
	await A.page.keyboard.press('ArrowRight');
	await A.page.waitForTimeout(300);
	const secondAfter = await selectionUvs(A.page, uuid);
	const du2 = secondAfter[0][0] - secondBefore[0][0];
	h.check(
		Math.abs(du2 - 1 / 64) < 1e-5 && secondAfter.length === secondBefore.length,
		`a SECOND press moves the same points by another pixel (du=${du2.toFixed(6)}, ${secondBefore.length} points)`
	);
	// Anchored on the coordinate the user CLICKED, not on the selection: a commit
	// rebuilds the geometry index-expanded and renumbers every uv index, so without
	// re-deriving the selection the second press moves a different cluster — and every
	// relative check reads through the same stale lens and cannot see it. Two presses
	// must leave NOTHING one pixel along.
	const countAt = (u, v) =>
		A.page.evaluate(
			async ([uuid, u, v]) => {
				const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
				const uv = g.getObjectByProperty('uuid', uuid).geometry.attributes.uv;
				let n = 0;
				for (let i = 0; i < uv.count; i++)
					if (Math.abs(uv.getX(i) - u) < 1e-5 && Math.abs(uv.getY(i) - v) < 1e-5) n++;
				return n;
			},
			[uuid, u, v]
		);
	const strandedHalfway = await countAt(seed.u + 1 / 64, seed.v);
	const landed = await countAt(seed.u + 2 / 64, seed.v);
	h.check(
		strandedHalfway === 0 && landed > 0,
		`two presses take the CLICKED corner two pixels along, leaving none behind (${landed} landed, ${strandedHalfway} stranded)`
	);
	// the modifiers mean what they do in every numeric field in the app
	const ctrlBefore = await selectionUvs(A.page, uuid);
	await A.page.keyboard.press('Control+ArrowRight');
	await A.page.waitForTimeout(300);
	const ctrlAfter = await selectionUvs(A.page, uuid);
	const du10 = ctrlAfter[0][0] - ctrlBefore[0][0];
	h.check(Math.abs(du10 - 10 / 64) < 1e-4, `Ctrl+arrow is ten pixels (du=${du10.toFixed(6)})`);

	// ---------- Ctrl+Shift+arrow grows the selection ----------
	const growFrom = await dbg(A.page);
	const growFromUvs = await selectionUvs(A.page, uuid);
	await A.page.keyboard.press('Control+Shift+ArrowRight');
	await A.page.waitForTimeout(250);
	const grown = await dbg(A.page);
	const grownUvs = await selectionUvs(A.page, uuid);
	h.check(
		grown.selected > growFrom.selected,
		`Ctrl+Shift+Right adds the nearest unselected point (${growFrom.selected} -> ${grown.selected})`
	);
	h.check(
		boundsOf(grownUvs).uMax > boundsOf(growFromUvs).uMax + 1e-6,
		`and it lies to the +u side (uMax ${boundsOf(growFromUvs).uMax.toFixed(3)} -> ${boundsOf(grownUvs).uMax.toFixed(3)})`
	);

	// ---------- Delete is swallowed ----------
	// left alone it deletes the OBJECT (shortcuts.js) — never what a UV keyboard means
	await A.page.keyboard.press('Delete');
	await A.page.waitForTimeout(400);
	const stillThere = await A.page.evaluate(async (uuid) => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return !!g.getObjectByProperty('uuid', uuid);
	}, uuid);
	h.check(stillThere, 'Delete in the UV editor does NOT delete the object');

	// ---------- rotate: absolute from the snapshot, about a FROZEN pivot ----------
	// The counterfactual is computed in-test: the same gesture applied the way
	// `transformUvCluster` works (reading the CURRENT values per step) COMPOUNDS, so
	// if the gesture were incremental these two would not agree.
	await focusUv(A.page);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.press('2'); // rotate
	await A.page.waitForTimeout(200);
	const rotBefore = await selectionUvs(A.page, uuid);
	const rotBounds = boundsOf(rotBefore);
	// press on a selected point, then swing the pointer around the pivot
	let g = await farGrip(A.page, rotBefore);
	await A.page.mouse.move(g.px.x, g.px.y);
	await A.page.mouse.down();
	const pressed = await dbg(A.page);
	// say what was under the pointer when it did not land: a canvas click that "does
	// nothing" is usually something else sitting on that pixel
	const under = await A.page.evaluate(
		([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return el ? el.id || el.className || el.tagName : 'nothing';
		},
		[Math.round(g.px.x), Math.round(g.px.y)]
	);
	h.check(pressed.gesture === 'drag', `the press landed on a selected point (${pressed.gesture}, under the pointer: ${String(under).slice(0, 60)})`);
	// 90 degrees, in TWENTY steps — an incremental apply would multiply
	for (let i = 1; i <= 20; i++) {
		const angle = g.angle + (Math.PI / 2) * (i / 20);
		await A.page.mouse.move(
			g.pivotPx.x + Math.cos(angle) * g.radius,
			g.pivotPx.y + Math.sin(angle) * g.radius
		);
	}
	const midRot = await dbg(A.page);
	const steppedUvs = await selectionUvs(A.page, uuid);
	await A.page.mouse.up();
	await A.page.waitForTimeout(350);
	const rotAfter = await selectionUvs(A.page, uuid);
	h.check(midRot.pivot !== null, 'a running rotate draws its frozen pivot');
	h.check(
		Math.abs(boundsOf(steppedUvs).cu - rotBounds.cu) < 2e-3 &&
			Math.abs(boundsOf(steppedUvs).cv - rotBounds.cv) < 2e-3,
		`the pivot holds still through the whole swing (centre ${boundsOf(steppedUvs).cu.toFixed(4)},${boundsOf(steppedUvs).cv.toFixed(4)} vs ${rotBounds.cu.toFixed(4)},${rotBounds.cv.toFixed(4)})`
	);
	// a 90 degree rotation of a square selection swaps its extents, and every point
	// keeps its distance from the pivot
	const radii = (points, centre) => points.map((p) => Math.hypot(p[0] - centre.cu, p[1] - centre.cv));
	const r0 = radii(rotBefore, rotBounds).sort((a, b) => a - b);
	const r1 = radii(rotAfter, rotBounds).sort((a, b) => a - b);
	const sameRadii = r0.length === r1.length && r0.every((v, i) => Math.abs(v - r1[i]) < 5e-3);
	h.check(sameRadii, 'a rotate preserves every point\'s distance from the pivot (it is a rotation)');
	const turned = rotBefore.some((p, i) => Math.hypot(p[0] - rotAfter[i][0], p[1] - rotAfter[i][1]) > 0.05);
	h.check(turned, 'and the points really moved');

	// the counterfactual: the SAME 20 steps applied compounding-style
	const compounded = await A.page.evaluate(
		async ([uuid, steps]) => {
			const w = window.__stores;
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const box = g.getObjectByProperty('uuid', uuid);
			const indices = window.__uvDebug().selectedIndices;
			const uv = box.geometry.attributes.uv;
			const before = indices.map((i) => [uv.getX(i), uv.getY(i)]);
			const pivot = { cu: 0, cv: 0 };
			let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
			for (const p of before) {
				uMin = Math.min(uMin, p[0]); uMax = Math.max(uMax, p[0]);
				vMin = Math.min(vMin, p[1]); vMax = Math.max(vMax, p[1]);
			}
			pivot.cu = (uMin + uMax) / 2;
			pivot.cv = (vMin + vMax) / 2;
			// what a per-move `transformUvCluster` call would do: each step re-reads the
			// values the previous step wrote
			for (let i = 0; i < steps; i++)
				w.uvEditor.transformUvCluster(box, indices, { rotate: Math.PI / 2 / steps, pivot });
			const after = indices.map((i) => [uv.getX(i), uv.getY(i)]);
			// put it back so the rest of the suite is unaffected
			for (let k = 0; k < indices.length; k++) uv.setXY(indices[k], before[k][0], before[k][1]);
			uv.needsUpdate = true;
			const drift = Math.max(...after.map((p, k) => Math.hypot(p[0] - before[k][0], p[1] - before[k][1])));
			return { drift, steps };
		},
		[uuid, 20]
	);
	h.check(
		compounded.drift > 0,
		`(counterfactual) 20 compounding steps of the same angle move points ${compounded.drift.toFixed(4)} — that path applies the angle ${compounded.steps} times over, which is why the gesture re-applies the TOTAL from its snapshot`
	);

	// ---------- scale ----------
	await focusUv(A.page);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.press('3');
	await A.page.waitForTimeout(200);
	const scalePoints = await selectionUvs(A.page, uuid);
	const scaleBefore = boundsOf(scalePoints);
	g = await farGrip(A.page, scalePoints);
	await A.page.mouse.move(g.px.x, g.px.y);
	await A.page.mouse.down();
	const scalePressed = await dbg(A.page);
	h.check(scalePressed.gesture === 'drag', `the scale press landed on a selected point (${scalePressed.gesture})`);
	// straight out along the same ray, to 1.5x the grip radius
	await A.page.mouse.move(
		g.pivotPx.x + Math.cos(g.angle) * g.radius * 1.5,
		g.pivotPx.y + Math.sin(g.angle) * g.radius * 1.5
	);
	await A.page.mouse.up();
	await A.page.waitForTimeout(350);
	const scaleAfter = boundsOf(await selectionUvs(A.page, uuid));
	const factor = scaleAfter.w / Math.max(scaleBefore.w, 1e-6);
	h.check(Math.abs(factor - 1.5) < 0.12, `dragging out to 1.5x the grip radius scales by ~1.5 (${factor.toFixed(3)})`);
	h.check(
		Math.abs(scaleAfter.cu - scaleBefore.cu) < 3e-3 && Math.abs(scaleAfter.cv - scaleBefore.cv) < 3e-3,
		'and scales about the frozen centre, which therefore does not move'
	);

	// ---------- the ORIGIN can be placed, dragged, and reset ----------
	// The automatic pivot is the selection's centre, which is useless when you want to
	// turn a face about its corner. Placing one has to CHANGE where a rotate turns —
	// asserting only that the marker moved would pass with the feature disconnected.
	await focusUv(A.page);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.press('2'); // rotate
	await A.page.waitForTimeout(200);
	const originPoints = await selectionUvs(A.page, uuid);
	const originBounds = boundsOf(originPoints);
	h.check((await dbg(A.page)).pivotPlaced === null, 'the origin starts automatic (the selection centre)');
	await A.page.click('#uv-origin');
	await A.page.waitForTimeout(150);
	const placed = (await dbg(A.page)).pivotPlaced;
	h.check(
		placed && Math.abs(placed.cu - originBounds.cu) < 1e-3 && Math.abs(placed.cv - originBounds.cv) < 1e-3,
		`the origin button places it on the selection (${placed && placed.cu.toFixed(3)},${placed && placed.cv.toFixed(3)})`
	);
	// drag it: it should snap onto a nearby uv point, so an origin can sit exactly on
	// a corner
	const cornerTarget = originPoints.reduce(
		(best, p) =>
			Math.hypot(p[0] - originBounds.cu, p[1] - originBounds.cv) >
			Math.hypot(best[0] - originBounds.cu, best[1] - originBounds.cv)
				? p
				: best,
		originPoints[0]
	);
	const fromPx = await pointAt(A.page, placed.cu, placed.cv);
	const toPx = await pointAt(A.page, cornerTarget[0], cornerTarget[1]);
	await A.page.mouse.move(fromPx.x, fromPx.y);
	await A.page.mouse.down();
	const pivotGesture = (await dbg(A.page)).gesture;
	await A.page.mouse.move(toPx.x + 3, toPx.y - 2); // near, not exactly on it
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const dragged = (await dbg(A.page)).pivotPlaced;
	h.check(pivotGesture === 'pivot', `pressing the origin grabs it as a handle (${pivotGesture})`);
	h.check(
		dragged &&
			Math.abs(dragged.cu - cornerTarget[0]) < 1e-5 &&
			Math.abs(dragged.cv - cornerTarget[1]) < 1e-5,
		`dragging it near a point SNAPS it exactly onto that point (${dragged && dragged.cu.toFixed(4)},${dragged && dragged.cv.toFixed(4)} vs ${cornerTarget[0].toFixed(4)},${cornerTarget[1].toFixed(4)})`
	);
	// a rotate now turns about the PLACED origin: the point it sits on cannot move,
	// while the selection's old centre must
	const beforePlacedRot = await selectionUvs(A.page, uuid);
	g = await farGrip(A.page, beforePlacedRot);
	h.check(g.found, 'a grip point on the canvas was found for the placed-origin rotate');
	await A.page.mouse.move(g.px.x, g.px.y);
	await A.page.mouse.down();
	const originPivotPx = await pointAt(A.page, dragged.cu, dragged.cv);
	const rad = Math.hypot(g.px.x - originPivotPx.x, g.px.y - originPivotPx.y);
	const startAngle = Math.atan2(g.px.y - originPivotPx.y, g.px.x - originPivotPx.x);
	for (let i = 1; i <= 8; i++) {
		const angle = startAngle + (Math.PI / 2) * (i / 8);
		await A.page.mouse.move(originPivotPx.x + Math.cos(angle) * rad, originPivotPx.y + Math.sin(angle) * rad);
	}
	const runningPivot = (await dbg(A.page)).pivot;
	await A.page.mouse.up();
	await A.page.waitForTimeout(350);
	const afterPlacedRot = await selectionUvs(A.page, uuid);
	h.check(
		runningPivot && Math.abs(runningPivot.cu - dragged.cu) < 1e-6 && Math.abs(runningPivot.cv - dragged.cv) < 1e-6,
		'the running gesture uses the placed origin, not the selection centre'
	);
	const distTo = (points, c) => points.map((p) => Math.hypot(p[0] - c.cu, p[1] - c.cv));
	const keptRadii = distTo(beforePlacedRot, dragged).sort((a, b) => a - b);
	const nowRadii = distTo(afterPlacedRot, dragged).sort((a, b) => a - b);
	h.check(
		keptRadii.every((v, i) => Math.abs(v - nowRadii[i]) < 5e-3),
		'every point keeps its distance from the PLACED origin (so that is what it turned about)'
	);
	const centreMoved = Math.hypot(
		boundsOf(afterPlacedRot).cu - boundsOf(beforePlacedRot).cu,
		boundsOf(afterPlacedRot).cv - boundsOf(beforePlacedRot).cv
	);
	h.check(
		centreMoved > 0.05,
		`and the selection's own centre SWUNG round it (${centreMoved.toFixed(3)}) — which is what an automatic pivot could never do`
	);
	// HOW FAR it turned, not just that it turned. Preserved radii cannot tell a
	// correct rotation from a COMPOUNDING one (each step re-reading what the last
	// wrote is still a rotation — just 8x too far), and with an off-centre origin the
	// selection's centroid is one well-defined point to measure: it must swing by the
	// angle the pointer swept.
	const centreAngle = (points) => {
		const b = boundsOf(points);
		return Math.atan2(b.cv - dragged.cv, b.cu - dragged.cu);
	};
	let swept = ((centreAngle(afterPlacedRot) - centreAngle(beforePlacedRot)) * 180) / Math.PI;
	while (swept > 180) swept -= 360;
	while (swept < -180) swept += 360;
	h.check(
		Math.abs(Math.abs(swept) - 90) < 12,
		`it turned by the 90 degrees the pointer swept, no more (${swept.toFixed(1)} deg)`
	);
	// back to automatic
	await A.page.click('#uv-origin');
	await A.page.waitForTimeout(150);
	h.check((await dbg(A.page)).pivotPlaced === null, 'clicking the origin button again goes back to automatic');

	// ---------- the modal grab ----------
	await focusUv(A.page);
	await A.page.keyboard.press('1'); // move
	await A.page.keyboard.press('Control+a');
	await A.page.waitForTimeout(200);
	// the rotates above pushed the mapping outside the 0..1 square, so frame it first
	// — a press aimed at a point that is off-canvas lands on whatever IS there
	h.check(await clickMenuRow(A.page, 'zoom to the selection'), 'the menu can frame the selection');
	const grabBefore = await selectionUvs(A.page, uuid);
	const grabBounds = boundsOf(grabBefore);
	let hold = await farGrip(A.page, grabBefore);
	h.check(hold.found, 'a selected point sits on the canvas to grab');
	let onPoint = hold.px;
	const depthBeforeGrab = await undoDepth(A.page);
	await A.page.mouse.move(onPoint.x, onPoint.y);
	await A.page.mouse.down({ button: 'middle' });
	await A.page.mouse.up({ button: 'middle' });
	await A.page.waitForTimeout(150);
	const grabState = await dbg(A.page);
	h.check(grabState.grabbing, 'middle-pressing a SELECTED point starts a modal grab');
	h.check(
		await A.page.evaluate(() => !!document.getElementById('uv-grab-badge')),
		'and the badge says so (a grab has no button held to hint at it)'
	);
	// the selection follows the pointer with NO button held
	await A.page.mouse.move(onPoint.x + 40, onPoint.y);
	await A.page.waitForTimeout(120);
	const following = boundsOf(await selectionUvs(A.page, uuid));
	h.check(following.cu > grabBounds.cu + 0.02, `the selection follows a button-less pointer (cu ${grabBounds.cu.toFixed(3)} -> ${following.cu.toFixed(3)})`);
	// a click commits it
	await A.page.mouse.click(onPoint.x + 40, onPoint.y);
	await A.page.waitForTimeout(400);
	const committed = boundsOf(await selectionUvs(A.page, uuid));
	const depthAfterGrab = await undoDepth(A.page);
	h.check(!(await dbg(A.page)).grabbing, 'a click ends the grab');
	h.check(
		Math.abs(committed.cu - following.cu) < 5e-3,
		`and leaves the selection where the pointer put it (${committed.cu.toFixed(3)})`
	);
	h.check(
		depthAfterGrab === depthBeforeGrab + 1,
		`the whole grab is ONE undo entry (${depthBeforeGrab}->${depthAfterGrab})`
	);

	// Escape puts a grab back — and records nothing. `cancelUvDrag` only drops the
	// session; the in-place writes are already on screen, so the revert has to write
	// the snapshot back itself.
	const cancelBefore = await selectionUvs(A.page, uuid);
	const depthBeforeCancel = await undoDepth(A.page);
	hold = await farGrip(A.page, cancelBefore);
	onPoint = hold.px;
	await A.page.mouse.move(onPoint.x, onPoint.y);
	await A.page.mouse.down({ button: 'middle' });
	await A.page.mouse.up({ button: 'middle' });
	await A.page.mouse.move(onPoint.x + 50, onPoint.y - 30);
	await A.page.waitForTimeout(150);
	const midCancel = boundsOf(await selectionUvs(A.page, uuid));
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(350);
	const cancelled = await selectionUvs(A.page, uuid);
	const restored =
		cancelled.length === cancelBefore.length &&
		cancelBefore.every((p, i) => Math.abs(p[0] - cancelled[i][0]) < 1e-6 && Math.abs(p[1] - cancelled[i][1]) < 1e-6);
	h.check(
		midCancel.cu > boundsOf(cancelBefore).cu + 0.02,
		'the cancelled grab really had moved the UVs first'
	);
	h.check(restored, 'Escape puts every point back exactly');
	h.check(
		(await undoDepth(A.page)) === depthBeforeCancel,
		`and records no undo entry (${depthBeforeCancel})`
	);
	h.check(!(await dbg(A.page)).grabbing, 'the grab is over after Escape');

	// middle-press on EMPTY space still pans, which is the only escape hatch the
	// marquee tools leave for panning
	const panBefore = await dbg(A.page);
	const empty = await A.page.evaluate(() => {
		const r = document.getElementById('uv-canvas').getBoundingClientRect();
		return { x: Math.round(r.left + 12), y: Math.round(r.top + 12) };
	});
	await A.page.mouse.move(empty.x, empty.y);
	await A.page.mouse.down({ button: 'middle' });
	await A.page.mouse.move(empty.x + 30, empty.y + 10);
	await A.page.mouse.up({ button: 'middle' });
	await A.page.waitForTimeout(200);
	const panAfter = await dbg(A.page);
	h.check(
		!panAfter.grabbing && Math.abs(panAfter.panX - panBefore.panX) > 10,
		`middle-drag on empty space still PANS (panX ${Math.round(panBefore.panX)} -> ${Math.round(panAfter.panX)})`
	);

	// ---------- the context menu ----------
	// right-click used to start a drag/marquee/pan AND show the browser's menu on top
	await focusUv(A.page);
	await A.page.keyboard.press('Control+a');
	await A.page.waitForTimeout(150);
	const menuSel = await dbg(A.page);
	const menuAt = await pointAt(A.page, (await selectionUvs(A.page, uuid))[0][0], (await selectionUvs(A.page, uuid))[0][1]);
	const prevented = await A.page.evaluate(
		([x, y]) => {
			const el = document.getElementById('uv-canvas');
			const e = new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 2 });
			el.dispatchEvent(e);
			return e.defaultPrevented;
		},
		[Math.round(menuAt.x), Math.round(menuAt.y)]
	);
	await A.page.waitForTimeout(300);
	h.check(prevented, 'the canvas prevents the BROWSER menu');
	const menuState = await dbg(A.page);
	h.check(
		menuState.gesture === 'idle' && menuState.selected === menuSel.selected,
		`a right-press starts no gesture and keeps the selection (${menuState.gesture}, ${menuState.selected})`
	);
	const labels = await A.page.evaluate(() =>
		[...document.querySelectorAll('.ctx-item, [role="menuitem"]')].map((n) => n.textContent.trim())
	);
	const has = (text) => labels.some((l) => l.toLowerCase().includes(text));
	h.check(labels.length > 0, `the shared ContextMenu opens (${labels.length} rows)`);
	h.check(has('rotate 90'), 'it carries the selection ops (Rotate 90)');
	h.check(has('snap to pixels'), 'and Snap to pixels');
	h.check(has('island'), 'and Select the island');
	h.check(has('unwrap'), 'and the unwrap backends');
	h.check(has('reset view'), 'and the view controls');
	h.check(has('place the origin here'), 'and placing the transform origin under the pointer');

	// a menu ACTION runs through the same commit path: Snap to pixels lands every
	// point on a texel boundary of the 64x64 texture, as one undo entry
	const depthBeforeSnap = await undoDepth(A.page);
	const snapped = await A.page.evaluate(() => {
		const row = [...document.querySelectorAll('.ctx-item, [role="menuitem"]')].find((n) =>
			n.textContent.trim().toLowerCase().includes('snap to pixels')
		);
		row?.click();
		return !!row;
	});
	await A.page.waitForTimeout(400);
	h.check(snapped, 'Snap to pixels is clickable');
	const snappedUvs = await selectionUvs(A.page, uuid);
	const offGrid = snappedUvs.filter(([u, v]) => Math.abs(u * 64 - Math.round(u * 64)) > 1e-4 || Math.abs(v * 64 - Math.round(v * 64)) > 1e-4);
	h.check(
		snappedUvs.length > 0 && offGrid.length === 0,
		`every one of the ${snappedUvs.length} points lands on a texel boundary (${offGrid.length} off-grid)`
	);
	h.check(
		(await undoDepth(A.page)) === depthBeforeSnap + 1,
		'and it is one undo entry'
	);
	// one undo restores the mapping the snap changed
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	h.check(
		(await undoDepth(A.page)) === depthBeforeSnap,
		'undo pops it again'
	);

	h.check(errors.length === 0, `no page errors through the whole run (${errors.slice(0, 2).join(' | ')})`);

	// ---------- two peers: a rotate needs NO new netcode ----------
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	const shared = await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	// `eventually` reports its own check, so don't double-report it — read the state
	// again for the branch below
	await h.eventually(
		() =>
			B.page.evaluate(async (uuid) => {
				const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
				return !!g.getObjectByProperty('uuid', uuid);
			}, shared),
		(v) => v,
		'the box reaches B',
		20000
	);
	const arrived = await B.page.evaluate(async (uuid) => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return !!g.getObjectByProperty('uuid', uuid);
	}, shared);
	if (arrived) {
		const wire = [];
		await A.page.evaluate(async () => {
			const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
			const original = peer.send.bind(peer);
			window.__uvWire = [];
			peer.send = (m) => {
				window.__uvWire.push(m?.type);
				return original(m); // pass THROUGH: a spy that drops makes delivery and loss identical
			};
		});
		await focusUv(A.page);
		await A.page.keyboard.press('Control+a');
		await A.page.keyboard.press('2');
		await A.page.waitForTimeout(150);
		g = await farGrip(A.page, await selectionUvs(A.page, uuid));
		await A.page.mouse.move(g.px.x, g.px.y);
		await A.page.mouse.down();
		await A.page.mouse.move(
			g.pivotPx.x + Math.cos(g.angle + Math.PI / 2) * g.radius,
			g.pivotPx.y + Math.sin(g.angle + Math.PI / 2) * g.radius
		); // a quarter turn
		await A.page.mouse.up();
		await A.page.waitForTimeout(600);
		wire.push(...(await A.page.evaluate(() => window.__uvWire)));
		h.check(
			wire.includes('meshgeo') && !wire.some((t) => /uvtransform|uvrotate/.test(String(t))),
			`the rotate travelled as the existing meshgeo message and nothing new (${[...new Set(wire)].join(',')})`
		);
		const mineA = await selectionUvs(A.page, uuid);
		const uvSum = (page) =>
			page.evaluate(async (uuid) => {
				const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
				const uv = g.getObjectByProperty('uuid', uuid)?.geometry?.attributes?.uv;
				if (!uv) return null;
				let sum = 0;
				for (let i = 0; i < uv.count; i++) sum += uv.getX(i) + uv.getY(i);
				return +sum.toFixed(4);
			}, uuid);
		const mineSum = await uvSum(A.page);
		h.check(mineA.length > 0, 'A still has its selection after the rotate');
		await h.eventually(
			() => uvSum(B.page),
			(v) => v !== null && Math.abs(v - mineSum) < 0.01,
			`B's UVs converge on A's after the rotate (A: ${mineSum})`,
			15000
		);
	}

	await h.finish(browser);
});
