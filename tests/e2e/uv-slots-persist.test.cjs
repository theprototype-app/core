// Material SLOTS must survive a page RELOAD.
//
// Reported: "added several slots to a cube, applied different textures to different
// faces, after reload the cube shows them but the UV editor shows one texture and no
// slots". Both halves of that are true and consistent: autosave snapshots the scene
// through GLTFExporter, which splits geometry.groups into one primitive per material,
// and GLTFLoader reassembles that as a GROUP of single-material child meshes. The
// pixels are identical - which is why the cube still looks right - but the OBJECT is
// no longer one mesh with a slot array, so the UV editor (which resolves a Group to
// its first textured child) sees a single slot.
//
// Same defect class as the wire had: a material array cannot cross a GLTF round trip.
const h = require('./helpers.cjs');

/** build a cube with `count` slots, each face-group textured a different colour */
const buildSlotCube = (page, count) =>
	page.evaluate(async (count) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'slotCube';
		w.objectActions.selectObject(box.uuid);
		const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
		const png = (hex) => {
			const c = document.createElement('canvas');
			c.width = c.height = 8;
			const ctx = c.getContext('2d');
			ctx.fillStyle = hex;
			ctx.fillRect(0, 0, 8, 8);
			return c.toDataURL('image/png');
		};
		// grow the array, then texture each slot through the real replicated path
		for (let i = 1; i < count; i++) w.materialsHandler.addMaterialSlot(box.uuid);
		const faces = w.faceEdit ? null : null;
		// assign one face per extra slot so the groups are genuinely non-trivial
		w.faceEdit.enterFaceEdit(box.uuid);
		const all = w.faceEdit.currentFaces();
		for (let slot = 1; slot < count; slot++) {
			const face = all[slot];
			w.uvEditor.assignTrisToSlot(box.uuid, face.triIndices, slot);
		}
		w.faceEdit.exitFaceEdit();
		for (let slot = 0; slot < count; slot++) {
			const mats = Array.isArray(box.material) ? box.material : [box.material];
			if (mats[slot]) w.materialsHandler.applyMap(box, png(colours[slot]), slot);
		}
		w.objectsGroup.update((v) => v);
		void faces;
		return box.uuid;
	}, count);

/** the shape the UV editor actually sees */
const slotShape = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const byUuid = g.getObjectByProperty('uuid', uuid);
		const named = g.children.find((o) => o.name === 'slotCube') ?? byUuid;
		if (!named) return { found: false };
		// what the editor resolves to, exactly as UvEditor does
		const target = w.uvEditor.meshWithUvs(named);
		const mats = target
			? Array.isArray(target.material)
				? target.material
				: [target.material]
			: [];
		return {
			found: true,
			topType: named.type,
			childMeshes: named.children.filter((c) => c.isMesh).length,
			sameUuid: named.uuid === uuid,
			slots: mats.length,
			textured: mats.filter((m) => m && m.userData && m.userData.mapDataUrl).length,
			groups: (target && target.geometry && target.geometry.groups && target.geometry.groups.length) || 0
		};
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await buildSlotCube(A.page, 4);
	await A.page.waitForTimeout(1200);
	const before = await slotShape(A.page, uuid);
	h.check(
		before.slots === 4 && before.textured === 4,
		`premise: the cube has 4 textured slots before reload (${before.slots} slots, ${before.textured} textured)`
	);
	h.check(before.topType === 'Mesh', `premise: it is ONE mesh (${before.topType})`);

	// force the autosave now, then reload the page and let the restore run
	await A.page.evaluate(async () => {
		await window.__stores.autosave.saveNow();
	});
	await A.page.waitForTimeout(600);
	await h.freshReload(A);
	await A.page.waitForTimeout(3000);
	// the restore is offered as a sticky prompt, not applied automatically
	await A.page.evaluate(async () => {
		await window.__stores.autosave.restoreSnapshot();
	});
	await A.page.waitForTimeout(3000);

	const after = await slotShape(A.page, uuid);
	console.log('  after reload: ' + JSON.stringify(after));
	h.check(after.found, 'the cube comes back after a reload');
	h.check(
		after.topType === 'Mesh' && after.childMeshes === 0,
		`THE BUG: it comes back as ONE mesh, not a Group of per-material children (${after.topType}, ${after.childMeshes} children)`
	);
	h.check(after.sameUuid, 'THE BUG: it keeps its original uuid (flows/notes/slots are keyed by it)');
	h.check(
		after.slots === 4,
		`THE BUG: all four material slots survive the reload (${after.slots})`
	);
	h.check(
		after.textured === 4,
		`...each keeping its own texture (${after.textured} of 4 textured)`
	);
	h.check(after.groups >= 4, `...and the geometry groups that point faces at them (${after.groups})`);

	await h.finish(browser);
});
