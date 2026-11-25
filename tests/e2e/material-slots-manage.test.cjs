// 105-slots: material slots you can manage — phase 1, the core (no UI): per-slot values (colour, roughness, type,
// preset) with undo/redo; the list operations (rename, move, duplicate, remove, remove-to-one) as ONE `materials`
// commit and ONE undo step each; "off" drawing the plain default while every serializer keeps the slot's own
// material; the Edit Mesh refusal; two peers, reload = autosave, a saved scene reopened; the heal for a peer without
// the `slots2` cap; an old scene loads unchanged.
//
// Optional E2E_BASE_URL = a dev server running the release before this one (scripts/ci/battery-snapshot.sh): §7
// joins a page there to this build (list changes land, off is ignored, the heal brings a per-slot value), and opens a
// file saved by this build there. Without it §7 prints a SKIP line (the union battery runs without it).
//
// Counterfactual (the base, v1.74.0 + 103-uv-touch + slot-save-fix): §0 stops at "materialSlots hook" (no module);
// with only the module removed, §1 goes red (setMaterialParam refuses a slot list: roughness unchanged).
const h = require('./helpers.cjs');

const BASE = process.env.E2E_BASE_URL || '';
const NAME = 'SlotBox';

/** everything a check needs about the box, by name @param {any} peer @param {string} [name] */
const snap = (peer, name = NAME) =>
	peer.page.evaluate(async (name) => {
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		/** @type {any} */ let o = null;
		g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === name ? n : null));
		if (!o) return null;
		const M = w.materialsHandler;
		const own = M.materialsOf
			? M.materialsOf(o)
			: Array.isArray(o.material)
				? o.material
				: [o.material];
		const drawn = Array.isArray(o.material) ? o.material : [o.material];
		const geo = o.geometry;
		const count = geo.index ? geo.index.count : geo.attributes.position.count;
		/** each triangle's OWN colour (what the slot is), '-' when it draws nothing */
		const tris = [];
		for (let t = 0; t < count / 3; t++) {
			const at = t * 3;
			const grp = (geo.groups || []).find(
				(/** @type {any} */ x) => at >= x.start && at < x.start + x.count
			);
			const s = Array.isArray(o.material) ? (grp ? grp.materialIndex || 0 : -1) : 0;
			tris.push(s < 0 || s >= own.length ? '-' : '#' + own[s].color?.getHexString?.());
		}
		const slots = w.materialSlots?.slotsOf ? w.materialSlots.slotsOf(o) : null;
		return {
			uuid: o.uuid,
			n: own.length,
			ids: slots
				? slots.map((/** @type {any} */ s) => s.id)
				: own.map((/** @type {any} */ m) => m.userData?.slot?.id ?? m.uuid),
			names: own.map((/** @type {any} */ m) => m.name ?? ''),
			off: own.map((/** @type {any} */ m) => m.userData?.slot?.off === true),
			kinds: slots ? slots.map((/** @type {any} */ s) => s.kind) : null,
			faces: slots ? slots.map((/** @type {any} */ s) => s.faces) : null,
			colors: own.map((/** @type {any} */ m) => '#' + m.color?.getHexString?.()),
			rough: own.map((/** @type {any} */ m) =>
				typeof m.roughness === 'number' ? Math.round(m.roughness * 100) / 100 : null
			),
			types: own.map((/** @type {any} */ m) => m.type),
			drawnNames: drawn.map((/** @type {any} */ m) => m.name ?? ''),
			tris: tris.join(','),
			groups: (geo.groups || []).map((/** @type {any} */ x) => [
				x.start,
				x.count,
				x.materialIndex || 0
			])
		};
	}, name);

/** run a call on the box: `fn` gets (hooks, uuid) as a STRING body @param {any} peer @param {string} body */
const call = (peer, body) =>
	peer.page.evaluate(
		async ({ body, name }) => {
			const w = window.__tp.test.v1;
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			/** @type {any} */ let o = null;
			g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === name ? n : null));
			// eslint-disable-next-line no-new-func
			const fn = new Function('w', 'o', 'uuid', 'return (async () => {' + body + '})()');
			const out = await fn(w, o, o?.uuid);
			await new Promise((r) => setTimeout(r, 50));
			return out === undefined ? null : JSON.parse(JSON.stringify(out));
		},
		{ body, name: NAME }
	);

const undo = (/** @type {any} */ peer) =>
	peer.page.evaluate(() => window.__tp.test.v1.history.undo());
const redo = (/** @type {any} */ peer) =>
	peer.page.evaluate(() => window.__tp.test.v1.history.redo());
const same = (/** @type {any} */ a, /** @type {any} */ b) =>
	JSON.stringify(a) === JSON.stringify(b);
/** the parts of a snapshot two peers must agree on (drawn names differ on an older build) @param {any} s */
const shared = (s) =>
	s && {
		n: s.n,
		ids: s.ids,
		names: s.names,
		off: s.off,
		colors: s.colors,
		rough: s.rough,
		types: s.types,
		tris: s.tris,
		groups: s.groups
	};

/** the box's picture @param {any} peer */
async function frameOf(peer) {
	await peer.page.evaluate(() => window.__tp.test.v1.pokeScene?.());
	await peer.page.waitForTimeout(900);
	return h.grabFrame(peer, await h.centeredClip(peer, [0, 0.5, 0], 220));
}

/** answer the restore offer with Restore; on a loaded box Playwright's click can hang in "performing click action"
 * while the page boots, so the fallback presses the button in the page @param {any} peer */
async function restoreHere(peer) {
	await peer.page.waitForTimeout(3000);
	try {
		await h.answerRestore(peer, 'restore', 20000);
	} catch (error) {
		console.log('restore click fallback: ' + String(error).split('\n')[0]);
		await peer.page.evaluate(() =>
			/** @type {HTMLElement | null} */ (
				document.getElementById('restore-session-restore')
			)?.click()
		);
	}
}

const RED = '#ff0000';
const GREEN = '#00ff00';
const BLUE = '#0000ff';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 800 } }
	});
	await h.answerRestore(A);

	// ---- 0. a box with three slots, four triangles each ----------------------------------------------------------
	const hooks = await A.page.evaluate(() => !!window.__tp.test.v1.materialSlots?.slotsOf);
	h.check(hooks, '0 materialSlots hook');
	if (!hooks) return h.finish(browser);
	await A.page.evaluate(async (name) => {
		const w = window.__tp.test.v1;
		const g0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(g0.children.map((/** @type {any} */ c) => c.uuid));
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		for (let i = 0; i < 50; i++) {
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const box = g.children.find((/** @type {any} */ c) => c.isMesh && !before.has(c.uuid));
			if (box) {
				box.name = name;
				box.position.set(0, 0.5, 0);
				box.rotation.set(0.5, 0.6, 0);
				return;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	}, NAME);
	await call(
		A,
		`const M = w.materialsHandler;
		M.addMaterialSlot(uuid);
		// an id + off on slot 1 BEFORE the next add: the clone must not copy them
		M.materialsOf(o)[1].userData.slot = { id: 's1', off: true };
		M.addMaterialSlot(uuid);
		M.materialsOf(o)[1].userData.slot = { id: 's1' };
		M.setObjectMaterials(uuid, M.materialsOf(o), [{ start: 0, count: 12, materialIndex: 0 }, { start: 12, count: 12, materialIndex: 1 }, { start: 24, count: 12, materialIndex: 2 }]);`
	);
	const added = await call(A, `return w.materialsHandler.materialsOf(o)[2].userData.slot ?? null;`);
	h.check(
		added === null,
		'0 "Add slot" does not copy the last slot\'s id / off onto the new slot: ' +
			JSON.stringify(added)
	);
	await call(
		A,
		`const M = w.materialsHandler; M.setObjectColor(uuid, '${RED}', true, 0); M.setObjectColor(uuid, '${GREEN}', true, 1); M.setObjectColor(uuid, '${BLUE}', true, 2);`
	);
	let s0 = await snap(A);
	h.check(
		!!s0 &&
			s0.n === 3 &&
			same(s0.colors, [RED, GREEN, BLUE]) &&
			s0.tris ===
				[RED, RED, RED, RED, GREEN, GREEN, GREEN, GREEN, BLUE, BLUE, BLUE, BLUE].join(','),
		'0 setObjectColor(slot) colours each slot, every face draws: ' + JSON.stringify(s0)
	);
	h.check(
		!!s0 && s0.ids[1] === 's1' && same(s0.faces, [4, 4, 4]),
		'0 slotsOf: ids (explicit, else uuid) and faces per slot: ' +
			JSON.stringify({ ids: s0?.ids, faces: s0?.faces })
	);

	// ---- 1. per-slot values: roughness, type, preset; each one undo step -------------------------------------------
	await call(A, `w.materialsHandler.setMaterialParam(uuid, 'roughness', 0.2, true, 1);`);
	let s = await snap(A);
	h.check(
		!!s && s.rough[1] === 0.2 && s.rough[0] !== 0.2 && s.rough[2] !== 0.2,
		'1a setMaterialParam(slot 1) writes that slot only: ' + JSON.stringify(s?.rough)
	);
	await undo(A);
	s = await snap(A);
	h.check(
		!!s && same(s.rough, s0.rough),
		"1a undo restores the slot's roughness: " + JSON.stringify(s?.rough)
	);
	await redo(A);
	h.check((await snap(A))?.rough[1] === 0.2, '1a redo');

	await call(A, `w.materialsHandler.switchMaterialType(uuid, 'MeshPhongMaterial', true, 2);`);
	s = await snap(A);
	h.check(
		!!s &&
			s.types[2] === 'MeshPhongMaterial' &&
			s.types[0] === 'MeshStandardMaterial' &&
			s.colors[2] === BLUE &&
			s.ids[2] === s0.ids[2] &&
			s.n === 3,
		'1b switchMaterialType(slot 2): that entry only, colour and slot id kept: ' +
			JSON.stringify({ types: s?.types, colors: s?.colors, ids: s?.ids })
	);
	await undo(A);
	s = await snap(A);
	h.check(
		!!s && s.types[2] === 'MeshStandardMaterial' && s.ids[2] === s0.ids[2],
		'1b undo the type switch (one step): ' + JSON.stringify(s?.types)
	);

	await call(
		A,
		`return w.materialPresets.applyMaterialPreset(uuid, w.materialPresets.starterPresets()[0].preset, 1);`
	);
	s = await snap(A);
	h.check(
		!!s &&
			s.n === 3 &&
			s.ids[1] === 's1' &&
			s.colors[1] !== GREEN &&
			s.colors[0] === RED &&
			s.colors[2] === BLUE,
		'1c a preset on slot 1 replaces that entry, keeps its id: ' +
			JSON.stringify({ ids: s?.ids, colors: s?.colors })
	);
	await undo(A);
	s = await snap(A);
	h.check(
		!!s && s.colors[1] === GREEN && s.ids[1] === 's1',
		'1c undo the preset: ' + JSON.stringify(s?.colors)
	);
	await undo(A); // the roughness redo above
	s0 = await snap(A);
	h.check(!!s0 && s0.rough[1] !== 0.2, '1 back to the three-colour box');

	// ---- 2. list operations ---------------------------------------------------------------------------------------
	const f0 = await frameOf(A);
	await call(A, `w.materialSlots.renameSlot(uuid, 1, 'Glass');`);
	s = await snap(A);
	h.check(
		s?.names[1] === 'Glass' && s.ids[1] === 's1',
		'2a rename: the slot keeps its id: ' + JSON.stringify(s?.names)
	);
	await undo(A);
	h.check((await snap(A))?.names[1] !== 'Glass', '2a undo the rename');
	await redo(A);
	h.check((await snap(A))?.names[1] === 'Glass', '2a redo the rename');

	const moved = await call(A, `return w.materialSlots.moveSlot(uuid, 0, +1);`);
	s = await snap(A);
	h.check(
		moved === true && !!s && s.ids[0] === 's1' && s.ids[1] === s0.ids[0] && s.tris === s0.tris,
		'2b move slot 0 down: the ids swap, every face keeps its colour: ' +
			JSON.stringify({ ids: s?.ids, tris: s?.tris })
	);
	const fMoved = await frameOf(A);
	const dMove = await h.frameDelta(A.page, f0, fMoved, 24);
	h.check(
		!dMove.error && dMove.fraction < 0.02,
		'2b pixels: a move draws the same picture (' +
			(dMove.error ?? (dMove.fraction * 100).toFixed(2) + '%') +
			')'
	);
	await undo(A);
	s = await snap(A);
	h.check(!!s && s.ids[0] === s0.ids[0] && s.tris === s0.tris, '2b undo the move (one step)');

	const dup = await call(A, `return w.materialSlots.duplicateSlot(uuid, 2);`);
	s = await snap(A);
	h.check(
		dup === 3 &&
			!!s &&
			s.n === 4 &&
			s.colors[3] === BLUE &&
			s.faces?.[3] === 0 &&
			s.ids[3] !== s.ids[2] &&
			/copy$/.test(s.names[3]),
		'2c duplicate slot 2: a fourth slot, same look, new id, no faces: ' +
			JSON.stringify({ ids: s?.ids, faces: s?.faces, names: s?.names })
	);
	await undo(A);
	h.check((await snap(A))?.n === 3, '2c undo the duplicate');

	const removed = await call(A, `return w.materialSlots.removeSlot(uuid, 's1', 2);`);
	s = await snap(A);
	h.check(
		removed === true &&
			!!s &&
			s.n === 2 &&
			s.tris === [RED, RED, RED, RED, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE].join(',') &&
			same(s.groups, [
				[0, 12, 0],
				[12, 24, 1]
			]),
		'2d remove the green slot, its faces to blue: two slots, groups remapped and merged: ' +
			JSON.stringify({ tris: s?.tris, groups: s?.groups })
	);
	await undo(A);
	s = await snap(A);
	h.check(
		!!s && same(shared(s), shared({ ...s0, names: s.names })) && s.names[1] === 'Glass',
		'2d undo the remove (one step): the list, ids and groups are back: ' + JSON.stringify(s?.ids)
	);

	await call(A, `w.materialSlots.removeSlot(uuid, 0); w.materialSlots.removeSlot(uuid, 0);`);
	const single = await A.page.evaluate(async (name) => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		/** @type {any} */ let o = null;
		g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === name ? n : null));
		return {
			array: Array.isArray(o.material),
			color: '#' + (Array.isArray(o.material) ? '' : o.material.color.getHexString())
		};
	}, NAME);
	h.check(
		!single.array && single.color === BLUE,
		'2e removing down to one slot returns the object to a single material: ' +
			JSON.stringify(single)
	);
	await undo(A);
	await undo(A);
	s = await snap(A);
	h.check(!!s && s.n === 3 && s.tris === s0.tris, '2e two undos bring the three slots back');

	// ---- 3. off: the plain default draws, the slot's own material stays the truth ----------------------------------
	const fOn = await frameOf(A);
	await call(A, `w.materialSlots.setSlotOff(uuid, 1, true);`);
	s = await snap(A);
	h.check(
		!!s &&
			s.off[1] === true &&
			s.kinds?.[1] === 'off' &&
			s.drawnNames[1] === 'slot-off' &&
			s.colors[1] === GREEN,
		'3a off: slot 1 draws the plain default, its own material is still green: ' +
			JSON.stringify({ off: s?.off, kinds: s?.kinds, drawn: s?.drawnNames, colors: s?.colors })
	);
	const fOff = await frameOf(A);
	const dOff = await h.frameDelta(A.page, fOn, fOff, 24);
	h.check(
		!dOff.error && dOff.fraction > 0.01,
		'3a pixels: switching a slot off changes the picture (' +
			(dOff.error ?? (dOff.fraction * 100).toFixed(2) + '%') +
			')'
	);
	const saved = await A.page.evaluate(() =>
		JSON.parse(
			JSON.stringify(
				window.__tp.test.v1.sessions.buildSessionPayload('slots-off', { thumbnail: false })
			)
		)
	);
	const text = JSON.stringify(saved);
	h.check(
		!text.includes('"slot-off"') && text.includes('"off":true'),
		"3b the scene save holds the slot's own material + the off flag, never the stand-in"
	);
	const parked = await call(
		A,
		`const unpark = w.flowRuntime.parkAnimatedAtBase(); const during = o.material[1].name; unpark(); return { during, after: o.material[1].name };`
	);
	h.check(
		parked?.during !== 'slot-off' && parked?.after === 'slot-off',
		'3c the park ritual puts the own material back for a serializer, then re-seats: ' +
			JSON.stringify(parked)
	);
	const json = await call(
		A,
		`const j = o.toJSON(); const have = new Set(j.materials.map((m) => m.uuid)); return { mats: j.materials.map((m) => m.name + ':' + m.color), refs: j.object.material.every((u) => have.has(u)) };`
	);
	h.check(
		!!json &&
			json.refs === true &&
			json.mats.length === 3 &&
			!json.mats.some((/** @type {string} */ x) => String(x).startsWith('slot-off')),
		'3d a plain toJSON (undo snapshot, prefab, copy) writes the own materials and every reference resolves: ' +
			JSON.stringify(json)
	);
	await call(A, `w.materialSlots.setSlotOff(uuid, 1, false);`);
	s = await snap(A);
	h.check(
		!!s && !s.off[1] && s.kinds?.[1] === 'material',
		'3e on again: the slot draws its own material'
	);
	const dBack = await h.frameDelta(A.page, fOn, await frameOf(A), 24);
	h.check(
		!dBack.error && dBack.fraction < 0.02,
		'3e pixels: back to the picture before (' +
			(dBack.error ?? (dBack.fraction * 100).toFixed(2) + '%') +
			')'
	);
	await undo(A);
	h.check((await snap(A))?.off[1] === true, '3f undo "on" = off again (one step)');

	// delete -> undo moves the picture ~10% on the base too (measured, a plain one-material box: 9.63% on v1.74.0 +
	// slot-save-fix), so the pixel checks run BEFORE it; the checks after it are about data
	await call(
		A,
		`w.objectActions.deleteObjectsByUuid([uuid]); await new Promise((r) => setTimeout(r, 300)); w.history.undo(); await new Promise((r) => setTimeout(r, 400));`
	);
	await h.eventually(
		() => snap(A),
		(x) => !!x && x.off[1] && x.colors[1] === GREEN && x.kinds?.[1] === 'off',
		'3g delete -> undo: still off, own material green',
		10000
	);
	const copyName = await call(
		A,
		`const c = w.objectActions.duplicateObject(uuid, { select: false }); c.name = 'SlotBoxCopy'; await new Promise((r) => setTimeout(r, 400)); return c.name;`
	);
	await h.eventually(
		() => snap(A, String(copyName)),
		(x) => !!x && x.off[1] && x.colors[1] === GREEN && x.kinds?.[1] === 'off',
		'3h duplicate: the copy has the own material and is off',
		10000
	);
	// undo the duplicate (its create entry): the copy goes and the history stack is as before it
	await undo(A);
	await h.eventually(
		() => snap(A, String(copyName)),
		(x) => x === null,
		'3h undo the duplicate: the copy is gone',
		10000
	);

	// ---- 4. Edit Mesh: remove / move refused while the object is open, rename allowed --------------------------------
	const editing = await call(
		A,
		`w.faceEdit.enterFaceEdit(uuid);
		await new Promise((r) => setTimeout(r, 300));
		const out = { remove: w.materialSlots.removeSlot(uuid, 0), move: w.materialSlots.moveSlot(uuid, 0, 1), rename: w.materialSlots.renameSlot(uuid, 0, 'Body') };
		w.faceEdit.exitFaceEdit();
		await new Promise((r) => setTimeout(r, 300));
		return out;`
	);
	h.check(
		editing?.remove === false && editing?.move === false && editing?.rename === true,
		'4 in Edit Mesh: remove and move refused, rename works: ' + JSON.stringify(editing)
	);
	h.check((await snap(A))?.n === 3, '4 the list is unchanged after the refusals');

	// ---- 5. two peers, the heal for a peer without slots2, reload = autosave, a saved scene reopened ------------------
	const B = await h.setupPageQuiet(browser, 'B', [A], {
		context: { viewport: { width: 1280, height: 800 } }
	});
	await h.answerRestore(B);
	await h.connect(B, A);
	const sA = await snap(A);
	await h.eventually(
		() => snap(B),
		(x) => !!x && same(shared(x), shared(sA)) && x.kinds?.[1] === 'off',
		'5a the joiner has the same slots: ids, names, off (drawn off), colours, groups',
		30000
	);
	await call(A, `w.materialsHandler.setMaterialParam(uuid, 'roughness', 0.33, true, 2);`);
	await h.eventually(
		() => snap(B),
		(x) => x?.rough[2] === 0.33,
		'5b a per-slot value reaches the joiner',
		15000
	);
	await call(A, `w.materialSlots.removeSlot(uuid, 0, 2);`);
	const afterRemove = await snap(A);
	await h.eventually(
		() => snap(B),
		(x) => !!x && same(shared(x), shared(afterRemove)),
		'5c a remove reaches the joiner (faces remapped)',
		15000
	);
	await undo(A);
	const afterUndo = await snap(A);
	await h.eventually(
		() => snap(B),
		(x) => !!x && same(shared(x), shared(afterUndo)) && x.n === 3,
		'5d undo on the host restores the slot on the joiner too',
		15000
	);

	// the sender's rule: a current peer gets no whole-list heal; a peer without slots2 gets exactly one per gesture
	await A.page.evaluate(() => {
		/** @type {any} */ let p;
		window.__tp.test.v1.peers.subscribe((v) => (p = v))();
		/** @type {any} */ (window).__heals = [];
		const real = p.sendReliableTo.bind(p);
		p.sendReliableTo = (/** @type {any} */ payload, /** @type {string[]} */ ids) => {
			if (payload?.parameter === 'materials') /** @type {any} */ (window).__heals.push(ids.slice());
			return real(payload, ids);
		};
	});
	await call(A, `w.materialsHandler.setMaterialParam(uuid, 'roughness', 0.4, true, 1);`);
	await A.page.waitForTimeout(1200);
	const noHeal = await A.page.evaluate(() => /** @type {any} */ (window).__heals.length);
	h.check(
		noHeal === 0,
		'5e with only slots2 peers connected, no whole-list heal is sent: ' + noHeal
	);
	const C = await h.setupPageQuiet(browser, 'C', [A, B], {
		context: { viewport: { width: 1000, height: 700 } },
		storage: { debugCapsOff: 'slots2' }
	});
	await h.answerRestore(C);
	await h.connect(C, A);
	await h.eventually(
		() => snap(C),
		(x) => x?.n === 3,
		'5f a peer dialling without slots2 joins and has the box',
		30000
	);
	await call(
		A,
		`const M = w.materialsHandler; M.setMaterialParam(uuid, 'roughness', 0.5, true, 1); M.setMaterialParam(uuid, 'roughness', 0.6, true, 1); M.setMaterialParam(uuid, 'roughness', 0.7, true, 1);`
	);
	await A.page.waitForTimeout(1500);
	const heals = await A.page.evaluate(() => /** @type {any} */ (window).__heals);
	h.check(
		heals.length === 1 && heals[0].length === 1 && heals[0][0] === C.id,
		'5g three quick per-slot edits = ONE whole-list heal, to the peer without slots2 only: ' +
			JSON.stringify({ heals, C: C.id })
	);
	await h.eventually(
		() => snap(C),
		(x) => x?.rough[1] === 0.7,
		'5g that peer ends on the final value',
		10000
	);
	await C.ctx.close();

	await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	const beforeReload = await snap(A);
	await h.freshReload(A);
	await restoreHere(A);
	await h.eventually(
		() => snap(A),
		(x) => !!x && same(shared(x), shared(beforeReload)) && x.kinds?.[1] === 'off',
		'5h reload = autosave: slots, ids, names, off (drawn off), colours, groups',
		30000
	);
	const file = await A.page.evaluate(() =>
		JSON.parse(
			JSON.stringify(
				window.__tp.test.v1.sessions.buildSessionPayload('slots-file', { thumbnail: false })
			)
		)
	);
	await A.page.evaluate(
		(payload) =>
			window.__tp.test.v1.sessions.applySession(payload, {
				backup: false,
				replicate: false,
				quiet: true
			}),
		file
	);
	await h.eventually(
		() => snap(A),
		(x) => !!x && same(shared(x), shared(beforeReload)) && x.kinds?.[1] === 'off',
		'5i a saved scene reopened: the same slots, drawn off',
		20000
	);

	// ---- 6. an old scene loads unchanged; with the feature unused nothing is written -----------------------------------
	const unchanged = await A.page.evaluate(async () => {
		const S = window.__tp.test.v1;
		const T = S.THREE;
		const payload = S.sessions.buildSessionPayload('slots-old', { thumbnail: false });
		const flat = new T.BufferGeometry().copy(new T.BoxGeometry(1, 1, 1));
		flat.clearGroups();
		flat.addGroup(0, 6, 1);
		flat.addGroup(6, 30, 0);
		const mats = [
			new T.MeshStandardMaterial({ color: 0x336699 }),
			new T.MeshPhongMaterial({ color: 0x993366 })
		];
		mats[1].name = 'old slot';
		const old = new T.Mesh(flat, mats);
		old.name = 'OldTwoSlots';
		const one = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial());
		one.name = 'OldOne';
		payload.objects = [old.toJSON(), one.toJSON()];
		const input = JSON.parse(JSON.stringify(payload));
		await S.sessions.applySession(JSON.parse(JSON.stringify(input)), {
			backup: false,
			replicate: false,
			quiet: true
		});
		await new Promise((r) => setTimeout(r, 800));
		const g = await new Promise((r) => S.objectsGroup.subscribe(r)());
		/** @type {string[]} */
		const diffs = [];
		for (const element of input.objects) {
			const o = g.children.find((/** @type {any} */ c) => c.uuid === element.object.uuid);
			if (!o) {
				diffs.push(element.object.uuid + ' missing');
				continue;
			}
			const now = o.toJSON();
			if (JSON.stringify(now.materials) !== JSON.stringify(element.materials))
				diffs.push(o.name + ' materials');
			if (JSON.stringify(now.object.material) !== JSON.stringify(element.object.material))
				diffs.push(o.name + ' material refs');
			const slots = S.materialSlots.slotsOf(o);
			if (slots.some((/** @type {any} */ x) => x.kind !== 'material' || x.off))
				diffs.push(o.name + ' drawn');
		}
		return diffs;
	});
	h.check(
		unchanged.length === 0,
		'6 an old scene (two slots, no slot data) loads and re-saves its materials byte-identical: ' +
			JSON.stringify(unchanged)
	);

	// ---- 7. the release before this one (optional second server) ----------------------------------------------------
	if (!BASE)
		console.log('SKIP 7 E2E_BASE_URL not set (a peer and a file on the release before this one)');
	else {
		await A.page.evaluate(
			(payload) =>
				window.__tp.test.v1.sessions.applySession(payload, {
					backup: false,
					replicate: false,
					quiet: true
				}),
			file
		);
		await h.eventually(
			() => snap(A),
			(x) => x?.n === 3,
			'7 setup: the box is back on the host',
			20000
		);
		const O = await h.setupPageQuiet(browser, 'O', [A, B], {
			url: BASE,
			context: { viewport: { width: 1000, height: 700 } }
		});
		const version = await O.page.evaluate(() => window.__tp.test.v1.version?.APP_VERSION ?? '?');
		console.log('old side version: ' + version);
		await h.answerRestore(O);
		await h.connect(O, A);
		const host = await snap(A);
		await h.eventually(
			() => snap(O),
			(x) =>
				!!x &&
				x.n === 3 &&
				same(x.names, host.names) &&
				same(x.colors, host.colors) &&
				same(x.groups, host.groups),
			'7a the older peer has the slot list (names, colours, groups)',
			30000
		);
		const oDrawn = await snap(O);
		h.check(
			!!oDrawn && oDrawn.drawnNames[1] !== 'slot-off' && oDrawn.off[1] === true,
			"7a off is ignored there: it draws the slot's own material and keeps the flag: " +
				JSON.stringify(oDrawn?.drawnNames)
		);
		await call(A, `w.materialsHandler.setMaterialParam(uuid, 'roughness', 0.81, true, 2);`);
		await h.eventually(
			() => snap(O),
			(x) => x?.rough[2] === 0.81,
			'7b the heal brings a per-slot value to the older peer',
			15000
		);
		await call(A, `w.materialSlots.removeSlot(uuid, 0, 1);`);
		const two = await snap(A);
		await h.eventually(
			() => snap(O),
			(x) => !!x && x.n === 2 && same(x.groups, two.groups) && same(x.colors, two.colors),
			'7c a remove lands on the older peer (faces remapped)',
			15000
		);
		await undo(A);
		await h.eventually(
			() => snap(O),
			(x) => x?.n === 3,
			'7d undo lands too',
			15000
		);
		await O.page.evaluate(
			(payload) =>
				window.__tp.test.v1.sessions.applySession(payload, {
					backup: false,
					replicate: false,
					quiet: true
				}),
			file
		);
		await h.eventually(
			() => snap(O),
			(x) =>
				!!x &&
				x.n === 3 &&
				same(x.names, shared(beforeReload).names) &&
				x.tris === beforeReload.tris,
			'7e a file saved by this build opens in the older release (slots, names, every face)',
			20000
		);
	}

	await h.finish(browser);
});
