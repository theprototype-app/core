// Phase 191: a VR-created face is wound to face the VIEWER (the side you look
// from), not the mesh centre — otherwise you look at the back and see nothing.
// createFaceFromVerts(uuid, verts, viewerPos) flips the winding toward viewerPos.
const h = require('./helpers.cjs');

const triNormal = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		const p = box.geometry.attributes.position;
		const n = p.count;
		const a = new THREE.Vector3(p.getX(n - 3), p.getY(n - 3), p.getZ(n - 3));
		const b = new THREE.Vector3(p.getX(n - 2), p.getY(n - 2), p.getZ(n - 2));
		const c = new THREE.Vector3(p.getX(n - 1), p.getY(n - 1), p.getZ(n - 1));
		const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
		return normal.y;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		return box.uuid;
	});
	// three top-face corners of a unit box (a valid triangle on the +Y plane)
	const verts = [
		{ x: -0.5, y: 0.5, z: -0.5 },
		{ x: 0.5, y: 0.5, z: -0.5 },
		{ x: 0.5, y: 0.5, z: 0.5 }
	];

	// viewer ABOVE (+Y) -> the created face's normal should point up toward them
	const okAbove = await A.page.evaluate(({ u, verts }) => {
		const s = window.__stores;
		return s.faceEdit.createFaceFromVerts(u, verts, new s.THREE.Vector3(0, 5, 0));
	}, { u: uuid, verts });
	const nyAbove = await triNormal(A.page);

	await A.page.evaluate(() => window.__stores.history.undo());

	// viewer BELOW (-Y) -> the winding flips so the normal points down toward them
	await A.page.evaluate(({ u, verts }) => {
		const s = window.__stores;
		return s.faceEdit.createFaceFromVerts(u, verts, new s.THREE.Vector3(0, -5, 0));
	}, { u: uuid, verts });
	const nyBelow = await triNormal(A.page);

	h.check(okAbove === true, 'createFaceFromVerts builds the face');
	h.check(nyAbove > 0.5, `viewer above -> face normal points up toward them (${nyAbove.toFixed(2)})`);
	h.check(nyBelow < -0.5, `viewer below -> winding flips, normal points down toward them (${nyBelow.toFixed(2)})`);

	await h.finish(browser);
});
