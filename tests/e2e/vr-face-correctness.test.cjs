// Phase 121: face edit correctness — extrude/inset walls wind OUTWARD (were
// backface-culled to invisible), inset stitches a frame ring, and the hover
// highlight reports change once + clears when the ray leaves. Geometry is
// checked directly; in-headset feel is manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- extrude walls face radially outward (visible), perpendicular to N ---
	const walls = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const box = new THREE.BoxGeometry(1, 1, 1);
		const tris = f.readTriangles(box);
		const faces = f.groupFaces(tris);
		const xFace = faces.find((fc) => fc.normal.x > 0.9);
		const before = tris.length;
		const ex = f.extrudeFace(tris, xFace, 0.5);
		// the 8 wall tris are the ones added past the original 12 (cap tris moved)
		const wallTris = ex.slice(before);
		const N = xFace.normal.clone();
		const center = xFace.centroid.clone();
		let minRadial = Infinity;
		let maxPerp = 0;
		for (const t of wallTris) {
			const e1 = t[1].clone().sub(t[0]);
			const e2 = t[2].clone().sub(t[0]);
			const n = e1.cross(e2).normalize();
			const mid = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			const radial = mid.clone().sub(center);
			radial.addScaledVector(N, -radial.dot(N));
			radial.normalize();
			minRadial = Math.min(minRadial, n.dot(radial)); // > 0 = outward
			maxPerp = Math.max(maxPerp, Math.abs(n.dot(N))); // ~0 = perpendicular to N
		}
		return { wallCount: wallTris.length, minRadial, maxPerp };
	});
	h.check(walls.wallCount === 8, `extrude adds 8 wall tris on a cube face (${walls.wallCount})`);
	h.check(walls.minRadial > 0.5, `every wall faces radially OUTWARD (min ${walls.minRadial.toFixed(2)})`);
	h.check(walls.maxPerp < 0.2, `walls are perpendicular to the face normal (max ${walls.maxPerp.toFixed(2)})`);

	// --- negative extrude still produces outward walls ---
	const neg = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const tris = f.readTriangles(new THREE.BoxGeometry(1, 1, 1));
		const faces = f.groupFaces(tris);
		const yFace = faces.find((fc) => fc.normal.y > 0.9);
		const before = tris.length;
		const ex = f.extrudeFace(tris, yFace, -0.4);
		const wallTris = ex.slice(before);
		const N = yFace.normal.clone();
		const center = yFace.centroid.clone();
		let minRadial = Infinity;
		for (const t of wallTris) {
			const n = t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
			const mid = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			const radial = mid.clone().sub(center);
			radial.addScaledVector(N, -radial.dot(N));
			minRadial = Math.min(minRadial, n.dot(radial.normalize()));
		}
		return { wallCount: wallTris.length, minRadial };
	});
	h.check(neg.wallCount === 8 && neg.minRadial > 0.5, `negative extrude walls stay outward (${neg.minRadial.toFixed(2)})`);

	// --- inset frame ring faces the same way the face did (normal ~ N) ---
	const inset = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const tris = f.readTriangles(new THREE.BoxGeometry(1, 1, 1));
		const faces = f.groupFaces(tris);
		const zFace = faces.find((fc) => fc.normal.z > 0.9);
		const before = tris.length;
		const ins = f.insetFace(tris, zFace, 0.3);
		const ringTris = ins.slice(before);
		const N = zFace.normal.clone();
		let minAlign = Infinity;
		for (const t of ringTris) {
			const n = t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
			minAlign = Math.min(minAlign, n.dot(N));
		}
		return { ringCount: ringTris.length, minAlign };
	});
	h.check(inset.ringCount === 8, `inset stitches an 8-tri frame ring (${inset.ringCount})`);
	h.check(inset.minAlign > 0.8, `ring faces outward like the face (align ${inset.minAlign.toFixed(2)})`);

	// --- hover: change reported once, clears on ray-leave, overlay rebuilds once ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__stores.objectActions.selectObject(box.uuid);
		window.__stores.faceEdit.enterFaceEdit(box.uuid);
	});
	await A.page.waitForTimeout(300);
	const hover = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const read = () => {
			let v;
			f.faceEditHighlight.subscribe((x) => (v = x))();
			return v;
		};
		const c1 = f.highlightFaceByTriangle(0); // -1 → face0: change
		const hl1 = read();
		const c2 = f.highlightFaceByTriangle(1); // still face 0 (tri 1 shares it): no change
		const c3 = f.highlightFaceByTriangle(2); // face 1: change
		const cleared = f.clearFaceHighlight(); // → -1: change
		const clearedAgain = f.clearFaceHighlight(); // already -1: no change
		return { c1, hl1, c2, c3, cleared, clearedAgain, after: read() };
	});
	h.check(hover.c1 === true && hover.hl1 === 0, 'first hover sets + reports change');
	h.check(hover.c2 === false, 'hovering the sibling triangle of the same face is no change');
	h.check(hover.c3 === true, 'moving to another face reports change');
	h.check(hover.cleared === true && hover.clearedAgain === false && hover.after === -1, 'ray-leave clears once');

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await h.finish(browser);
});
