// 19-B: advanced snapping — element snap targets during gizmo translate drags.
//  P2: snapTargets store (defaults keep every flag OFF = byte-identical
//  behaviour), the snapEngine (cursor-based candidate search over BVH picking,
//  pure scoreCandidates, element snap OVERRIDES grid steps while a candidate
//  is live), the Scene plain-branch hook, the candidate marker, and the
//  Inspector / viewport-menu element toggles.
const h = require('./helpers.cjs');

const targets = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.snapping.snapTargets.subscribe((v) => r({ ...v }))())
	);

/** open the viewport menu and read its Snapping submenu (grid-snapping recipe) */
async function snapSubmenu(page) {
	await page.evaluate(() => window.__stores.viewportMenu.set({ x: 240, y: 150, point: [0, 0, 0] }));
	await page.waitForTimeout(350);
	await page.locator('[role="menuitem"]').filter({ hasText: 'Snapping' }).first().hover();
	await page.waitForTimeout(300);
	return page.evaluate(() => {
		const sub = [...document.querySelectorAll('div')].find(
			(d) =>
				getComputedStyle(d).position === 'fixed' &&
				!d.getAttribute('role') &&
				d.textContent?.includes('Snap to surface')
		);
		const parentHint = [...document.querySelectorAll('[role="menu"] > [role="menuitem"]')]
			.find((r) => r.textContent?.includes('Snapping'))
			?.querySelector('.ctx-hint')?.textContent?.trim();
		return {
			found: !!sub,
			sections: [...(sub?.querySelectorAll('.ctx-section') ?? [])].map((s) => s.textContent?.trim()),
			rows: [...(sub?.querySelectorAll('[role="menuitem"]') ?? [])].map((r) => r.textContent?.trim()),
			checked: [...(sub?.querySelectorAll('.ctx-checked') ?? [])].map((s) => s.textContent?.trim()),
			parentHint
		};
	});
}

/** A screen point that really hovers the +X translate arrow. Projecting the
 * handle mesh's world position lands on the XYZ octahedron (its origin is the
 * gizmo center — measured axis=XYZ) and its bbox center can overlap a PLANE
 * handle (measured axis=YZ), so the only trustworthy grip is one the gizmo
 * itself confirms: probe points along the arrow shaft and take the first
 * whose HOVER arms axis === 'X'. */
async function findXArrowGrip(page) {
	const candidates = await page.evaluate(() => {
		let controls = null;
		let cam = null;
		window.__stores.TControls.subscribe((v) => (controls = v))();
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		const helper = controls?.getHelper?.() ?? controls;
		if (!helper || !cam) return null;
		let pick = null;
		helper.traverse((n) => {
			if (!pick && n.isMesh && n.name === 'X') pick = n;
		});
		if (!pick) return null;
		const THREE = window.__stores.THREE;
		const box = new THREE.Box3().setFromObject(pick);
		const c = box.getCenter(new THREE.Vector3());
		return [0.75, 0.6, 0.85, 0.5, 0.95].map((t) => {
			const v = new THREE.Vector3(box.min.x + t * (box.max.x - box.min.x), c.y, c.z).project(cam);
			return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
		});
	});
	if (!candidates) return null;
	for (const px of candidates) {
		await page.mouse.move(px[0], px[1]);
		await page.waitForTimeout(80);
		const axis = await page.evaluate(
			() => new Promise((r) => window.__stores.TControls.subscribe((c) => r(c?.axis))())
		);
		if (axis === 'X') return px;
	}
	return null;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- 1. defaults + persistence ----------
	let t = await targets(A.page);
	h.check(
		t.enabled === true && !t.vertex && !t.edge && !t.face && !t.surface && !t.object && !t.alignNormal,
		'defaults: master switch on, every element target OFF (byte-identical behaviour)'
	);
	h.check(
		t.radiusPx === 25 && t.anchorMode === 'auto',
		`defaults: radius 25px, anchor mode auto (${t.radiusPx}, ${t.anchorMode})`
	);
	await A.page.evaluate(() =>
		window.__stores.snapping.snapTargets.update((v) => ({ ...v, vertex: true, radiusPx: 30 }))
	);
	await h.freshReload(A);
	await A.page.waitForTimeout(800);
	t = await targets(A.page);
	h.check(
		t.vertex === true && t.radiusPx === 30 && t.face === false,
		'targets persist across a reload (localStorage merge-load)'
	);

	// ---------- 2. scoreCandidates is PURE ----------
	const scores = await A.page.evaluate(() => {
		const s = window.__stores.snapEngine.scoreCandidates;
		return {
			vertexBeatsSurface: s(
				[
					{ type: 'surface', px: [100, 100] },
					{ type: 'vertex', px: [107, 100] }
				],
				[100, 100],
				25
			)?.type,
			surfaceAlone: s([{ type: 'surface', px: [110, 100] }], [100, 100], 25)?.type,
			// the radius gate is on DISTANCE, not on the biased score (30-8 < 25 but still out)
			outsideRadius: s([{ type: 'vertex', px: [130, 100] }], [100, 100], 25),
			nullPx: s([{ type: 'vertex', px: null }], [100, 100], 25),
			tieFirstWins: s(
				[
					{ type: 'face', px: [105, 100], tag: 'first' },
					{ type: 'object', px: [105, 100], tag: 'second' }
				],
				[100, 100],
				25
			)?.tag
		};
	});
	h.check(
		scores.vertexBeatsSurface === 'vertex',
		`a vertex 7px off beats the surface under the cursor (bias -8): ${scores.vertexBeatsSurface}`
	);
	h.check(scores.surfaceAlone === 'surface', 'a lone surface candidate within radius wins');
	h.check(scores.outsideRadius === null, 'a candidate outside radiusPx is rejected on raw distance');
	h.check(scores.nullPx === null, 'a candidate with no projection (behind the camera) is skipped');
	h.check(scores.tieFirstWins === 'first', 'equal scores: the first-built candidate wins (deterministic)');

	// ---------- 3. Inspector chips ----------
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(600);
	const chips = await A.page.evaluate(() => ({
		vertex: !!document.querySelector('#snap-target-vertex'),
		face: !!document.querySelector('#snap-target-face'),
		surface: !!document.querySelector('#snap-target-surface'),
		object: !!document.querySelector('#snap-target-object'),
		radius: !!document.querySelector('#snap-radius')
	}));
	h.check(
		chips.vertex && chips.face && chips.surface && chips.object,
		'the four element chips render in Configure Scene ▸ Snapping'
	);
	h.check(chips.radius, 'the radius DragRow renders');
	await A.page.evaluate(() => document.querySelector('#snap-target-face').click());
	await A.page.waitForTimeout(200);
	t = await targets(A.page);
	h.check(t.face === true, 'clicking the Face chip flips the store');
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(300);

	// ---------- 4. viewport menu: Elements section + hint tag ----------
	const sub = await snapSubmenu(A.page);
	h.check(sub.found, 'the Snapping submenu opens');
	h.check(sub.sections.includes('Elements'), `it has an Elements section (${sub.sections.filter(Boolean)})`);
	h.check(
		['Vertex', 'Face', 'Surface', 'Object'].every((row) => sub.rows.includes(row)),
		'the four element rows are there'
	);
	h.check(
		sub.checked.includes('Vertex') && sub.checked.includes('Face'),
		`the ON targets are marked (${sub.checked})`
	);
	// vertex + face are on → the parent hint carries the compact tag
	h.check(
		!!sub.parentHint && sub.parentHint.endsWith('· V F'),
		`the parent hint gains the compact tag (${sub.parentHint})`
	);
	await A.page.evaluate(() => {
		const rows = [...document.querySelectorAll('div')]
			.find((d) => getComputedStyle(d).position === 'fixed' && d.textContent?.includes('Snap to surface'))
			?.querySelectorAll('[role="menuitem"]');
		[...rows].find((r) => r.textContent?.trim() === 'Object')?.click();
	});
	await A.page.waitForTimeout(200);
	t = await targets(A.page);
	h.check(t.object === true, 'the menu Object row flips the store');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));
	await A.page.waitForTimeout(200);

	// ---------- 5. the engine, synthetically (deterministic) ----------
	// Two boxes; drag A by the gizmo (synthetic dragging-changed + change events
	// through the REAL Scene handlers) with the pointer aimed just inside box B's
	// front face at its corner (3, 2, 1). The vertex candidate must win and the
	// clamped 'auto' anchor of A must land ON the corner.
	const ids = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 500));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const boxes = g.children.filter((c) => c.name?.startsWith('Box'));
		const a = boxes[0];
		const b = boxes[1];
		a.position.set(0, 1, 0);
		b.position.set(4, 1, 0);
		a.updateMatrixWorld(true);
		b.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
		return { a: a?.uuid ?? null, b: b?.uuid ?? null, count: boxes.length };
	});
	h.check(!!ids.a && !!ids.b, `two boxes created (${ids.count})`);
	await A.page.evaluate(() =>
		window.__stores.snapping.snapTargets.update((v) => ({
			...v,
			enabled: true,
			vertex: true,
			face: false,
			surface: false,
			object: false,
			radiusPx: 40
		}))
	);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(600);
	const synth = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		let controls = null;
		let camera = null;
		let g = null;
		let scene = null;
		w.TControls.subscribe((v) => (controls = v))();
		w.globalCamera.subscribe((v) => (camera = v))();
		w.objectsGroup.subscribe((v) => (g = v))();
		w.globalScene.subscribe((v) => (scene = v))();
		const boxA = g.getObjectByProperty('uuid', a);
		if (!controls || controls.object !== boxA) return { attached: false };
		const corner = new w.THREE.Vector3(3, 2, 1);
		// aim just INSIDE the front (+z) face so the hit triangle contains the corner
		const aim = new w.THREE.Vector3(3.03, 1.97, 1).project(camera);
		const px = [(aim.x * 0.5 + 0.5) * window.innerWidth, (-aim.y * 0.5 + 0.5) * window.innerHeight];
		w.snapEngine.setSnapPointer(px[0], px[1]);
		controls.dragging = true;
		controls.dispatchEvent({ type: 'dragging-changed', value: true });
		boxA.position.x += 0.5;
		boxA.updateMatrixWorld(true);
		controls.dispatchEvent({ type: 'change' });
		let candidate = null;
		w.snapEngine.activeSnapCandidate.subscribe((v) => (candidate = v))();
		const box = new w.THREE.Box3().setFromObject(boxA);
		const anchor = box.clampPoint(corner, new w.THREE.Vector3());
		const marker = scene.getObjectByName('snap-candidate-marker');
		const during = {
			attached: true,
			type: candidate?.type ?? null,
			candidatePoint: candidate ? candidate.point.toArray() : null,
			anchorDist: anchor.distanceTo(corner),
			markerVisible: !!marker?.visible
		};
		controls.dragging = false;
		controls.dispatchEvent({ type: 'dragging-changed', value: false });
		let after = null;
		w.snapEngine.activeSnapCandidate.subscribe((v) => (after = v))();
		return { during, afterNull: after === null, markerAfter: !!marker?.visible };
	}, ids);
	h.check(synth.during?.attached === true, 'the gizmo is attached to box A');
	h.check(synth.during?.type === 'vertex', `the vertex candidate wins (${synth.during?.type})`);
	h.check(
		!!synth.during?.candidatePoint &&
			Math.hypot(
				synth.during.candidatePoint[0] - 3,
				synth.during.candidatePoint[1] - 2,
				synth.during.candidatePoint[2] - 1
			) < 1e-3,
		`the candidate IS box B's corner (${synth.during?.candidatePoint?.map((v) => v.toFixed(3))})`
	);
	h.check(
		synth.during?.anchorDist < 1e-3,
		`the clamped 'auto' anchor lands ON the corner (dist ${synth.during?.anchorDist})`
	);
	h.check(synth.during?.markerVisible === true, 'the candidate marker is visible during the drag');
	h.check(
		synth.afterNull === true && synth.markerAfter === false,
		'drag end clears the candidate and hides the marker'
	);

	// ---------- 6. real-mouse gizmo drag: element snap OVERRIDES the grid ----------
	// The target corner must stay OUTSIDE the dragged box on an axis the gizmo
	// does not drive: an X-arrow drag has parallax (the pointer ray meets the
	// axis plane deeper than the face it points at), so the drag can carry A far
	// enough to ENGULF a same-height corner — and clamping to a point INSIDE the
	// box is a no-op, which made the first version of this check pass vacuously.
	// B becomes TALL (y-scale 2) with its top-front corner at (3.13, 3.63, 1):
	// the corner is above A's box whatever X does, so the snap must LIFT A —
	// off the 0.5 lattice in Y, which the X-drag never touches. Grid snap is ON.
	await A.page.evaluate(
		({ a, b }) => {
			const w = window.__stores;
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			const boxB = g.getObjectByProperty('uuid', b);
			boxA.position.set(0, 1, 0);
			boxB.position.set(4.13, 1.63, 0);
			boxB.scale.set(1, 2, 1); // 2x4x2 — box y in [-0.37, 3.63]
			boxA.updateMatrixWorld(true);
			boxB.updateMatrixWorld(true);
			w.objectsGroup.update((v) => v);
			w.snapping.snapEnabled.set(true);
			w.snapping.snapSettings.set({ translate: 0.5, rotateDeg: 15, scale: 0.1 });
			w.snapping.snapTargets.update((v) => ({ ...v, vertex: true, radiusPx: 40 }));
			// record every candidate the REAL drag produces (mid-drag state is
			// unreachable from outside the page)
			window.__snapSamples = [];
			w.snapEngine.activeSnapCandidate.subscribe(
				(v) => v && window.__snapSamples.push(v.type + '@' + v.point.toArray().map((n) => n.toFixed(2)).join(','))
			);
		},
		ids
	);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(600);
	const arrow = await findXArrowGrip(A.page);
	h.check(!!arrow, 'found a grip that hovers the gizmo +X arrow');
	if (arrow) {
		// aim just inside B's front face at its top-front corner (3.13, 3.63, 1)
		const aimPx = await A.page.evaluate(() => {
			let camera = null;
			window.__stores.globalCamera.subscribe((v) => (camera = v))();
			const v = new window.__stores.THREE.Vector3(3.23, 3.45, 1).project(camera);
			return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
		});
		await A.page.mouse.move(arrow[0], arrow[1]);
		await A.page.mouse.down();
		// premise check (the lore: a synthesized grip must start the gesture it
		// means to) — the press must have armed the X axis, not the XYZ center
		const axis = await A.page.evaluate(
			() => new Promise((r) => window.__stores.TControls.subscribe((c) => r(c?.axis))())
		);
		h.check(axis === 'X', `the press grabbed the X arrow (axis=${axis})`);
		await A.page.mouse.move(aimPx[0], aimPx[1], { steps: 14 });
		await A.page.waitForTimeout(120); // one more search tick with the pointer at rest
		await A.page.mouse.move(aimPx[0], aimPx[1] + 1);
		await A.page.mouse.up();
		await A.page.waitForTimeout(400);
		const final = await A.page.evaluate(
			({ a }) => {
				const w = window.__stores;
				let g = null;
				w.objectsGroup.subscribe((v) => (g = v))();
				const boxA = g.getObjectByProperty('uuid', a);
				const box = new w.THREE.Box3().setFromObject(boxA);
				let candidate = null;
				w.snapEngine.activeSnapCandidate.subscribe((v) => (candidate = v))();
				return {
					y: boxA.position.y,
					boxMaxY: box.max.y,
					samples: window.__snapSamples ?? [],
					candidateCleared: candidate === null
				};
			},
			ids
		);
		h.check(
			final.samples.some((s) => s.startsWith('vertex@3.13,3.63,1.00')),
			`REAL drag: a vertex candidate at B's corner was live (${final.samples.slice(-3)})`
		);
		h.check(
			Math.abs(final.boxMaxY - 3.63) < 1e-3,
			`REAL drag: A's box top rests exactly on the corner (${final.boxMaxY.toFixed(4)})`
		);
		h.check(
			Math.abs(final.y - 2.63) < 1e-3,
			`REAL drag: the snap LIFTED A off the 0.5 lattice — element overrode grid (y = ${final.y.toFixed(4)})`
		);
		h.check(final.candidateCleared, 'the candidate is cleared after the real drag too');
	}

	// ---------- 7. defaults are inert ----------
	const inert = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		w.snapping.snapTargets.update((v) => ({
			...v,
			vertex: false,
			edge: false,
			face: false,
			surface: false,
			object: false
		}));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		return w.snapEngine.maybeSnapGizmo(g.getObjectByProperty('uuid', a));
	}, ids);
	h.check(inert === false, 'with every target off, the engine declines (defaults byte-identical)');

	// ---------- 8. P3: the transient snap anchor ----------
	// Pick a VERTEX anchor on A with a real click, drag the re-seated gizmo
	// (through the REAL multiTransform handlers), and assert the PICKED point
	// lands on B's corner — while userData.origin stays absent and nothing but
	// 'move' broadcasts (the locked "local-only, never replicated" fork).
	await A.page.evaluate(
		({ a, b }) => {
			const w = window.__stores;
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			const boxB = g.getObjectByProperty('uuid', b);
			boxA.position.set(0, 1, 0);
			boxB.position.set(4.13, 1.63, 0); // tall B from section 6, corner (3.13, 3.63, 1)
			boxA.updateMatrixWorld(true);
			boxB.updateMatrixWorld(true);
			w.objectsGroup.update((v) => v);
			w.snapping.snapEnabled.set(false);
			w.snapping.snapTargets.update((v) => ({ ...v, vertex: true, radiusPx: 40 }));
			// record every outgoing message type from here on
			let p = null;
			w.peers.subscribe((v) => (p = v))();
			window.__sentTypes = [];
			const orig = p.send.bind(p);
			p.send = (m) => {
				window.__sentTypes.push(m?.type);
				return orig(m);
			};
		},
		ids
	);
	// a CHANGED primary is what resets the anchor lifecycle — cycle B → A
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.b);
	await A.page.waitForTimeout(200);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(500);
	const armed = await A.page.evaluate(() => window.__stores.snapEngine.startSnapAnchorPick());
	h.check(armed === true, 'pick mode arms with one selected object');
	// REAL click just inside A's front face at its corner (1, 2, 1)
	const pickPx = await A.page.evaluate(() => {
		let camera = null;
		window.__stores.globalCamera.subscribe((v) => (camera = v))();
		const v = new window.__stores.THREE.Vector3(0.94, 1.94, 1).project(camera);
		return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
	});
	await A.page.mouse.click(pickPx[0], pickPx[1]);
	await A.page.waitForTimeout(400);
	const picked = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		let anchor = null;
		let picking = null;
		let controls = null;
		let pivotOnly = null;
		let scene = null;
		w.snapEngine.snapAnchor.subscribe((v) => (anchor = v))();
		w.snapEngine.snapAnchorPicking.subscribe((v) => (picking = v))();
		w.TControls.subscribe((v) => (controls = v))();
		w.multiTransform.pivotOnly.subscribe((v) => (pivotOnly = v))();
		w.globalScene.subscribe((v) => (scene = v))();
		return {
			picking,
			mode: anchor?.mode,
			uuid: anchor?.uuid,
			local: anchor?.local,
			gizmoIsPivot: !!controls?.object?.userData?.isMultiPivot,
			pivotPos: controls?.object?.position?.toArray?.() ?? null,
			pivotOnly,
			anchorUuidIsA: anchor?.uuid === a,
			markerVisible: !!scene.getObjectByName('snap-anchor-marker')?.visible
		};
	}, ids);
	h.check(picked.picking === false, 'the click exits pick mode');
	h.check(
		picked.mode === 'picked' && picked.anchorUuidIsA,
		`a picked anchor exists on A (${picked.mode})`
	);
	h.check(
		!!picked.local &&
			Math.hypot(picked.local[0] - 1, picked.local[1] - 1, picked.local[2] - 1) < 1e-3,
		`the corner won as a VERTEX anchor, stored LOCAL (${picked.local?.map((v) => v.toFixed(3))})`
	);
	h.check(
		picked.gizmoIsPivot &&
			!!picked.pivotPos &&
			Math.hypot(picked.pivotPos[0] - 1, picked.pivotPos[1] - 2, picked.pivotPos[2] - 1) < 1e-3,
		`the gizmo RE-SEATED on the picked point (${picked.pivotPos?.map((v) => v.toFixed(3))})`
	);
	h.check(picked.pivotOnly === false, 'reseat invariant 1: pivotOnly untouched (drags move the OBJECT)');
	h.check(picked.markerVisible === true, 'the anchor marker renders at the picked point');
	// drag the pivot through the REAL multiTransform handlers
	const anchorDrag = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		let controls = null;
		let camera = null;
		let g = null;
		w.TControls.subscribe((v) => (controls = v))();
		w.globalCamera.subscribe((v) => (camera = v))();
		w.objectsGroup.subscribe((v) => (g = v))();
		const boxA = g.getObjectByProperty('uuid', a);
		const preDrag = boxA.position.toArray();
		// aim just inside tall B's front face at its top corner (3.13, 3.63, 1)
		const aim = new w.THREE.Vector3(3.2, 3.5, 1).project(camera);
		w.snapEngine.setSnapPointer(
			(aim.x * 0.5 + 0.5) * window.innerWidth,
			(-aim.y * 0.5 + 0.5) * window.innerHeight
		);
		controls.dragging = true;
		controls.dispatchEvent({ type: 'dragging-changed', value: true });
		controls.object.position.x += 0.5;
		controls.dispatchEvent({ type: 'objectChange' });
		// the picked point in WORLD space after the snap
		boxA.updateMatrixWorld(true);
		const pickedWorld = new w.THREE.Vector3(1, 1, 1).applyMatrix4(boxA.matrixWorld);
		controls.dragging = false;
		controls.dispatchEvent({ type: 'dragging-changed', value: false });
		return {
			preDrag,
			pickedWorld: pickedWorld.toArray(),
			postDrag: boxA.position.toArray(),
			origin: boxA.userData?.origin ?? null,
			sent: [...new Set(window.__sentTypes)]
		};
	}, ids);
	h.check(
		Math.hypot(
			anchorDrag.pickedWorld[0] - 3.13,
			anchorDrag.pickedWorld[1] - 3.63,
			anchorDrag.pickedWorld[2] - 1
		) < 1e-3,
		`the PICKED point lands on B's corner (${anchorDrag.pickedWorld.map((v) => v.toFixed(3))})`
	);
	h.check(anchorDrag.origin === null, 'userData.origin stays ABSENT — the anchor never became a real origin');
	h.check(
		anchorDrag.sent.includes('move') && !anchorDrag.sent.includes('objectParameters'),
		`only normal move broadcasts left the machine (${anchorDrag.sent.join(',')})`
	);
	// one undo entry reverts the whole snap drag (the property, not the count)
	const undone = await A.page.evaluate(
		({ a, preDrag }) => {
			const w = window.__stores;
			w.history.undo();
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const p = g.getObjectByProperty('uuid', a).position.toArray();
			w.history.redo();
			return Math.hypot(p[0] - preDrag[0], p[1] - preDrag[1], p[2] - preDrag[2]);
		},
		{ a: ids.a, preDrag: anchorDrag.preDrag }
	);
	h.check(undone < 1e-6, `ONE undo reverts the whole anchor drag (delta ${undone})`);
	// clear: the gizmo must come BACK to the object (reseat invariant 2)
	const cleared = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		w.snapEngine.clearSnapAnchor();
		let controls = null;
		let anchor = null;
		let scene = null;
		w.TControls.subscribe((v) => (controls = v))();
		w.snapEngine.snapAnchor.subscribe((v) => (anchor = v))();
		w.globalScene.subscribe((v) => (scene = v))();
		return {
			mode: anchor?.mode,
			gizmoOnObject: controls?.object?.uuid === a,
			markerVisible: !!scene.getObjectByName('snap-anchor-marker')?.visible
		};
	}, ids);
	h.check(cleared.mode === 'auto', 'clear resets the anchor store');
	h.check(
		cleared.gizmoOnObject === true,
		'reseat invariant 2: clearing ALWAYS leaves a gizmo — it comes back to the object'
	);
	await A.page.waitForTimeout(300);
	const markerGone = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalScene.subscribe((s) =>
					r(!!s.getObjectByName('snap-anchor-marker')?.visible)
				)()
			)
	);
	h.check(markerGone === false, 'the anchor marker hides after clear');
	// lifecycle: a NEW primary selection drops a picked anchor. A moved during
	// the drag, so put it back FIRST — pickPx aims at its original corner
	// (re-identifying a moved target by its old pixel was the first bug here)
	await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const boxA = g.getObjectByProperty('uuid', a);
		boxA.position.set(0, 1, 0);
		boxA.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
	}, ids);
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.snapEngine.startSnapAnchorPick());
	await A.page.mouse.click(pickPx[0], pickPx[1]);
	await A.page.waitForTimeout(300);
	const lifecycle = await A.page.evaluate(({ b }) => {
		const w = window.__stores;
		let anchor = null;
		w.snapEngine.snapAnchor.subscribe((v) => (anchor = v))();
		const rePicked = anchor?.mode === 'picked';
		w.objectActions.selectObject(b);
		w.snapEngine.snapAnchor.subscribe((v) => (anchor = v))();
		let controls = null;
		w.TControls.subscribe((v) => (controls = v))();
		return { rePicked, modeAfter: anchor?.mode, gizmoOnB: controls?.object?.uuid === b };
	}, ids);
	h.check(lifecycle.rePicked, 'a second pick works after clearing');
	h.check(
		lifecycle.modeAfter === 'auto' && lifecycle.gizmoOnB,
		'a fresh primary selection drops the anchor AND the transient pivot (gizmo on the new object)'
	);
	// Esc leaves pick mode
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => window.__stores.snapEngine.startSnapAnchorPick());
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	const escd = await A.page.evaluate(
		() => new Promise((r) => window.__stores.snapEngine.snapAnchorPicking.subscribe((v) => r(v))())
	);
	h.check(escd === false, 'Escape cancels pick mode');
	// a miss exits pick mode without picking (synthetic sky ray)
	const missed = await A.page.evaluate(() => {
		const w = window.__stores;
		w.snapEngine.snapAnchorPicking.set(true);
		let camera = null;
		w.globalCamera.subscribe((v) => (camera = v))();
		const ray = new w.THREE.Raycaster();
		ray.setFromCamera(new w.THREE.Vector2(0, 0.95), camera); // the sky
		const tookAnchor = w.snapEngine.snapAnchorClick(ray, [10, 10]);
		let picking = null;
		let anchor = null;
		w.snapEngine.snapAnchorPicking.subscribe((v) => (picking = v))();
		w.snapEngine.snapAnchor.subscribe((v) => (anchor = v))();
		return { tookAnchor, picking, mode: anchor?.mode };
	});
	h.check(
		missed.tookAnchor === false && missed.picking === false && missed.mode === 'auto',
		'a miss exits pick mode without an anchor'
	);
	// the Inspector anchor row
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(500);
	const anchorUi = await A.page.evaluate(() => ({
		auto: !!document.querySelector('#snap-anchor-auto'),
		pivot: !!document.querySelector('#snap-anchor-pivot'),
		pick: !!document.querySelector('#snap-anchor-pick')
	}));
	h.check(anchorUi.auto && anchorUi.pivot && anchorUi.pick, 'the Snap origin row renders (Auto | Pivot | Pick)');
	await A.page.evaluate(() => document.querySelector('#snap-anchor-pivot').click());
	await A.page.waitForTimeout(200);
	t = await targets(A.page);
	h.check(t.anchorMode === 'pivot', 'the Pivot chip writes the anchorMode preference');
	await A.page.evaluate(() => document.querySelector('#snap-anchor-auto').click());
	await A.page.waitForTimeout(200);
	// close the sidebar again — sections 9-11 want the bare viewport (and section
	// 11 presses a bare key, which a focused panel widget could swallow)
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(300);

	// ---------- 9. P4: align to normal ----------
	// A RAMP: a 2x2x2 box rotated 30° about Z, so its top face normal is
	// (-sin30, cos30, 0) — a direction NO axis-aligned box has, which is what
	// makes "the object turned onto the surface" measurable at all. The editor
	// camera sits at (-10, 10, 10), so that top face is the one it looks at, and
	// the ramp is parked at x = -4 where the aim ray passes nothing else.
	const ramp = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 500));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const boxes = g.children.filter((c) => c.name?.startsWith('Box'));
		const r = boxes[boxes.length - 1];
		r.position.set(-4, 1, 0);
		r.rotation.set(0, 0, Math.PI / 6);
		r.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
		// the top face centre in WORLD space + the normal it must hand out
		const n = new w.THREE.Vector3(-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0);
		const top = r.position.clone().add(n);
		return { uuid: r.uuid, normal: n.toArray(), top: top.toArray() };
	});
	h.check(!!ramp.uuid, 'a 30°-tilted ramp exists to align against');
	await A.page.evaluate(
		({ a }) => {
			const w = window.__stores;
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			boxA.position.set(0, 1, 0);
			// a NON-identity base rotation: restoring identity would be a weaker
			// check, and `align × base` must still map +Y onto the normal exactly
			boxA.rotation.set(0, 0.3, 0);
			boxA.updateMatrixWorld(true);
			w.objectsGroup.update((v) => v);
			w.snapping.snapEnabled.set(false);
			w.snapping.snapTargets.update((v) => ({
				...v,
				enabled: true,
				vertex: false,
				face: false,
				surface: true,
				object: false,
				alignNormal: true,
				radiusPx: 40
			}));
		},
		ids
	);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(600);
	const aligned = await A.page.evaluate(
		({ a, top }) => {
			const w = window.__stores;
			let controls = null;
			let camera = null;
			let g = null;
			w.TControls.subscribe((v) => (controls = v))();
			w.globalCamera.subscribe((v) => (camera = v))();
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			if (!controls || controls.object !== boxA) return { attached: false };
			const preDrag = boxA.quaternion.toArray();
			const aim = new w.THREE.Vector3(top[0], top[1], top[2]).project(camera);
			w.snapEngine.setSnapPointer(
				(aim.x * 0.5 + 0.5) * window.innerWidth,
				(-aim.y * 0.5 + 0.5) * window.innerHeight
			);
			controls.dragging = true;
			controls.dispatchEvent({ type: 'dragging-changed', value: true });
			boxA.position.x -= 0.5;
			boxA.updateMatrixWorld(true);
			// Scene binds `change` (onchange) — that is the plain-object hook
			controls.dispatchEvent({ type: 'change' });
			let candidate = null;
			w.snapEngine.activeSnapCandidate.subscribe((v) => (candidate = v))();
			const first = boxA.quaternion.toArray();
			const up = new w.THREE.Vector3(0, 1, 0).applyQuaternion(boxA.quaternion);
			// COMPOUNDING guard: every invariant a rotation preserves is preserved by
			// a WRONG rotation too, so measure the thing an accumulating multiply
			// changes — five more identical frames must not move the quaternion
			for (let i = 0; i < 5; i++) controls.dispatchEvent({ type: 'change' });
			const repeated = boxA.quaternion.toArray();
			return {
				attached: true,
				preDrag,
				type: candidate?.type ?? null,
				normal: candidate?.normal ? candidate.normal.toArray() : null,
				up: up.toArray(),
				drift: Math.max(...first.map((v, i) => Math.abs(v - repeated[i])))
			};
		},
		{ a: ids.a, top: ramp.top }
	);
	h.check(aligned.attached === true, 'the gizmo is attached to box A for the align drag');
	h.check(
		aligned.type === 'surface' &&
			!!aligned.normal &&
			Math.hypot(
				aligned.normal[0] - ramp.normal[0],
				aligned.normal[1] - ramp.normal[1],
				aligned.normal[2] - ramp.normal[2]
			) < 1e-3,
		`the candidate is the tilted top face (${aligned.type}, n = ${aligned.normal?.map((v) => v.toFixed(4))})`
	);
	h.check(
		!!aligned.up &&
			Math.hypot(
				aligned.up[0] - ramp.normal[0],
				aligned.up[1] - ramp.normal[1],
				aligned.up[2] - ramp.normal[2]
			) < 1e-3,
		`A's own +Y now points along the surface normal (${aligned.up?.map((v) => v.toFixed(4))})`
	);
	h.check(
		aligned.drift < 1e-9,
		`five more frames on the same candidate change NOTHING — no compounding (drift ${aligned.drift})`
	);
	// losing the candidate must put the base rotation back EXACTLY: a translate
	// drag never rewrites rotation, so the restore has to be explicit. Park A in
	// the sky so BOTH rays miss (the cursor ray AND the anchor-projection
	// fallback, which would otherwise find the ramp again through A's own point).
	await A.page.evaluate(
		({ a }) => {
			const w = window.__stores;
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			boxA.position.set(0, 60, 0);
			boxA.updateMatrixWorld(true);
			w.snapEngine.setSnapPointer(30, 8); // top-left of the viewport = sky
		},
		ids
	);
	await A.page.waitForTimeout(120); // past the 33ms search throttle
	const restored = await A.page.evaluate(
		({ a, preDrag }) => {
			const w = window.__stores;
			let controls = null;
			let g = null;
			w.TControls.subscribe((v) => (controls = v))();
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			controls.dispatchEvent({ type: 'change' });
			let candidate = null;
			w.snapEngine.activeSnapCandidate.subscribe((v) => (candidate = v))();
			const now = boxA.quaternion.toArray();
			controls.dragging = false;
			controls.dispatchEvent({ type: 'dragging-changed', value: false });
			return {
				candidateNull: candidate === null,
				delta: Math.max(...now.map((v, i) => Math.abs(v - preDrag[i])))
			};
		},
		{ a: ids.a, preDrag: aligned.preDrag }
	);
	h.check(restored.candidateNull === true, 'aiming at the sky drops the candidate');
	h.check(
		restored.delta < 1e-9,
		`losing the candidate restores the pre-drag rotation component-wise (max delta ${restored.delta})`
	);

	// ---------- 10. P4: the face tint ----------
	await A.page.evaluate(
		({ a, b }) => {
			const w = window.__stores;
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			const boxB = g.getObjectByProperty('uuid', b);
			boxA.position.set(0, 1, 0);
			boxA.rotation.set(0, 0, 0);
			boxB.position.set(4, 1, 0);
			boxB.scale.set(1, 1, 1);
			boxA.updateMatrixWorld(true);
			boxB.updateMatrixWorld(true);
			w.objectsGroup.update((v) => v);
			w.snapping.snapTargets.update((v) => ({
				...v,
				vertex: false,
				face: true,
				surface: false,
				object: false,
				alignNormal: false,
				radiusPx: 200
			}));
		},
		ids
	);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(600);
	const tint = await A.page.evaluate(
		({ a }) => {
			const w = window.__stores;
			let controls = null;
			let camera = null;
			let g = null;
			let scene = null;
			w.TControls.subscribe((v) => (controls = v))();
			w.globalCamera.subscribe((v) => (camera = v))();
			w.objectsGroup.subscribe((v) => (g = v))();
			w.globalScene.subscribe((v) => (scene = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			if (!controls || controls.object !== boxA) return { attached: false };
			// a point on B's front (+z) face
			const aim = new w.THREE.Vector3(3.5, 1.5, 1).project(camera);
			w.snapEngine.setSnapPointer(
				(aim.x * 0.5 + 0.5) * window.innerWidth,
				(-aim.y * 0.5 + 0.5) * window.innerHeight
			);
			controls.dragging = true;
			controls.dispatchEvent({ type: 'dragging-changed', value: true });
			boxA.position.x += 0.5;
			boxA.updateMatrixWorld(true);
			controls.dispatchEvent({ type: 'change' });
			let candidate = null;
			w.snapEngine.activeSnapCandidate.subscribe((v) => (candidate = v))();
			const mesh = scene.getObjectByName('snap-candidate-face');
			const during = {
				attached: true,
				type: candidate?.type ?? null,
				exists: !!mesh,
				visible: !!mesh?.visible,
				verts: mesh?.geometry?.attributes?.position?.count ?? 0,
				atSceneRoot: mesh?.parent === scene
			};
			controls.dragging = false;
			controls.dispatchEvent({ type: 'dragging-changed', value: false });
			return { during, hiddenAfter: !scene.getObjectByName('snap-candidate-face')?.visible };
		},
		ids
	);
	h.check(tint.during?.type === 'face', `a face candidate is live (${tint.during?.type})`);
	h.check(
		tint.during?.exists === true && tint.during?.atSceneRoot === true,
		'the tint mesh "snap-candidate-face" lives at the SCENE ROOT (never in objectsGroup)'
	);
	h.check(tint.during?.visible === true, 'the tint is visible while a face candidate is live');
	h.check(
		tint.during?.verts >= 3,
		`the tint carries the face's own triangles (${tint.during?.verts} vertices)`
	);
	h.check(tint.hiddenAfter === true, 'the tint hides when the drag ends');

	// ---------- 11. P4: the M shortcut ----------
	await A.page.keyboard.press('Escape');
	await A.page.evaluate(() => document.activeElement?.blur?.());
	await A.page.waitForTimeout(200);
	const before = (await targets(A.page)).enabled;
	await A.page.keyboard.press('m');
	await A.page.waitForTimeout(250);
	const afterFirst = (await targets(A.page)).enabled;
	await A.page.keyboard.press('m');
	await A.page.waitForTimeout(250);
	const afterSecond = (await targets(A.page)).enabled;
	h.check(afterFirst === !before, `M toggles element snapping (${before} → ${afterFirst})`);
	h.check(afterSecond === before, `M toggles it back (${afterFirst} → ${afterSecond})`);
	const listed = await A.page.evaluate(() =>
		window.__stores.shortcutsRegistry.shortcuts.some(
			(s) => s.keys === 'M' && /element snapping/i.test(s.label)
		)
	);
	h.check(listed === true, 'the M binding is in the registry, so Settings ▸ Shortcuts lists it');

	// ---------- 12. P5: the edge target ----------
	// Fresh box B: its front face is two coplanar triangles, so the face DIAGONAL
	// passes through the face centre — the exact adversarial input for the
	// diagonal skip (aim at the centre: a broken skip snaps to the diagonal AT
	// the cursor, the working one reaches out to a boundary edge ~1 world unit
	// away — the counterfactual is computable, not assumed).
	await A.page.evaluate(
		({ a, b }) => {
			const w = window.__stores;
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			const boxB = g.getObjectByProperty('uuid', b);
			boxA.position.set(0, 1, 0);
			boxA.rotation.set(0, 0, 0);
			boxB.position.set(4, 1, 0);
			boxB.scale.set(1, 1, 1);
			boxA.updateMatrixWorld(true);
			boxB.updateMatrixWorld(true);
			w.objectsGroup.update((v) => v);
			w.snapping.snapTargets.update((v) => ({
				...v,
				enabled: true,
				vertex: false,
				edge: true,
				face: false,
				surface: false,
				object: false,
				alignNormal: false,
				radiusPx: 99
			}));
		},
		ids
	);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(600);
	const edges = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		let controls = null;
		let camera = null;
		let g = null;
		w.TControls.subscribe((v) => (controls = v))();
		w.globalCamera.subscribe((v) => (camera = v))();
		w.objectsGroup.subscribe((v) => (g = v))();
		const boxA = g.getObjectByProperty('uuid', a);
		if (!controls || controls.object !== boxA) return { attached: false };
		const aimAt = (/** @type {number[]} */ p) => {
			const v = new w.THREE.Vector3(p[0], p[1], p[2]).project(camera);
			w.snapEngine.setSnapPointer(
				(v.x * 0.5 + 0.5) * window.innerWidth,
				(-v.y * 0.5 + 0.5) * window.innerHeight
			);
		};
		const search = () =>
			new Promise((r) => {
				// past the 33ms throttle, then one change event runs the search
				setTimeout(() => {
					controls.dispatchEvent({ type: 'change' });
					let candidate = null;
					w.snapEngine.activeSnapCandidate.subscribe((v) => (candidate = v))();
					r(candidate ? { type: candidate.type, point: candidate.point.toArray() } : null);
				}, 60);
			});
		controls.dragging = true;
		controls.dispatchEvent({ type: 'dragging-changed', value: true });
		boxA.position.x += 0.25;
		boxA.updateMatrixWorld(true);
		return (async () => {
			// (1) near the top edge, OFF centre: the sliding closest point
			aimAt([3.55, 1.9, 1]);
			const slide = await search();
			// (2) near the top edge MIDPOINT: the bonus pulls it onto (4, 2, 1)
			aimAt([4.0, 1.92, 1]);
			const mid = await search();
			// (3) the ADVERSARIAL centre aim: the diagonal passes right here — a
			// broken skip returns a point at the centre, the fix reaches the boundary
			aimAt([4.0, 1.0, 1]);
			const centre = await search();
			controls.dragging = false;
			controls.dispatchEvent({ type: 'dragging-changed', value: false });
			return { attached: true, slide, mid, centre };
		})();
	}, ids);
	h.check(edges.attached === true, 'the gizmo is attached for the edge drag');
	h.check(
		edges.slide?.type === 'edge' &&
			Math.abs(edges.slide.point[1] - 2) < 1e-3 &&
			Math.abs(edges.slide.point[2] - 1) < 1e-3 &&
			edges.slide.point[0] > 3 &&
			edges.slide.point[0] < 5,
		`an off-centre aim slides along the top edge (${edges.slide?.point?.map((v) => v.toFixed(3))})`
	);
	h.check(
		edges.mid?.type === 'edge' &&
			Math.hypot(edges.mid.point[0] - 4, edges.mid.point[1] - 2, edges.mid.point[2] - 1) < 0.05,
		`near the middle, the MIDPOINT bonus wins (${edges.mid?.point?.map((v) => v.toFixed(3))})`
	);
	const boundaryDist = edges.centre
		? Math.min(
				Math.abs(edges.centre.point[0] - 3),
				Math.abs(edges.centre.point[0] - 5),
				Math.abs(edges.centre.point[1] - 0),
				Math.abs(edges.centre.point[1] - 2)
			)
		: 9;
	h.check(
		edges.centre?.type === 'edge' && boundaryDist < 1e-3,
		`a face-centre aim skips the DIAGONAL and lands on a boundary edge (${edges.centre?.point?.map((v) => v.toFixed(3))})`
	);
	// the Edge chip is in both UIs now
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(500);
	const edgeChip = await A.page.evaluate(() => !!document.querySelector('#snap-target-edge'));
	h.check(edgeChip, 'the Edge chip renders in Configure Scene ▸ Snapping');

	// ---------- 13. anchor UX: armed state, sticky instruction, save-as-origin ----------
	// (the Configure Scene panel is OPEN from the check above — these read its DOM)
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(400);
	// ARMED: the pick button changes colour and the status line says "Selecting…"
	await A.page.evaluate(() => document.querySelector('#snap-anchor-pick').click());
	await A.page.waitForTimeout(300);
	const armedUi = await A.page.evaluate(() => {
		const pick = document.querySelector('#snap-anchor-pick');
		const status = document.querySelector('.snap-status');
		const text = status?.querySelector('.snap-status-text');
		return {
			// the COMPUTED colour, never the class string (the documented lesson —
			// the class was right the whole time in the toolbox bug)
			bg: pick ? getComputedStyle(pick).backgroundColor : null,
			pressed: pick?.getAttribute('aria-pressed'),
			statusText: text?.textContent?.trim() ?? null,
			statusColor: text ? getComputedStyle(text).color : null,
			hasCancel: !!document.querySelector('#snap-anchor-cancel')
		};
	});
	h.check(
		armedUi.bg === 'rgb(217, 119, 6)',
		`the armed pick button is amber, not the accent (${armedUi.bg})`
	);
	h.check(armedUi.pressed === 'true', 'the armed button reports aria-pressed');
	h.check(armedUi.statusText === 'Selecting…', `the status line reads "Selecting…" (${armedUi.statusText})`);
	h.check(
		armedUi.statusColor === 'rgb(251, 191, 36)',
		`and it is yellow (${armedUi.statusColor})`
	);
	h.check(armedUi.hasCancel, 'a ✕ cancels the selecting mode');
	const toastUp = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.toastStore.subscribe((list) =>
					r((list ?? []).some((e) => e && e.id === 'snap-anchor-pick' && e.sticky))
				)()
			)
	);
	h.check(toastUp === true, 'the instruction toast is STICKY, so it cannot time out mid-aim');
	// the ✕ leaves the mode AND takes the toast with it
	await A.page.evaluate(() => document.querySelector('#snap-anchor-cancel').click());
	await A.page.waitForTimeout(300);
	const cancelled = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let picking = null;
				window.__stores.snapEngine.snapAnchorPicking.subscribe((v) => (picking = v))();
				window.__stores.toastStore.subscribe((list) =>
					r({
						picking,
						toast: (list ?? []).some((e) => e && e.id === 'snap-anchor-pick'),
						status: !!document.querySelector('.snap-status')
					})
				)();
			})
	);
	h.check(
		cancelled.picking === false && cancelled.status === false,
		'the ✕ leaves pick mode and the status line goes'
	);
	h.check(cancelled.toast === false, 'and the instruction toast never outlives the mode');

	// SAVE AS OBJECT ORIGIN — the point survives selecting something else
	await A.page.evaluate(
		({ a }) => {
			const w = window.__stores;
			let g = null;
			w.objectsGroup.subscribe((v) => (g = v))();
			const boxA = g.getObjectByProperty('uuid', a);
			boxA.position.set(0, 1, 0);
			boxA.rotation.set(0, 0, 0);
			boxA.updateMatrixWorld(true);
			delete boxA.userData.origin; // a clean slate for the promotion
			w.objectsGroup.update((v) => v);
			w.snapping.snapTargets.update((t) => ({ ...t, anchorMode: 'auto' }));
			window.__sentTypes = [];
			let p = null;
			w.peers.subscribe((v) => (p = v))();
			const orig = p.send.bind(p);
			p.send = (m) => {
				window.__sentTypes.push(m?.type);
				return orig(m);
			};
		},
		ids
	);
	await A.page.evaluate(() => window.__stores.snapEngine.startSnapAnchorPick());
	await A.page.mouse.click(pickPx[0], pickPx[1]);
	await A.page.waitForTimeout(400);
	const beforeSave = await A.page.evaluate(
		() => !!document.querySelector('#snap-anchor-save-origin')
	);
	h.check(beforeSave, 'a picked anchor offers "Save as object origin"');
	await A.page.evaluate(() => document.querySelector('#snap-anchor-save-origin').click());
	await A.page.waitForTimeout(400);
	const saved = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		let g = null;
		let anchor = null;
		let t = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		w.snapEngine.snapAnchor.subscribe((v) => (anchor = v))();
		w.snapping.snapTargets.subscribe((v) => (t = v))();
		const boxA = g.getObjectByProperty('uuid', a);
		return {
			origin: boxA.userData?.origin ?? null,
			anchorMode: t?.anchorMode,
			mode: anchor?.mode,
			sent: [...new Set(window.__sentTypes)]
		};
	}, ids);
	h.check(
		!!saved.origin &&
			Math.hypot(saved.origin[0] - 1, saved.origin[1] - 1, saved.origin[2] - 1) < 1e-3,
		`the picked point became the object's own origin (${saved.origin})`
	);
	h.check(
		saved.sent.includes('objectParameters'),
		`saving REPLICATES it, unlike the transient anchor (${saved.sent.join(',')})`
	);
	h.check(
		saved.anchorMode === 'pivot' && saved.mode === 'auto',
		'the anchor hands over to the real origin (mode → pivot), so snapping keeps using that point'
	);
	// the whole point: select away and come back — the point is still there
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.b);
	await A.page.waitForTimeout(300);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.a);
	await A.page.waitForTimeout(400);
	const survived = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		let g = null;
		let controls = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		w.TControls.subscribe((v) => (controls = v))();
		const boxA = g.getObjectByProperty('uuid', a);
		const origin = boxA.userData?.origin ?? null;
		// 17-D: an object WITH an origin gets a pivot seated on it
		const pivot = controls?.object?.userData?.isMultiPivot ? controls.object.position.toArray() : null;
		return { origin, pivot };
	}, ids);
	h.check(
		!!survived.origin && Math.hypot(survived.origin[0] - 1, survived.origin[1] - 1, survived.origin[2] - 1) < 1e-3,
		'it SURVIVES selecting another object and coming back (the reported gap)'
	);
	h.check(
		!!survived.pivot && Math.hypot(survived.pivot[0] - 1, survived.pivot[1] - 2, survived.pivot[2] - 1) < 1e-3,
		`and the gizmo seats on it again by itself (${survived.pivot?.map((v) => v.toFixed(3))})`
	);
	// one undo takes the promotion back (it is a props entry, not a silent write)
	const undoneOrigin = await A.page.evaluate(({ a }) => {
		const w = window.__stores;
		w.history.undo();
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', a).userData?.origin ?? null;
	}, ids);
	h.check(undoneOrigin === null, 'and ONE undo takes the promotion back');
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));

	await h.finish(browser);
});
