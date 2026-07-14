// Roadmap #7 N1: note pins anchor to their object and FOLLOW it — for BOTH
// objectsGroup objects and scene-root system/env objects. The scene-root case
// regressed (the pin renderer resolved owners from objectsGroup only, so those
// pins sat at the world origin and never followed). This asserts the rendered
// pin's WORLD position, which the prior annotation coverage never did.
const h = require('./helpers.cjs');

// world position + visibility of the pin for annotation `id`
const pinWorld = (A, id) =>
	A.page.evaluate(
		(pid) =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				window.__stores.annotationsHandler.pinsGroup.subscribe((grp) => {
					const pin = grp?.getObjectByName('pin-' + pid);
					if (!pin) return resolve(null);
					const v = new THREE.Vector3();
					pin.getWorldPosition(v);
					resolve({ pos: [v.x, v.y, v.z], visible: pin.visible });
				})();
			}),
		id
	);

// commit an annotation on `uuid` anchored at world `offset`; return its id
const addNote = (A, uuid, offset, text) =>
	A.page.evaluate(
		({ uuid, offset, text }) => {
			const ah = window.__stores.annotationsHandler;
			ah.addAnnotation(uuid, offset);
			let cur = null;
			ah.activeAnnotation.subscribe((a) => (cur = a))();
			if (cur?.draft) {
				ah.setAnnotation({ ...cur.draft, text });
				ah.activeAnnotation.set(null);
			}
			let list = [];
			ah.annotations.subscribe((l) => (list = l))();
			return list.find((a) => a.text === text)?.id ?? null;
		},
		{ uuid, offset, text }
	);

const near = (a, b, e = 0.05) => a != null && b != null && Math.abs(a - b) < e;
const isOrigin = (p) => Math.abs(p[0]) < 0.01 && Math.abs(p[1]) < 0.01 && Math.abs(p[2]) < 0.01;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- normal object (objectsGroup) ---
	const objUuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const box = g.children[g.children.length - 1];
		box.position.set(2, 0.5, -1);
		box.updateMatrixWorld(true);
		return box.uuid;
	});
	const id1 = await addNote(A, objUuid, [2, 1, -1], 'obj note');
	await A.page.waitForTimeout(350);
	const p1a = await pinWorld(A, id1);
	h.check(
		p1a && p1a.visible && !isOrigin(p1a.pos) && near(p1a.pos[0], 2) && near(p1a.pos[1], 1),
		`objectsGroup pin sits at the anchor, not the origin (${p1a?.pos.map((v) => v.toFixed(2))})`
	);
	await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		o.position.x += 5;
		o.updateMatrixWorld(true);
	}, objUuid);
	await A.page.waitForTimeout(350);
	const p1b = await pinWorld(A, id1);
	h.check(near(p1b?.pos[0], p1a.pos[0] + 5), `objectsGroup pin follows the object (${p1a.pos[0].toFixed(2)}->${p1b?.pos[0].toFixed(2)})`);

	// --- scene-root system object (the regression) ---
	const sysUuid = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				window.__stores.globalScene.subscribe((scene) => {
					const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
					mesh.name = 'sys-anchor';
					mesh.position.set(-4, 0.5, 0);
					mesh.updateMatrixWorld(true);
					scene.add(mesh);
					window.__sysMesh = mesh;
					resolve(mesh.uuid);
				})();
			})
	);
	const id2 = await addNote(A, sysUuid, [-4, 1.2, 0], 'sys note');
	await A.page.waitForTimeout(350);
	const p2a = await pinWorld(A, id2);
	h.check(
		p2a && p2a.visible && !isOrigin(p2a.pos) && near(p2a.pos[0], -4) && near(p2a.pos[1], 1.2),
		`scene-root pin anchors to the object, NOT the world origin (${p2a?.pos.map((v) => v.toFixed(2))})`
	);
	await A.page.evaluate(() => {
		window.__sysMesh.position.y += 2;
		window.__sysMesh.updateMatrixWorld(true);
	});
	await A.page.waitForTimeout(350);
	const p2b = await pinWorld(A, id2);
	h.check(near(p2b?.pos[1], p2a.pos[1] + 2), `scene-root pin follows the object (${p2a.pos[1].toFixed(2)}->${p2b?.pos[1].toFixed(2)})`);

	await h.finish(browser);
});
