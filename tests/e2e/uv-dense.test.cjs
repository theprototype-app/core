// A GLB import showed no texture in the UV editor. Cause: the editor was gated on
// the SNAPSHOT CAP (~5000 triangles), which exists because a GEOMETRY commit must
// fit one meshgeo message - and has nothing to do with viewing a UV map or with
// PAINTING, which writes a texture and never touches geometry. Any real model is
// over that cap, so the whole editor stayed blank.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => {
		window.__stores.uvEditorClose.set(false);
		window.__stores.bottomDock.activateDock('uv');
	});
	await A.page.waitForTimeout(500);

	// a textured mesh over the cap, nested and skinned like a rigged GLB
	const built = await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const c = document.createElement('canvas');
		c.width = c.height = 16;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#ff8800';
		ctx.fillRect(0, 0, 16, 16);
		const root = new w.THREE.Group();
		root.name = 'glbRoot';
		const inner = new w.THREE.Group();
		const skinned = new w.THREE.SkinnedMesh(
			new w.THREE.SphereGeometry(1, 64, 48), // ~6000 tris, over the cap
			new w.THREE.MeshStandardMaterial({ map: new w.THREE.CanvasTexture(c) })
		);
		skinned.name = 'glbMesh';
		inner.add(skinned);
		root.add(inner);
		g.add(root);
		w.objectsGroup.update((v) => v);
		w.objectActions.selectObject(root.uuid);
		return { root: root.uuid, mesh: skinned.uuid, tris: w.faceEdit.triangleCount(skinned) };
	});
	await A.page.waitForTimeout(700);
	h.check(built.tris > 5000, `PREMISE: the model is over the snapshot cap (${built.tris} tris)`);

	const state = await A.page.evaluate(async ({ mesh }) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const target = g.getObjectByProperty('uuid', mesh);
		return {
			hasCanvas: !!document.getElementById('uv-canvas'),
			viewable: w.uvEditor.uvViewable(target).ok,
			editable: w.uvEditor.uvEditable(target).ok,
			reason: w.uvEditor.uvEditable(target).reason,
			hasImage: !!w.uvEditor.textureImageOf(target, 0),
			paintOnlyNote: !!document.getElementById('uv-paint-only'),
			resolved: w.uvEditor.meshWithUvs(g.getObjectByProperty('uuid', mesh).parent.parent)?.name
		};
	}, built);
	h.check(state.resolved === 'glbMesh', 'a nested SkinnedMesh under two Groups resolves');
	h.check(state.viewable, 'THE FIX: a dense mesh is VIEWABLE');
	h.check(!state.editable, 'premise: it is not geometry-editable (a commit could not sync)');
	h.check(state.hasCanvas, 'THE BUG: the UV canvas renders for it instead of staying blank');
	h.check(state.hasImage, "...and its texture image is available for the backdrop");
	h.check(state.paintOnlyNote, 'the topbar says "paint only" rather than silently ignoring drags');
	h.check(/still paint/i.test(state.reason), `the reason tells the user what they CAN do (${state.reason})`);

	// PAINTING must work on it - the whole point of the split - AND must paint ON
	// TOP of the model's existing texture. Reported: painting a GLB replaced its
	// texture with a white sheet, because the paint canvas seeds from mapDataUrl
	// and an IMPORTED texture has none.
	const painted = await A.page.evaluate(async ({ mesh }) => {
		const w = window.__stores;
		const opened = await w.uvEditor.beginPaintStroke(mesh, 0);
		if (!opened) return { opened: false };
		for (let i = 0; i <= 6; i++) w.uvEditor.paintMove(0.2 + i * 0.09, 0.5, '#0000ff', 32);
		const committed = w.uvEditor.endPaintStroke('#0000ff', 32);
		await new Promise((r) => setTimeout(r, 800));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const target = g.getObjectByProperty('uuid', mesh);
		const url = target.material.userData?.mapDataUrl ?? null;
		if (!url) return { opened, committed, hasUrl: false };
		// decode the commit and count the ORANGE source texture against the stroke
		const img = await new Promise((res, rej) => {
			const i = new Image();
			i.onload = () => res(i);
			i.onerror = rej;
			i.src = url;
		});
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		c.getContext('2d').drawImage(img, 0, 0);
		const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
		let orange = 0;
		let blue = 0;
		let white = 0;
		for (let i = 0; i < data.length; i += 4) {
			const [r, g2, b] = [data[i], data[i + 1], data[i + 2]];
			if (r > 200 && g2 > 100 && g2 < 190 && b < 80) orange++;
			else if (b > 150 && r < 90 && g2 < 90) blue++;
			else if (r > 230 && g2 > 230 && b > 230) white++;
		}
		return { opened, committed, hasUrl: true, size: c.width, orange, blue, white };
	}, built);
	h.check(painted.opened && painted.committed, 'THE POINT: a dense mesh can still be painted');
	h.check(painted.hasUrl, '...and the stroke commits as its texture');
	h.check(
		painted.blue > 100,
		`the stroke is in the committed image (${painted.blue} blue px of ${painted.size}px square)`
	);
	h.check(
		painted.orange > painted.white,
		`THE BUG: it painted ON TOP of the model's own texture, not over a white sheet (${painted.orange} orange vs ${painted.white} white)`
	);

	// a vertex press must NOT pretend to drag: it pans instead
	const press = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.uvEditor.uvTool.set('select');
		await new Promise((r) => setTimeout(r, 200));
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		const p = window.__uvDebug().project(0.5, 0.5);
		const opt = { clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true, pointerId: 31, pointerType: 'mouse' };
		el.dispatchEvent(new PointerEvent('pointerdown', opt));
		const mid = window.__uvDebug();
		window.dispatchEvent(new PointerEvent('pointerup', opt));
		return { gesture: mid.gesture, selected: mid.selected };
	});
	h.check(
		press.gesture === 'pan' && press.selected === 0,
		`a press on a dense mesh pans rather than faking a vertex drag (${press.gesture})`
	);

	await h.finish(browser);
});
