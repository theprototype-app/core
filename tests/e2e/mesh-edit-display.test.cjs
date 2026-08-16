// Display options in the mesh toolbox (user reports):
//  - the object SELECTION OUTLINE covered the vertices/edges being edited. It
//    is a postprocessing pass composited after the whole scene, so nothing the
//    in-scene overlays do with depthTest/renderOrder can beat it — it is now
//    suppressed while a session is open, with a Display toggle to bring it back.
//  - the edit wireframe drew every TRIANGLE edge, including the quad diagonals
//    that are deliberately NOT pickable. It draws the quad structure now, with
//    a "Show triangulation" toggle for the raw mesh.
const h = require('./helpers.cjs');

const outlineSize = (page) => page.evaluate(() => window.__outlineDebug().selected);

const wireSegments = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					let n = 0;
					g?.getObjectByProperty('uuid', window.__box.uuid)?.traverse((o) => {
						if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
					});
					r(n);
				})()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.objectActions.selectObject(window.__box.uuid);
	});
	await A.page.waitForTimeout(300);

	// ------------------------------------------------- 1. outline suppression
	const selectedOutline = await outlineSize(A.page);
	h.check(selectedOutline > 0, 'a selected object is outlined outside edit mode (premise)');

	await A.page.evaluate(() => window.__stores.faceEdit.enterFaceEdit(window.__box.uuid));
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) === 0, 'entering face edit drops the outline');

	await A.page.evaluate(() => window.__stores.faceEdit.meshEditOutline.set(true));
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) > 0, 'the Display toggle brings it back mid-session');

	await A.page.evaluate(() => window.__stores.faceEdit.meshEditOutline.set(false));
	// ---- the wireframe must never be left behind by its object -------------
	// Reported as "the wireframe detaches from the object, from time to time,
	// in different occasions". The overlay is a CHILD of the edited mesh, so it
	// follows every transform for free - which means a detach is not a posing
	// bug at all: something took the parenting away (an object swapped by a
	// remote sync / restore / undo, or a re-parent) and the orphan stayed in the
	// scene at its last pose. tickEditWireframe restores the invariant per
	// frame. The trigger is intermittent, so the guard is tested directly:
	// break the invariant on purpose and demand the next frames heal it.
	const parented = await A.page.evaluate(() => {
		let g = null;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const obj = g?.getObjectByProperty('uuid', window.__box.uuid);
		const w = obj?.children.find((c) => c.name === 'edit-overlay');
		return { found: !!w, isChild: w?.parent === obj };
	});
	h.check(parented.found && parented.isChild, 'PREMISE: the wire is a child of the edited object');

	// 1. ORPHAN it the way a re-parent would, then let the loop run
	const healed = await A.page.evaluate(async () => {
		let g = null;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', window.__box.uuid);
		const w = obj.children.find((c) => c.name === 'edit-overlay');
		let scene = null;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		scene.add(w); // three re-parents: the overlay is now loose in the scene
		const orphaned = w.parent !== obj;
		await new Promise((r) => setTimeout(r, 500)); // a few frames
		const now = obj.children.find((c) => c.name === 'edit-overlay');
		return { orphaned, reattached: !!now && now.parent === obj };
	});
	h.check(healed.orphaned, 'PREMISE: the overlay really was orphaned into the scene');
	h.check(healed.reattached, 'the per-frame guard re-parents it to the object');

	// 2. a geometry swapped BEHIND the wire's back (a swap site that forgot its
	//    refresh) must degrade to one stale frame, not a permanently wrong wire
	const rebuilt = await A.page.evaluate(async () => {
		const THREE = window.__stores.THREE;
		let g = null;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', window.__box.uuid);
		const segs = () => {
			const w = obj.children.find((c) => c.name === 'edit-overlay');
			return w ? w.geometry.attributes.position.count / 2 : -1;
		};
		const before = segs();
		const original = obj.geometry;
		// a much denser geometry, installed WITHOUT calling refreshFaceWireframe
		const probe = new THREE.SphereGeometry(1, 16, 12);
		obj.geometry = probe;
		await new Promise((r) => setTimeout(r, 500));
		const after = segs();
		// put the box back - the checks below this one measure ITS wire
		obj.geometry = original;
		await new Promise((r) => setTimeout(r, 500));
		probe.dispose();
		return { before, after, restored: segs() };
	});
	h.check(rebuilt.before > 0, `PREMISE: the wire had segments before the swap (${rebuilt.before})`);
	h.check(
		rebuilt.after !== rebuilt.before,
		`a geometry swapped behind its back rebuilds the wire (${rebuilt.before} -> ${rebuilt.after})`
	);
	h.check(
		rebuilt.restored === rebuilt.before,
		`and restoring the geometry restores the wire (${rebuilt.restored})`
	);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) > 0, 'leaving the session restores it');

	// vertex mode honours the same pref
	await A.page.evaluate(() => window.__stores.meshEdit.enterEditMode(window.__box.uuid));
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) === 0, 'vertex mode drops it too');
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await A.page.waitForTimeout(200);

	// ------------------------------------------------- 2. quad wireframe
	const wire = await A.page.evaluate(async () => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.meshEditTriWire.set(false); // quad view (the default)
		fe.enterFaceEdit(window.__box.uuid);
		const quadView = (() => {
			let n = 0;
			window.__box.traverse((o) => {
				if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
			});
			return n;
		})();
		fe.meshEditTriWire.set(true); // raw triangulation
		const triView = (() => {
			let n = 0;
			window.__box.traverse((o) => {
				if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
			});
			return n;
		})();
		fe.meshEditTriWire.set(false);
		return { quadView, triView };
	});
	// a box is 6 quads: 12 box edges, and 6 diagonals the triangulation adds
	h.check(wire.quadView === 12, 'quad view draws the 12 real box edges, no diagonals');
	h.check(wire.triView === 18, 'Show triangulation adds the 6 quad diagonals back');

	// the toggle must survive a geometry swap (the wire is rebuilt from scratch)
	const afterOp = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.pickFaceUnit(0);
		fe.commitFaceOp('extrude', 0.4);
		let n = 0;
		window.__box.traverse((o) => {
			if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
		});
		let diag = 0;
		// every drawn segment must be an edge of the quad topology
		const stray = fe.wireframeDebug();
		diag = stray.diagonals;
		return { n, diag };
	});
	h.check(afterOp.n > 12, 'an extrude adds edges to the quad wire (premise)');
	h.check(afterOp.diag === 0, '...and the rebuilt wire still draws no quad diagonals');

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ---- the wireframe must never be SAVED (user report: a scene file whose
	// object came back permanently wireframed) ------------------------------
	// The overlay is a LineSegments CHILD of the edited mesh — that is how it
	// follows the transform — so for the length of a session it sits inside the
	// serialized, replicated tree. A save taken with a session open wrote it into
	// the file as a real object: it came back as a wireframe no session owns,
	// that never updates, cannot be switched off, and ACCUMULATES on every
	// round trip (the reported file carried two on one mesh, plus an
	// `edit-overlay_1` from the name uniquifier on another).
	const overlayNames = (json) => {
		/** @type {string[]} */
		const out = [];
		const walk = (/** @type {any} */ o) => {
			if (typeof o.name === 'string' && o.name.startsWith('edit-overlay')) out.push(o.name);
			(o.children || []).forEach(walk);
		};
		walk(json.object);
		return out;
	};

	const saved = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.enterFaceEdit(window.__box.uuid);
		await new Promise((r) => setTimeout(r, 300));
		const liveBefore = window.__box.children.filter((/** @type {any} */ c) => c.name === 'edit-overlay').length;
		// the REAL save path — parkAnimatedAtBase is the ritual every serializer
		// performs, and the overlay park rides with it
		const payload = w.sessions.buildSessionPayload('overlay probe');
		const liveAfter = window.__box.children.filter((/** @type {any} */ c) => c.name === 'edit-overlay').length;
		return { liveBefore, liveAfter, objects: payload.objects };
	});
	h.check(saved.liveBefore === 1, 'the session has its wireframe up while saving (premise)');
	const inSave = saved.objects.flatMap(overlayNames);
	h.check(inSave.length === 0, `a save taken DURING a session carries no wireframe (${JSON.stringify(inSave)})`);
	h.check(saved.liveAfter === 1, '...and the live wireframe is put straight back afterwards');

	// ...and the two paths that made the reported file grow a SECOND overlay:
	// `clone(true)` copies children, and an undo snapshot is a serialize
	const copied = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.enterFaceEdit(window.__box.uuid);
		await new Promise((r) => setTimeout(r, 300));
		const copy = w.objectActions.duplicateObject(window.__box.uuid, { select: false });
		// the delete snapshot the undo entry keeps, taken with the session open
		const snapshot = w.history.captureObjectSnapshot(window.__box);
		const inSnapshot = (snapshot?.element?.object?.children ?? []).map((/** @type {any} */ c) => c.name);
		const liveStillThere = window.__box.children.filter(
			(/** @type {any} */ c) => c.name === 'edit-overlay'
		).length;
		w.faceEdit.exitFaceEdit();
		return {
			copyKids: copy ? copy.children.map((/** @type {any} */ c) => c.name) : null,
			inSnapshot,
			liveStillThere
		};
	});
	h.check(copied.copyKids?.length === 0, `duplicating the edited object copies no wireframe (${JSON.stringify(copied.copyKids)})`);
	h.check(copied.inSnapshot.length === 0, `an undo snapshot carries no wireframe (${JSON.stringify(copied.inSnapshot)})`);
	h.check(copied.liveStillThere === 1, '...and the live one is still on the object afterwards');

	// ...and a file that already contains one is HEALED on the way in, or the
	// scenes users already saved stay broken forever
	const strippedOnLoad = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		await new Promise((r) => setTimeout(r, 200));
		// hand-build the shape the reported file has: a mesh with two stale
		// overlays baked in as children
		const THREE = w.THREE;
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		mesh.name = 'stale-wire-victim';
		for (const name of ['edit-overlay', 'edit-overlay_1']) {
			// a plain BufferGeometry, like the real overlay (and like the one in
			// the reported file): ObjectLoader cannot parse a WireframeGeometry
			const line = new THREE.BufferGeometry();
			line.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
			const ghost = new THREE.LineSegments(line, new THREE.LineBasicMaterial());
			ghost.name = name;
			mesh.add(ghost);
		}
		const element = mesh.toJSON();
		const carried = element.object.children?.length ?? 0;
		await w.sessions.applySession({ objects: [element], name: 'stale' });
		await new Promise((r) => setTimeout(r, 1200));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const back = g.children.find((/** @type {any} */ c) => c.name === 'stale-wire-victim');
		return {
			carried,
			landed: !!back,
			kids: back ? back.children.map((/** @type {any} */ c) => c.name) : null
		};
	});
	h.check(strippedOnLoad.carried === 2, 'the crafted scene really has two baked overlays (premise)');
	h.check(strippedOnLoad.landed, 'the crafted object loaded');
	h.check(
		strippedOnLoad.kids?.length === 0,
		`loading a scene STRIPS a saved wireframe (${JSON.stringify(strippedOnLoad.kids)})`
	);

	await h.finish(browser);
});
