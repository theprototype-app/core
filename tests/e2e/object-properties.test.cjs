// Phase 147: the object-properties audit. Material toggles (wireframe,
// flatShading, side, emissive) and object-level props (renderOrder,
// frustumCulled) apply through the shared setMaterialParam / objectParameters
// path — replicated + (material) undoable. Type-gating hides params the active
// material has no slot for. UI layout/sections are a manual eyeball.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box'); // MeshStandardMaterial
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = group.children[group.children.length - 1];
		window.__stores.objectActions.selectObject(window.__box.uuid, true);
	});
	await A.page.waitForTimeout(500);

	// --- material toggles apply + replicate via materialParam ---
	const mat = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__box;
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		s.materialsHandler.setMaterialParam(box.uuid, 'flatShading', true, true);
		s.materialsHandler.setMaterialParam(box.uuid, 'side', 2, true); // DoubleSide
		s.materialsHandler.setMaterialParam(box.uuid, 'emissive', '#ff0000', true);
		s.materialsHandler.setMaterialParam(box.uuid, 'wireframe', true, true);
		s.peers.set(original);
		const paramMsgs = captured.filter((m) => m.type === 'objectParameters' && m.parameter === 'materialParam').map((m) => m.key);
		return {
			flat: box.material.flatShading,
			side: box.material.side,
			emissive: '#' + box.material.emissive.getHexString(),
			wire: box.material.wireframe,
			paramMsgs
		};
	});
	h.check(mat.flat === true, 'flatShading applies');
	h.check(mat.side === 2, 'side = Double applies');
	h.check(mat.emissive === '#ff0000', 'emissive color applies (Color-aware setMaterialParam)');
	h.check(mat.wire === true, 'wireframe applies');
	h.check(
		['flatShading', 'side', 'emissive', 'wireframe'].every((k) => mat.paramMsgs.includes(k)),
		`each toggle replicates via materialParam (${mat.paramMsgs.join(',')})`
	);

	// --- emissive is undoable through the material history ---
	const undo = await A.page.evaluate(() => {
		const box = window.__box;
		const after = '#' + box.material.emissive.getHexString();
		window.__stores.history.undo(); // reverts wireframe (last)
		window.__stores.history.undo(); // reverts emissive
		return { after, reverted: '#' + box.material.emissive.getHexString() };
	});
	h.check(undo.after === '#ff0000' && undo.reverted === '#000000', `emissive undoes (${undo.after} -> ${undo.reverted})`);

	// --- type-gating: a Basic material has no metalness/roughness slot ---
	const gate = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__box;
		s.materialsHandler.switchMaterialType(box.uuid, 'MeshBasicMaterial', false);
		const basic = { metalness: 'metalness' in box.material, roughness: 'roughness' in box.material };
		s.materialsHandler.switchMaterialType(box.uuid, 'MeshStandardMaterial', false);
		const standard = { metalness: 'metalness' in box.material, roughness: 'roughness' in box.material };
		return { basic, standard };
	});
	h.check(!gate.basic.metalness && !gate.basic.roughness, 'Basic material has no metalness/roughness (rows stay hidden)');
	h.check(gate.standard.metalness && gate.standard.roughness, 'Standard material exposes metalness/roughness');

	// --- object-level renderOrder/frustumCulled: receiver applies a peer update ---
	const recv = await A.page.evaluate(() => {
		const box = window.__box;
		window.__stores.commandsHandler.objectParameters({ parameter: 'renderOrder', uuid: box.uuid, renderOrder: 7 });
		window.__stores.commandsHandler.objectParameters({ parameter: 'frustumCulled', uuid: box.uuid, frustumCulled: false });
		return { renderOrder: box.renderOrder, frustumCulled: box.frustumCulled };
	});
	h.check(recv.renderOrder === 7, 'a peer renderOrder update applies');
	h.check(recv.frustumCulled === false, 'a peer frustumCulled update applies');

	// --- the Inspector renders the new Object section + sends renderOrder ---
	const dom = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__box;
		const input = document.querySelector('#inspector-render-order');
		if (!input) return { present: false };
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		input.value = '3';
		input.dispatchEvent(new Event('change', { bubbles: true }));
		s.peers.set(original);
		const msg = captured.find((m) => m.type === 'objectParameters' && m.parameter === 'renderOrder');
		return { present: true, applied: box.renderOrder, sent: msg?.renderOrder };
	});
	h.check(dom.present, 'the Inspector shows the Object section (render order input)');
	h.check(dom.applied === 3 && dom.sent === 3, `editing render order applies + replicates (${dom.applied})`);

	await h.finish(browser);
});
