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

	await h.finish(browser);
});
