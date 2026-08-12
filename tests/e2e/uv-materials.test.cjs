// UV2: per-MATERIAL-SLOT textures. A mesh can wear a material ARRAY (an imported
// .obj/.mtl, a merged mesh) and every texture path used to refuse those outright
// ("Multi-material objects are not supported yet"). Now the map message carries an
// optional `slot`, the UV editor lists the slots, and each row is a drop target.
//
// NOTE on scope: this suite drives the LIVE path (both peers already connected),
// which is what users hit. A late joiner receiving a scene that CONTAINS a
// multi-material mesh is separately broken and predates UV2 — see the commit body.
const h = require('./helpers.cjs');

/** a box wearing TWO materials, split down the middle by geometry.groups */
const twoSlotBox = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'twoSlot';
		box.material = [
			new w.THREE.MeshStandardMaterial({ name: 'front' }),
			new w.THREE.MeshStandardMaterial({ name: 'back' })
		];
		const geo = box.geometry;
		geo.clearGroups();
		const total = geo.index ? geo.index.count : geo.attributes.position.count;
		geo.addGroup(0, total / 2, 0);
		geo.addGroup(total / 2, total / 2, 1);
		w.objectsGroup.update((v) => v);
		w.objectActions.selectObject(box.uuid);
		return box.uuid;
	});

/**
 * Install window.__mkPng(hex, name) -> File. A canvas-encoded PNG, NOT a
 * hand-written base64 blob: setObjectsTexture runs the file through
 * createImageBitmap, which rejects anything it cannot decode — and then the
 * whole call silently applies nothing and returns 0.
 */
const installPngMaker = (page) =>
	page.evaluate(() => {
		/** @type {any} */ (window).__mkPng = async (hex, name) => {
			const c = document.createElement('canvas');
			c.width = c.height = 8;
			const ctx = c.getContext('2d');
			ctx.fillStyle = hex;
			ctx.fillRect(0, 0, 8, 8);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			return new File([blob], name, { type: 'image/png' });
		};
		/** @type {any} */ (window).__mkDataUrl = (hex) => {
			const c = document.createElement('canvas');
			c.width = c.height = 8;
			const ctx = c.getContext('2d');
			ctx.fillStyle = hex;
			ctx.fillRect(0, 0, 8, 8);
			return c.toDataURL('image/png');
		};
	});

/** which slots carry a texture, and their dataURL prefixes */
const slotMaps = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		const mats = Array.isArray(o.material) ? o.material : [o.material];
		return mats.map((m) => ({
			name: m.name,
			hasUrl: !!m.userData?.mapDataUrl,
			hasMap: !!m.map,
			url: (m.userData?.mapDataUrl ?? '').slice(0, 22)
		}));
	}, uuid);

/** texture one slot from a data-URL image, through the real replicated path.
 * Returns how many objects were textured (0 means it bailed — the count is the
 * only signal setObjectsTexture gives, so assert on it rather than guessing). */
const textureSlot = (page, uuid, slot, hex) =>
	page.evaluate(
		async ({ uuid, slot, hex }) => {
			const w = window.__stores;
			const file = await /** @type {any} */ (window).__mkPng(hex, 'slot' + slot + '.png');
			try {
				return { applied: await w.materialsHandler.setObjectsTexture([uuid], file, slot) };
			} catch (err) {
				return { applied: 0, error: String(err && err.message ? err.message : err) };
			}
		},
		{ uuid, slot, hex }
	);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await installPngMaker(A.page);

	const uuid = await twoSlotBox(A.page);
	await A.page.evaluate(() => {
		window.__stores.uvEditorClose.set(false);
		window.__stores.bottomDock.activateDock('uv');
	});
	await A.page.waitForTimeout(700);

	// ---------- the sidebar lists the slots ----------
	const rows = await A.page.evaluate(() =>
		[...document.querySelectorAll('[data-uv-slot]')].map((el) => ({
			slot: el.getAttribute('data-uv-slot'),
			text: el.textContent.trim(),
			hasAdd: !!el.querySelector('[id^="uv-slot-image-"]')
		}))
	);
	h.check(rows.length === 2, `the sidebar lists both material slots (${rows.length})`);
	h.check(
		rows[0]?.text.includes('front') && rows[1]?.text.includes('back'),
		`slots are named from the materials (${rows.map((r) => r.text).join('|')})`
	);
	h.check(rows.every((r) => r.hasAdd), 'every slot row has an add/replace image button');

	// the UV canvas shows only the ACTIVE slot's triangles (6 of 12 per half)
	const perSlot = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		return { slot0: w.uvEditor.uvTriangles(box, 0).length, slot1: w.uvEditor.uvTriangles(box, 1).length };
	}, uuid);
	h.check(
		perSlot.slot0 === 6 && perSlot.slot1 === 6,
		`uvTriangles splits the box per slot (${perSlot.slot0}/${perSlot.slot1})`
	);
	await A.page.evaluate(() => window.__stores.uvEditor.uvActiveSlot.set(1));
	await A.page.waitForTimeout(300);
	const shown = await A.page.evaluate(() => window.__uvDebug().tris);
	h.check(shown === 6, `switching the active slot redraws only its triangles (${shown})`);
	await A.page.evaluate(() => window.__stores.uvEditor.uvActiveSlot.set(0));

	// ---------- texturing ONE slot leaves the other alone ----------
	const before = await slotMaps(A.page, uuid);
	h.check(before.every((s) => !s.hasUrl), 'premise: neither slot is textured yet');
	const depth0 = await undoDepth(A.page);
	const applied = await textureSlot(A.page, uuid, 1, '#22cc55');
	h.check(applied.applied === 1, `setObjectsTexture textures the slot (${JSON.stringify(applied)})`);
	await A.page.waitForTimeout(600);
	const after = await slotMaps(A.page, uuid);
	h.check(
		!after[0].hasUrl && after[1].hasUrl,
		`THE FEATURE: slot 1 is textured and slot 0 is untouched (${after.map((s) => s.hasUrl).join(',')})`
	);
	h.check(after[1].hasMap, 'the texture actually loaded onto slot 1 (material.map set)');
	const depth1 = await undoDepth(A.page);
	h.check(depth1 === depth0 + 1, `texturing a slot records ONE undo entry (${depth0}->${depth1})`);
	const entry = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.history.undoStack.subscribe((v) => {
					const e = v[v.length - 1];
					r({ kind: e?.kind, param: e?.param, slot: e?.slot ?? null });
				})()
			)
	);
	h.check(
		entry.kind === 'material' && entry.param === 'map' && entry.slot === 1,
		`the entry is a slot-tagged material/map step (${JSON.stringify(entry)})`
	);

	// texture slot 0 too, with a different image, and check they stay distinct
	await textureSlot(A.page, uuid, 0, '#cc2255');
	await A.page.waitForTimeout(500);
	const both = await slotMaps(A.page, uuid);
	h.check(both[0].hasUrl && both[1].hasUrl, 'both slots can hold their own texture');

	// ---------- undo / remove ----------
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	const undone = await slotMaps(A.page, uuid);
	h.check(
		!undone[0].hasUrl && undone[1].hasUrl,
		`undo removes only the LAST slot's texture (${undone.map((s) => s.hasUrl).join(',')})`
	);
	await A.page.evaluate((uuid) => window.__stores.materialsHandler.removeObjectTexture(uuid, 1), uuid);
	await A.page.waitForTimeout(400);
	const removed = await slotMaps(A.page, uuid);
	h.check(!removed[1].hasUrl && !removed[1].hasMap, 'removeObjectTexture clears the addressed slot');
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	const restored = await slotMaps(A.page, uuid);
	h.check(restored[1].hasUrl, 'undoing the removal puts slot 1 back');

	// ---------- the row's own UI: remove button + drop target ----------
	const removeBtn = await A.page.evaluate(async () => {
		const btn = document.getElementById('uv-slot-remove-1');
		if (!btn) return { present: false };
		btn.click();
		await new Promise((r) => setTimeout(r, 400));
		return { present: true };
	});
	h.check(removeBtn.present, 'a textured slot row offers a remove button');
	const afterBtn = await slotMaps(A.page, uuid);
	h.check(!afterBtn[1].hasUrl, 'the row remove button clears that slot');

	// drop an OS image file straight onto slot 1's row
	const dropped = await A.page.evaluate(async () => {
		const row = document.querySelector('[data-uv-slot="1"]');
		if (!row) return { row: false };
		const dt = new DataTransfer();
		dt.items.add(await /** @type {any} */ (window).__mkPng('#8844ee', 'dropped.png'));
		row.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
		// svelte applies the class in a microtask — reading className synchronously
		// would race the update and report "no cue" on a working cue
		await new Promise((r) => setTimeout(r, 120));
		const cued = row.className.includes('uv-slot-drop');
		row.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 1200));
		return { row: true, cued };
	});
	h.check(dropped.cued, 'dragging an image over a slot row shows the drop cue');
	const afterDrop = await slotMaps(A.page, uuid);
	h.check(afterDrop[1].hasUrl, 'dropping an image file on a slot row textures THAT slot');

	// ---------- the scene-asset manifest covers every textured slot ----------
	const manifest = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.sceneAssets.sceneAssets.subscribe((list) =>
					r(list.filter((a) => a.group === 'textures').map((a) => a.id))
				)()
			)
	);
	h.check(
		manifest.some((id) => id.endsWith(':1')),
		`a slot-1 texture appears in the scene manifest (${manifest.join('|')})`
	);

	// ---------- LIVE replication to a connected peer ----------
	const B = await h.setupPage(browser, 'B');
	await installPngMaker(B.page);
	await h.connect(B, A);
	const netUuid = await twoSlotBox(A.page);
	await h.eventually(
		() => slotMaps(B.page, netUuid),
		(s) => !!s,
		'B received the multi-material box (premise)',
		25000
	);
	const remoteShape = await slotMaps(B.page, netUuid);
	// B has ONE slot here, and that is correct for this fixture: `twoSlotBox` builds
	// the array by assigning `mesh.material = [...]` LOCALLY, and no message
	// replicates a material array being created (that is the `materials` message,
	// still to come). What the object SYNC does with an existing array is a
	// different path and is covered by tests/e2e/object-sync, where a late joiner now
	// receives one Mesh with both slots and both groups.
	h.check(
		!!remoteShape && remoteShape.length === 1,
		`creating an array locally does not replicate it yet (${remoteShape?.length ?? 0} slot on B)`
	);

	// So prove the RECEIVE-SIDE slot handling on a peer that genuinely has two
	// slots: give B's copy a real material array, then send the slot-tagged
	// message from A. This is the code UV2 actually changed.
	await B.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		o.material = [
			new w.THREE.MeshStandardMaterial({ name: 'front' }),
			new w.THREE.MeshStandardMaterial({ name: 'back' })
		];
		w.objectsGroup.update((v) => v);
	}, netUuid);

	await textureSlot(A.page, netUuid, 1, '#2255cc');
	await h.eventually(
		() => slotMaps(B.page, netUuid),
		(s) => !!s && s.length > 1 && s[1].hasUrl,
		'THE WIRE: a slot-tagged map message applies to the SAME slot on the receiver',
		25000
	);
	const remoteAfter = await slotMaps(B.page, netUuid);
	h.check(
		remoteAfter && !remoteAfter[0].hasUrl,
		`...and leaves the receiver's slot 0 untextured (${remoteAfter?.map((s) => s.hasUrl).join(',')})`
	);

	// an OLDER peer's slot-less message must still land on slot 0
	await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const peer = await new Promise((r) => w.peers.subscribe(r)());
		const url = /** @type {any} */ (window).__mkDataUrl('#ffaa00');
		peer.send({ type: 'objectParameters', parameter: 'map', uuid, map: url });
	}, netUuid);
	await h.eventually(
		() => slotMaps(B.page, netUuid),
		(s) => !!s && s[0].hasUrl,
		'a legacy slot-less map message still lands on slot 0 (back-compat)',
		20000
	);

	await h.finish(browser);
});
