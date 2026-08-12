// UV4: material SLOTS as a first-class, replicated thing.
//
// Two capabilities were missing end to end. Nothing ever GREW a material array (so
// "assign to slot 2" had no slot 2 to point at), and nothing ever SET a triangle's
// slot - `mi` was read and propagated by every mesh op but never written. On top of
// that, a slot coming into EXISTENCE was purely local: textures and params were
// slot-addressable since UV2, but the array itself never crossed the wire, so
// anything built out of slots could not be shared.
//
// Now: `addMaterialSlot` appends and replicates via a new `materials` message that
// carries the array AND geometry.groups together (an array material with no groups
// renders nothing, so both halves must land at once), and `assignTrisToSlot` writes
// `mi` and commits through the existing meshgeo triple - replication, undo and
// persistence for free.
const h = require('./helpers.cjs');

const openOnBox = async (page) => {
	const uuid = await page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'slotBox';
		w.objectActions.selectObject(box.uuid);
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
		return box.uuid;
	});
	await page.waitForTimeout(700);
	return uuid;
};

/** slots + which slot each triangle belongs to */
const slotState = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		const mats = Array.isArray(o.material) ? o.material : [o.material];
		const geo = o.geometry;
		const count = geo.index ? geo.index.count : geo.attributes.position.count;
		const slotAt = (element) => {
			let slot = 0;
			for (const grp of geo.groups || [])
				if (element >= grp.start && element < grp.start + grp.count) slot = grp.materialIndex || 0;
			return slot;
		};
		const perTri = [];
		for (let t = 0; t < count / 3; t++) perTri.push(slotAt(t * 3));
		return {
			slots: mats.length,
			names: mats.map((m) => (m && m.name) || ''),
			groups: (geo.groups || []).length,
			perTri,
			inSlot1: perTri.filter((s) => s === 1).length
		};
	}, uuid);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));

/** pick the top face in Edit Mesh and return its triangle indices */
const pickTopFace = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.faceEdit.enterFaceEdit(uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		return top.triIndices;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const uuid = await openOnBox(A.page);

	const start = await slotState(A.page, uuid);
	h.check(start.slots === 1, `premise: a fresh box has one material slot (${start.slots})`);

	// ---------- adding a slot ----------
	const addBtn = await A.page.evaluate(async () => {
		const btn = document.getElementById('uv-add-slot');
		if (!btn) return { present: false };
		btn.click();
		await new Promise((r) => setTimeout(r, 600));
		return { present: true };
	});
	h.check(addBtn.present, 'the material sidebar offers an "Add material slot" button');
	const added = await slotState(A.page, uuid);
	h.check(added.slots === 2, `THE FEATURE: a slot can be ADDED (${start.slots} -> ${added.slots})`);
	h.check(
		added.groups >= 1 && added.perTri.every((s) => s === 0),
		`...and nothing changes appearance yet - every triangle still uses slot 0 (${added.groups} groups)`
	);
	const depthAfterAdd = await undoDepth(A.page);
	h.check(depthAfterAdd > 0, 'adding a slot is undoable');

	// ---------- assigning faces to it ----------
	const picked = await pickTopFace(A.page, uuid);
	h.check(picked.length >= 1, `premise: ${picked.length} face triangles picked in Edit Mesh`);
	const assignEnabled = await A.page.evaluate(async () => {
		await new Promise((r) => setTimeout(r, 300));
		const btn = document.getElementById('uv-slot-assign-1');
		return { present: !!btn, disabled: btn ? btn.disabled : null };
	});
	h.check(assignEnabled.present, 'each slot row has an assign button');
	h.check(assignEnabled.disabled === false, 'the assign button is enabled once faces are picked');

	const depthBefore = await undoDepth(A.page);
	await A.page.evaluate(async () => {
		document.getElementById('uv-slot-assign-1').click();
		await new Promise((r) => setTimeout(r, 700));
	});
	const assigned = await slotState(A.page, uuid);
	h.check(
		assigned.inSlot1 === picked.length,
		`THE FEATURE: exactly the picked faces now use slot 1 (${assigned.inSlot1} of ${picked.length})`
	);
	h.check(
		assigned.perTri.filter((s) => s === 0).length === assigned.perTri.length - picked.length,
		'...and every other triangle still uses slot 0'
	);
	const depthAfter = await undoDepth(A.page);
	h.check(depthAfter === depthBefore + 1, `assigning records ONE undo entry (${depthBefore}->${depthAfter})`);

	// ---------- undo both steps ----------
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	const undoneAssign = await slotState(A.page, uuid);
	h.check(undoneAssign.inSlot1 === 0, `undo puts the faces back on slot 0 (${undoneAssign.inSlot1} left on slot 1)`);
	h.check(undoneAssign.slots === 2, '...without removing the slot itself');
	// Leave the edit session before undoing the ADD. Picking a face records a
	// session-scoped 'selection' entry, so the next Ctrl+Z inside the session walks
	// the PICK back, not the slot — which is the intended behaviour. endHistorySession
	// filters those entries out, leaving the slot entry on top.
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	const undoneAdd = await slotState(A.page, uuid);
	h.check(undoneAdd.slots === 1, `undoing past the session removes the added slot (${undoneAdd.slots})`);

	// ---------- a slot cannot be assigned when it does not exist ----------
	const refused = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		return w.uvEditor.assignTrisToSlot(uuid, [0, 1], 5);
	}, uuid);
	h.check(refused === false, 'assigning to a slot the object does not have is refused');

	// ---------- switchMaterialType must not collapse an array ----------
	await A.page.evaluate(async () => {
		document.getElementById('uv-add-slot').click();
		await new Promise((r) => setTimeout(r, 500));
	});
	const beforeSwitch = await slotState(A.page, uuid);
	await A.page.evaluate(
		(uuid) => window.__stores.materialsHandler.switchMaterialType(uuid, 'MeshBasicMaterial', true),
		uuid
	);
	await A.page.waitForTimeout(400);
	const afterSwitch = await slotState(A.page, uuid);
	h.check(
		beforeSwitch.slots > 1 && afterSwitch.slots === beforeSwitch.slots,
		`THE BUG: switchMaterialType no longer collapses a multi-slot array (${beforeSwitch.slots} -> ${afterSwitch.slots})`
	);

	// ---------- both halves replicate LIVE ----------
	// leave Edit Mesh first: an ACTIVE session is the UV editor's target, so a stale
	// one would aim the next add/assign at the PREVIOUS object
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.waitForTimeout(300);

	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await openOnBox(A.page);
	await h.eventually(
		() => slotState(B.page, netUuid),
		(s) => !!s,
		'B received the box (premise)',
		25000
	);

	await A.page.evaluate(async () => {
		document.getElementById('uv-add-slot').click();
		await new Promise((r) => setTimeout(r, 600));
	});
	await h.eventually(
		() => slotState(B.page, netUuid),
		(s) => !!s && s.slots === 2,
		'THE WIRE: adding a slot replicates the material ARRAY to B',
		25000
	);
	const bAfterAdd = await slotState(B.page, netUuid);
	h.check(bAfterAdd.groups >= 1, `...together with geometry groups, or an array material draws nothing (${bAfterAdd.groups})`);

	const netPicked = await pickTopFace(A.page, netUuid);
	await A.page.evaluate(async () => {
		document.getElementById('uv-slot-assign-1').click();
		await new Promise((r) => setTimeout(r, 700));
	});
	await h.eventually(
		() => slotState(B.page, netUuid),
		(s) => !!s && s.inSlot1 === netPicked.length,
		'THE WIRE: the face assignment replicates to B',
		25000
	);
	const bAssigned = await slotState(B.page, netUuid);
	h.check(
		bAssigned.inSlot1 === netPicked.length,
		`B has exactly the same faces on slot 1 (${bAssigned.inSlot1} of ${netPicked.length})`
	);

	await h.finish(browser);
});
