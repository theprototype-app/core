// D7 (roadmap 13): the VR mesh-edit caps are raised (face 300->1000 tris,
// vertex 500->800) so the default sphere (960 tris / 561 verts) edits out of
// the box, AND both limits are user-editable Settings rows (localStorage).
// Over-limit attempts warn with a toast that deep-links to Settings > VR;
// a Group blocking mesh edit says "Ungroup first".
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const lastToast = () => {
			const list = read(s.toastStore);
			return list[list.length - 1];
		};
		s.commandsHandler.sceneCommand('/create sphere');
		const group = read(s.objectsGroup);
		const sphere = group.children[group.children.length - 1];

		// --- raised defaults: the default sphere edits out of the box ---
		const defaults = {
			faceCap: read(s.faceEdit.vrFaceCap),
			vertexCap: read(s.meshEdit.vrVertexCap),
			tris: s.faceEdit.triangleCount(sphere),
			verts: s.meshEdit.vertexCount(sphere),
			faceEditable: s.faceEdit.vrFaceEditable(sphere),
			vertexEditable: s.meshEdit.vrVertexEditable(sphere)
		};
		s.faceEdit.enterFaceEdit(sphere.uuid);
		const entered = read(s.faceEdit.faceEditObject) === sphere.uuid;
		s.faceEdit.exitFaceEdit();

		// --- lowering the cap blocks with a deep-linking toast ---
		s.faceEdit.vrFaceCap.set(100);
		s.faceEdit.enterFaceEdit(sphere.uuid);
		const blocked = read(s.faceEdit.faceEditObject) === null;
		const capToast = lastToast();
		let settingsAfterAction = null;
		if (capToast?.actions?.[0]) {
			capToast.actions[0].action();
			settingsAfterAction = {
				open: read(s.settingsOpen) === true,
				section: read(s.settingsSection)
			};
			s.settingsOpen.set(false);
		}

		// --- the vertex path warns through the Edit side-menu action ---
		s.meshEdit.vrVertexCap.set(50);
		s.objectActions.selectObject(sphere.uuid);
		s.vrControls.executeVRMenuAction('edit:mode:vertices');
		const vertexToast = lastToast();
		const vertexBlocked = read(s.meshEdit.editingObject) === null;

		// --- persistence ---
		const persisted = {
			face: localStorage.getItem('vrFaceCap'),
			vertex: localStorage.getItem('vrVertexCap')
		};

		// --- a Group blocker says Ungroup first ---
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		const [b1, b2] = read(s.objectsGroup).children.slice(-2);
		s.objectActions.applySelectionSet([b1.uuid, b2.uuid]);
		const grpUuid = s.objectActions.groupSelection(); // returns the group's uuid
		await new Promise((r) => setTimeout(r, 200));
		s.meshEdit.enterEditMode(grpUuid);
		const groupToast = lastToast();

		// restore defaults for later suites
		s.faceEdit.vrFaceCap.set(1000);
		s.meshEdit.vrVertexCap.set(800);

		return {
			defaults,
			entered,
			blocked,
			capToastText: capToast?.text,
			capToastHasAction: capToast?.actions?.[0]?.label,
			settingsAfterAction,
			vertexToastText: vertexToast?.text,
			vertexBlocked,
			persisted,
			groupToast
		};
	});

	h.check(
		res.defaults.faceCap === 1000 && res.defaults.vertexCap === 800,
		`default caps raised to 1000 tris / 800 verts (${res.defaults.faceCap}/${res.defaults.vertexCap})`
	);
	h.check(
		res.defaults.tris === 960 &&
			res.defaults.verts === 561 &&
			res.defaults.faceEditable &&
			res.defaults.vertexEditable,
		`the default sphere (${res.defaults.tris} tris / ${res.defaults.verts} verts) is editable out of the box`
	);
	h.check(res.entered, 'face edit actually enters on the default sphere');
	h.check(
		res.blocked &&
			/face edit limit \(960 of 100 triangles\)/.test(res.capToastText ?? '') &&
			res.capToastHasAction === 'Open Settings',
		`lowering the cap blocks with a counted, deep-linking toast (${res.capToastText})`
	);
	h.check(
		res.settingsAfterAction?.open && res.settingsAfterAction?.section === 'vr',
		'the toast action opens Settings on the VR section'
	);
	h.check(
		res.vertexBlocked && /vertex edit limit \(561 of 50 verts\)/.test(res.vertexToastText ?? ''),
		`the vertex path warns with counts too (${res.vertexToastText})`
	);
	h.check(
		res.persisted.face === '100' && res.persisted.vertex === '50',
		`cap edits persist to localStorage (${res.persisted.face}/${res.persisted.vertex})`
	);
	h.check(
		typeof res.groupToast === 'string' && res.groupToast.includes('Ungroup it first'),
		`a Group blocker says Ungroup first (${res.groupToast})`
	);

	// --- the Settings rows exist and write the stores/localStorage ---
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('vr');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForTimeout(600);
	const faceInput = A.page.locator('#vr-face-cap');
	h.check(await faceInput.isVisible(), 'Settings > VR shows the face edit limit row');
	await faceInput.fill('1200');
	await faceInput.press('Tab');
	await A.page.waitForTimeout(300);
	const applied = await A.page.evaluate(() => {
		let v;
		window.__stores.faceEdit.vrFaceCap.subscribe((x) => (v = x))();
		return { store: v, ls: localStorage.getItem('vrFaceCap') };
	});
	h.check(
		applied.store === 1200 && applied.ls === '1200',
		`editing the row updates the live cap + persists (${applied.store}/${applied.ls})`
	);

	await h.finish(browser);
});
