// Phase 216: a selected GROUP shows "Ungroup" in the VR Edit radial (Edit Mesh
// is hidden); dispatching obj:ungroup reparents the children to the group's
// parent (world transform kept) and deletes the now-empty group. A plain mesh
// shows Edit Mesh and no Ungroup. On-device feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// build a group (with its own transform) holding two boxes at distinct spots
	const setup = await A.page.evaluate(() => {
		const { commandsHandler, objectActions, THREE } = window.__stores;
		const root = () => {
			let v;
			window.__stores.objectsGroup.subscribe((x) => (v = x))();
			return v;
		};
		commandsHandler.sceneCommand('/create box');
		commandsHandler.sceneCommand('/create box');
		let r = root();
		const box1 = r.children[r.children.length - 2];
		const box2 = r.children[r.children.length - 1];
		box1.position.set(2, 0, 0);
		box2.position.set(-2, 1, 0);
		const b1 = box1.uuid;
		const b2 = box2.uuid;

		commandsHandler.sceneCommand('/group');
		r = root();
		const grp = r.children.find((c) => c.type === 'Group');
		grp.position.set(0, 5, 0); // group carries a transform so 'kept world' is meaningful
		objectActions.moveObjectToGroup(b1, grp.uuid); // attach() preserves world
		objectActions.moveObjectToGroup(b2, grp.uuid);
		r.updateMatrixWorld(true);

		const wp = (uuid) => {
			const o = root().getObjectByProperty('uuid', uuid);
			const v = new THREE.Vector3();
			o.getWorldPosition(v);
			return [v.x, v.y, v.z];
		};
		return { groupUuid: grp.uuid, b1, b2, w1: wp(b1), w2: wp(b2), childCount: grp.children.length };
	});
	h.check(setup.childCount === 2, `group holds two boxes (${setup.childCount})`);

	// GROUP selected: radial shows Ungroup, hides Edit Mesh
	const groupRing = await A.page.evaluate((uuid) => {
		window.__stores.objectActions.selectObject(uuid);
		return window.__stores.vrRadialMenu.ringEntries('object').map((e) => e.id);
	}, setup.groupUuid);
	h.check(
		groupRing.includes('obj:ungroup') && !groupRing.includes('obj:editmesh'),
		`group selection: Ungroup in, Edit Mesh out (${groupRing.join(',')})`
	);

	// MESH selected: radial shows Edit Mesh, hides Ungroup
	const meshRing = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let r;
		window.__stores.objectsGroup.subscribe((x) => (r = x))();
		const mesh = r.children[r.children.length - 1];
		window.__stores.objectActions.selectObject(mesh.uuid);
		return window.__stores.vrRadialMenu.ringEntries('object').map((e) => e.id);
	});
	h.check(
		meshRing.includes('obj:editmesh') && !meshRing.includes('obj:ungroup'),
		`mesh selection: Edit Mesh in, Ungroup out (${meshRing.join(',')})`
	);

	// dispatch obj:ungroup through the VR menu action dispatcher
	const after = await A.page.evaluate((s) => {
		const { objectActions, vrControls, THREE } = window.__stores;
		const root = () => {
			let v;
			window.__stores.objectsGroup.subscribe((x) => (v = x))();
			return v;
		};
		objectActions.selectObject(s.groupUuid);
		window.__stores.vrMenuOpen.set(true);
		vrControls.executeVRMenuAction('obj:ungroup');
		const r = root();
		r.updateMatrixWorld(true);
		const wp = (uuid) => {
			const o = r.getObjectByProperty('uuid', uuid);
			if (!o) return null;
			const v = new THREE.Vector3();
			o.getWorldPosition(v);
			return [v.x, v.y, v.z];
		};
		return {
			groupGone: !r.getObjectByProperty('uuid', s.groupUuid),
			b1AtRoot: r.children.some((c) => c.uuid === s.b1),
			b2AtRoot: r.children.some((c) => c.uuid === s.b2),
			w1: wp(s.b1),
			w2: wp(s.b2)
		};
	}, setup);
	h.check(after.groupGone, 'the now-empty group is deleted after ungroup');
	h.check(after.b1AtRoot && after.b2AtRoot, 'both children reparent to the scene root');
	const near = (a, b) =>
		a && b && Math.abs(a[0] - b[0]) < 0.001 && Math.abs(a[1] - b[1]) < 0.001 && Math.abs(a[2] - b[2]) < 0.001;
	h.check(
		near(after.w1, setup.w1) && near(after.w2, setup.w2),
		`child world transforms preserved (${after.w1} vs ${setup.w1})`
	);

	await h.finish(browser);
});
