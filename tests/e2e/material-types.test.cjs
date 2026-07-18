// Phase 145: the full material-type set in properties. switchMaterialType now
// covers Physical/Lambert/Matcap/Normal/Depth on top of Basic/Standard/Phong/
// Toon/Shadow, carrying shared params (color/opacity/roughness/...) where the
// target supports them, replicating + undoing through the material history.
const h = require('./helpers.cjs');

const WITH_COLOR = ['MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshMatcapMaterial'];
const NO_COLOR = ['MeshNormalMaterial', 'MeshDepthMaterial'];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = group.children[group.children.length - 1];
	});

	// --- every new type is switchable; color carries where the target has it ---
	const results = await A.page.evaluate(
		({ withColor, noColor }) => {
			const M = window.__stores.materialsHandler;
			const box = window.__box;
			const out = [];
			for (const t of [...withColor, ...noColor]) {
				M.switchMaterialType(box.uuid, 'MeshStandardMaterial', false);
				box.material.color.set('#ff8800');
				M.switchMaterialType(box.uuid, t, false);
				out.push({ t, is: box.material.type, hex: box.material.color ? '#' + box.material.color.getHexString() : null });
			}
			return out;
		},
		{ withColor: WITH_COLOR, noColor: NO_COLOR }
	);
	results.forEach((r) => h.check(r.is === r.t, `switches to ${r.t}`));
	h.check(
		results.filter((r) => WITH_COLOR.includes(r.t)).every((r) => r.hex === '#ff8800'),
		'color carries across a switch where the target supports it'
	);
	h.check(
		results.filter((r) => NO_COLOR.includes(r.t)).every((r) => r.hex === null),
		'Normal/Depth have no color to carry (clean drop)'
	);

	// --- shared numeric params survive a switch (roughness Standard -> Physical) ---
	const carried = await A.page.evaluate(() => {
		const M = window.__stores.materialsHandler;
		const box = window.__box;
		M.switchMaterialType(box.uuid, 'MeshStandardMaterial', false);
		M.setMaterialParam(box.uuid, 'roughness', 0.2, false);
		M.switchMaterialType(box.uuid, 'MeshPhysicalMaterial', false);
		return { roughness: box.material.roughness, hasClearcoat: 'clearcoat' in box.material };
	});
	h.check(Math.abs(carried.roughness - 0.2) < 1e-6, `roughness carries Standard -> Physical (${carried.roughness})`);
	h.check(carried.hasClearcoat, 'Physical gains its clearcoat/transmission params');

	// --- a type switch replicates as an objectParameters/material message ---
	const sent = await A.page.evaluate(() => {
		const s = window.__stores;
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		s.materialsHandler.switchMaterialType(window.__box.uuid, 'MeshToonMaterial', true);
		s.peers.set(original);
		const msg = captured.find((m) => m.type === 'objectParameters' && m.parameter === 'material');
		return { has: !!msg, material: msg && msg.material };
	});
	h.check(sent.has && sent.material === 'MeshToonMaterial', 'a type switch replicates via objectParameters');

	// --- and it is undoable through the shared material history ---
	const undo = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__box;
		s.materialsHandler.switchMaterialType(box.uuid, 'MeshBasicMaterial', true);
		const before = box.material.type;
		s.history.undo();
		return { before, after: box.material.type };
	});
	h.check(
		undo.before === 'MeshBasicMaterial' && undo.after === 'MeshToonMaterial',
		`a type switch undoes (${undo.before} -> ${undo.after})`
	);

	await h.finish(browser);
});
