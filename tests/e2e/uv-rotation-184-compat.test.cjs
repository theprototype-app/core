// 107-int (claude:9 row for #666, 107-look-fixes) — A 1.84 SCENE WITH A set_uv ROTATION LOOKS THE SAME ON THIS BUILD.
// 107-look-fixes moved set_uv's rotation pivot from the middle of the image (1.84: texture.center = 0.5, 0.5) to its
// corner (the Inspector's Rotation row: center 0, 0) and writes material.userData.texTransform. The pivot change is for
// NEW calls only: a scene saved by 1.84 must open looking the same, on the host that opens the file AND on a guest
// that joins it. If it moves, the release STOPS (claude:9).
//
// TWO TREES: OLD_APP_URL = a BUILT v1.84.0, APP_URL = the union. Without OLD_APP_URL every section prints SKIP.
//   §1 on the release: a box with a checker map, set_uv {tiling: 2, rotation: 0.6} through the release's own tool;
//      premise: the release turned it about the middle (center 0.5, 0.5). A guest joins the release host.
//      Saved the way a user's file is: buildSessionPayload -> exportSessionZip (.tpscene)
//   §2 a union host opens that file (importSessionZip + applySession); a union guest joins it
//   §3 on all four pages: the slot's texture transform (rotation, center, offset, repeat) and its UV matrix, and the
//      map itself rendered offscreen on a unit plane (48 x 48, own renderer, MeshBasicMaterial): union host and union
//      guest equal what 1.84 showed on the same side (matrix to 1e-4, pixels mean |diff| <= 2 / 255). KNOWN: on 1.84 the
//      guest already drew an old rotation about the corner (the join sync has no texture centre): printed as a NOTE
//   §4 a NEW set_uv rotation on the union (corner pivot) looks the same on the union host and the union guest
// Run: OLD_APP_URL=https://theprototype.app:7265/ APP_URL=https://theprototype.app:7262/ node tests/e2e/uv-rotation-184-compat.test.cjs
const h = require('./helpers.cjs');

const OLD_URL = process.env.OLD_APP_URL;
const ROT = 0.6;

/** the box's first-slot map: its transform, its UV matrix and the map drawn alone on a unit plane */
const lookOf = (page, uuid) =>
	page.evaluate(async (u) => {
		const T = window.__tp.test.v1;
		const THREE = T.THREE;
		const g = await new Promise((r) => T.objectsGroup.subscribe((v) => r(v))());
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return { missing: true };
		let mesh = null;
		o.traverse((c) => { if (!mesh && c.isMesh) mesh = c; });
		const mat = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
		const t = mat?.map;
		if (!t) return { noMap: true };
		for (let i = 0; i < 100 && !(t.image && (t.image.complete ?? true) && (t.image.width ?? 1) > 0); i++) await new Promise((r) => setTimeout(r, 100));
		t.updateMatrix();
		const R = (window.__tpUvCompatR = window.__tpUvCompatR || new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false, alpha: false, preserveDrawingBuffer: true }));
		R.setSize(48, 48, false);
		const scene = new THREE.Scene();
		const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
		cam.position.z = 1;
		const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t }));
		scene.add(plane);
		R.render(scene, cam);
		const gl = R.getContext();
		const px = new Uint8Array(48 * 48 * 4);
		gl.readPixels(0, 0, 48, 48, gl.RGBA, gl.UNSIGNED_BYTE, px);
		plane.geometry.dispose();
		plane.material.dispose();
		const r4 = (n) => Math.round(n * 1e4) / 1e4;
		let sum = 0;
		for (let i = 0; i < px.length; i += 4) sum += px[i];
		return {
			rotation: r4(t.rotation),
			center: [r4(t.center.x), r4(t.center.y)],
			offset: [r4(t.offset.x), r4(t.offset.y)],
			repeat: [r4(t.repeat.x), r4(t.repeat.y)],
			matrix: Array.from(t.matrix.elements).map(r4),
			texTransform: mat.userData?.texTransform ?? null,
			px: Array.from(px).filter((_, i) => i % 4 !== 3),
			redSum: sum
		};
	}, uuid);

const pxDiff = (a, b) => {
	if (!a?.px || !b?.px || a.px.length !== b.px.length) return Infinity;
	let d = 0;
	for (let i = 0; i < a.px.length; i++) d += Math.abs(a.px[i] - b.px[i]);
	return d / a.px.length;
};
const matDiff = (a, b) => (a?.matrix && b?.matrix ? Math.max(...a.matrix.map((n, i) => Math.abs(n - b.matrix[i]))) : Infinity);
const show = (l) => JSON.stringify({ rotation: l?.rotation, center: l?.center, offset: l?.offset, repeat: l?.repeat, texTransform: l?.texTransform, missing: l?.missing, noMap: l?.noMap });

h.run(async () => {
	if (!OLD_URL) {
		for (const s of ['§1 release scene', '§2 union opens it', '§3 same look on host and guest'])
			console.log(`SKIP ${s}: OLD_APP_URL not set (a built v1.84.0, e.g. https://theprototype.app:7265/)`);
		return;
	}
	const browser = await h.launch();
	const ctxOpts = { context: { serviceWorkers: 'block' } };
	const tool = (page, name, args) => page.evaluate(([n, a]) => window.__tp.test.v1.aiTools.executeAiTool(n, a), [name, args]);

	// ---- §1 the release makes the scene ----------------------------------------------------------------------
	const R1 = await h.setupPage(browser, 'R1-release-host', { url: OLD_URL, ...ctxOpts });
	const img = await tool(R1.page, 'add_image', { name: 'uvrot184', canvas: { width: 32, height: 32, background: '#884422', ops: [{ op: 'checker', cols: 4, rows: 4, colors: ['#ffffff', '#000000'] }] } });
	h.check(!!img?.hash, '§1 the release makes a checker image: ' + JSON.stringify(img).slice(0, 160));
	const made = await tool(R1.page, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Rotated184', position: [0, 1, 0] }] });
	const box = made?.created?.[0]?.uuid;
	h.check(!!box, '§1 the release makes a box: ' + box);
	const mt = await tool(R1.page, 'set_material', { objects: [box], maps: { albedo: img.hash } });
	h.check(!mt?.error, '§1 the release puts the image on it: ' + JSON.stringify(mt).slice(0, 160));
	const uv = await tool(R1.page, 'set_uv', { objects: [box], tiling: 2, rotation: ROT });
	h.check(!uv?.error, '§1 the release runs set_uv tiling 2, rotation ' + ROT + ': ' + JSON.stringify(uv).slice(0, 200));
	const rel = await lookOf(R1.page, box);
	h.check(rel.rotation === ROT && rel.center[0] === 0.5 && rel.center[1] === 0.5 && rel.repeat[0] === 2, '§1 premise: 1.84 turned it about the middle of the image ' + show(rel));

	const R2 = await h.setupPageQuiet(browser, 'R2-release-guest', [R1], { url: OLD_URL, ...ctxOpts });
	await h.connect(R2, R1);
	let relGuest = null;
	for (let i = 0; i < 40; i++) {
		relGuest = await lookOf(R2.page, box);
		if (relGuest && !relGuest.missing && !relGuest.noMap) break;
		await R2.page.waitForTimeout(500);
	}
	console.log('  release guest: ' + show(relGuest) + ` (matrix diff vs release host ${matDiff(relGuest, rel)}, pixels ${pxDiff(relGuest, rel).toFixed(2)})`);
	const relGuestSame = matDiff(relGuest, rel) <= 1e-4 && pxDiff(relGuest, rel) <= 2;

	const file = await R1.page.evaluate(async () => {
		const s = await window.__tp.test.v1.sessions;
		const payload = s.buildSessionPayload('uv-rotation-184-compat', { thumbnail: false });
		const bytes = await s.exportSessionZip(payload);
		let b = '';
		for (let i = 0; i < bytes.length; i += 0x8000) b += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
		return { b64: btoa(b), size: bytes.length, appVersion: payload.appVersion ?? null };
	});
	h.check(file.size > 0, `§1 saved as a .tpscene (${file.size} bytes, app ${file.appVersion})`);

	// ---- §2 the union opens the file; a guest joins ----------------------------------------------------------
	const U1 = await h.setupPageQuiet(browser, 'U1-union-host', [R1, R2], ctxOpts);
	const opened = await U1.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const u8 = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
		const s = await window.__tp.test.v1.sessions;
		const payload = await s.importSessionZip(u8.buffer);
		if (!payload) return { ok: false, why: 'importSessionZip returned null' };
		const applied = await s.applySession(payload, { backup: false, replicate: false, quiet: true });
		return { ok: applied !== false, why: null };
	}, file.b64);
	h.check(opened.ok, `§2 the union host opens the 1.84 file (${opened.why ?? 'applied'})`);
	let uni = null;
	for (let i = 0; i < 40; i++) {
		uni = await lookOf(U1.page, box);
		if (uni && !uni.missing && !uni.noMap) break;
		await U1.page.waitForTimeout(500);
	}
	const U2 = await h.setupPageQuiet(browser, 'U2-union-guest', [R1, R2, U1], ctxOpts);
	await h.connect(U2, U1);
	let uniGuest = null;
	for (let i = 0; i < 40; i++) {
		uniGuest = await lookOf(U2.page, box);
		if (uniGuest && !uniGuest.missing && !uniGuest.noMap) break;
		await U2.page.waitForTimeout(500);
	}

	// ---- §3 the same look --------------------------------------------------------------------------------------
	console.log('  union host:  ' + show(uni));
	console.log('  union guest: ' + show(uniGuest));
	h.check(uni?.rotation === rel.rotation && uni.center.join() === rel.center.join() && uni.offset.join() === rel.offset.join() && uni.repeat.join() === rel.repeat.join(), '§3 union HOST: the same texture transform as 1.84 (rotation, centre, offset, tiling) ' + show(uni));
	h.check(matDiff(uni, rel) <= 1e-4, `§3 union HOST: the same UV matrix (max diff ${matDiff(uni, rel)})`);
	h.check(pxDiff(uni, rel) <= 2, `§3 union HOST: the map draws the same (mean |diff| ${pxDiff(uni, rel).toFixed(2)} / 255)`);
	// a guest is compared with what the RELEASE's own guest saw: if 1.84 itself showed its guest something else, that
	// is older than 107 and is said, not counted against this build
	const ref = relGuestSame ? rel : relGuest;
	console.log(`  release guest ${relGuestSame ? 'matched its host' : 'DIFFERED from its host on 1.84 already'}: the union guest is held to ${relGuestSame ? 'the release host' : 'the release guest'}`);
	h.check(matDiff(uniGuest, ref) <= 1e-4, `§3 union GUEST: the same UV matrix as on 1.84 (max diff ${matDiff(uniGuest, ref)}) ${show(uniGuest)}`);
	h.check(pxDiff(uniGuest, ref) <= 2, `§3 union GUEST: the map draws the same (mean |diff| ${pxDiff(uniGuest, ref).toFixed(2)} / 255)`);
	// KNOWN, older than 107 (measured 27 Nov on v1.84.0): a 1.84 set_uv rotation turned about the middle (centre 0.5), and
	// the join sync carries no texture centre, so the 1.84 GUEST drew it about the corner. Said, not gated.
	console.log(`NOTE 1.84 itself: the release guest ${relGuestSame ? 'saw what its host saw' : 'drew the rotation about the corner while its host turned it about the middle (no texture centre on the join sync; older than 107)'}`);

	// ---- §4 a NEW set_uv rotation on the union: host and guest agree (107's corner pivot = what the guest receives) ---
	const box2 = (await tool(U1.page, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Rotated185', position: [2, 1, 0] }] }))?.created?.[0]?.uuid;
	// the union host's own image (the release's lives in the release page's library, not here)
	const img2 = await tool(U1.page, 'add_image', { name: 'uvrot185', canvas: { width: 32, height: 32, background: '#884422', ops: [{ op: 'checker', cols: 4, rows: 4, colors: ['#ffffff', '#000000'] }] } });
	await tool(U1.page, 'set_material', { objects: [box2], maps: { albedo: img2.hash } });
	const uv2 = await tool(U1.page, 'set_uv', { objects: [box2], tiling: 2, rotation: ROT });
	h.check(!uv2?.error && /corner/.test(JSON.stringify(uv2)), '§4 the union set_uv turns about the corner and says so: ' + JSON.stringify(uv2).slice(0, 200));
	const n1 = await lookOf(U1.page, box2);
	let n2 = null;
	for (let i = 0; i < 40; i++) {
		n2 = await lookOf(U2.page, box2);
		if (n2 && !n2.missing && !n2.noMap && n2.rotation === ROT) break;
		await U2.page.waitForTimeout(500);
	}
	console.log('  new rotation, union host: ' + show(n1) + ' guest: ' + show(n2));
	h.check(n1?.center?.join() === '0,0' && matDiff(n2, n1) <= 1e-4 && pxDiff(n2, n1) <= 2, `§4 a new rotation looks the same on the union host and guest (matrix diff ${matDiff(n2, n1)}, pixels ${pxDiff(n2, n1).toFixed(2)})`);

	await h.finish(browser);
});
