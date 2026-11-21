// 102 — GAUSSIAN SPLATS: a captured scene (.ply / .spz / .splat) as an object in the shared scene.
//
// A splat object is a CARRIER mesh holding `userData.splat` (an invisible box over the scan: the hit
// proxy); Spark draws the splats at the scene root, glued to it every frame. The bytes are a Library
// file by content hash: the record replicates, the bytes ride the asset share. Fixtures are made
// HERE, procedurally (a coloured shell of splats) — no scan data in the repo.
//
//   §0 feature unused = zero change: a scene with no splat loads no Spark chunk and no runtime
//   §1 import a .splat on A through the Import picker: one carrier, the record (count, bounds), the
//      runtime draws it (ready, visible, every splat); B receives the carrier AND pulls the bytes
//   §2 the frame shows it: opacity 0 vs 1 changes the pixels where the scan is
//   §3 opacity + crop box on A replicate to B; the proxy box follows the crop; undo reverts both peers
//   §4 the .ply gate: a mesh .ply is refused (no Library item); a small 3DGS .ply is stored as it is;
//      an over-25 MB .ply asks, and "Make a smaller copy" stores a .spz under the cap with every splat
//   §5 Photo parity + Cinematic: the carrier is left out of a Photo (counted), Spark meshes are
//      helpers; Cinematic mode hides the splat meshes and the chip names "Gaussian splats"
//   §6 save + reload: an autosave restores the carrier and the runtime draws it again from the Library;
//      a lane-saved .tpscene bundles the bytes (scene asset group "splats")
//   §7 mesh edit refuses a splat; the Inspector shows the Splat section, no Material / Physics
//
// Counterfactual: v1.70.0 has no splat kind — the import toasts "Unsupported", §1 onward is red.
// Run: e2e-slot --dev <lane> 7076 -- env APP_URL=https://theprototype.app:7076/ npm run e2e -- splats
const h = require('./helpers.cjs');

const OUT = process.env.E2E_OUT ?? 'test-results/102-splats';

// ---- procedural fixtures ----------------------------------------------------------------------

/** a deterministic PRNG (mulberry32) @param {number} seed */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** n points on a shell of radius r around [0, 0.5, 0], coloured by height @param {number} n @param {number} seed */
function shell(n, seed = 7, r = 0.5) {
	const rand = rng(seed);
	const pts = [];
	for (let i = 0; i < n; i++) {
		const u = rand() * 2 - 1;
		const t = rand() * Math.PI * 2;
		const s = Math.sqrt(1 - u * u);
		const x = r * s * Math.cos(t);
		const y = 0.5 + r * u;
		const z = r * s * Math.sin(t);
		pts.push({ x, y, z, cr: 0.9, cg: 0.2 + 0.6 * ((u + 1) / 2), cb: 0.1 });
	}
	return pts;
}

/** the antimatter15 .splat layout: 32 bytes per splat @param {number} n */
function splatFile(n) {
	const buf = Buffer.alloc(n * 32);
	shell(n).forEach((p, i) => {
		const o = i * 32;
		buf.writeFloatLE(p.x, o);
		buf.writeFloatLE(p.y, o + 4);
		buf.writeFloatLE(p.z, o + 8);
		for (let k = 0; k < 3; k++) buf.writeFloatLE(0.03, o + 12 + k * 4);
		buf[o + 24] = Math.round(p.cr * 255);
		buf[o + 25] = Math.round(p.cg * 255);
		buf[o + 26] = Math.round(p.cb * 255);
		buf[o + 27] = 255;
		buf[o + 28] = 255; // rotation w = 1 (128 + 127)
		buf[o + 29] = 128;
		buf[o + 30] = 128;
		buf[o + 31] = 128;
	});
	return buf;
}

/** a 3DGS .ply (binary, SH degree `sh`) @param {number} n @param {number} sh */
function gaussianPly(n, sh = 0) {
	const rest = [0, 9, 24, 45][sh];
	const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: rest }, (_, i) => 'f_rest_' + i), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
	const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => 'property float ' + p).join('\n')}\nend_header\n`;
	const head = Buffer.from(header, 'ascii');
	const body = Buffer.alloc(n * props.length * 4);
	const C0 = 0.28209479177387814;
	let o = 0;
	const w = (/** @type {number} */ v) => {
		body.writeFloatLE(v, o);
		o += 4;
	};
	for (const p of shell(n, 11)) {
		w(p.x), w(p.y), w(p.z), w(0), w(0), w(0);
		w((p.cr - 0.5) / C0), w((p.cg - 0.5) / C0), w((p.cb - 0.5) / C0);
		for (let i = 0; i < rest; i++) w(0.01 * ((i % 5) - 2));
		w(4); // logit opacity: ~0.98
		w(Math.log(0.03)), w(Math.log(0.03)), w(Math.log(0.03));
		w(1), w(0), w(0), w(0);
	}
	return Buffer.concat([head, body]);
}

const MESH_PLY = Buffer.from(
	'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n',
	'ascii'
);

// ---- page helpers -----------------------------------------------------------------------------

/** @param {any} page */
const dbg = (page) => page.evaluate(() => window.__tp.test.v1.splatTick.splatDebug());
/** @param {any} page */
const carriers = (page) =>
	page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const out = [];
		g.traverse((o) => {
			if (o.isMesh && o.userData?.splat) {
				o.geometry.computeBoundingBox();
				const b = o.geometry.boundingBox;
				out.push({ uuid: o.uuid, name: o.name, splat: JSON.parse(JSON.stringify(o.userData.splat)), box: [...b.min.toArray(), ...b.max.toArray()], pos: o.position.toArray() });
			}
		});
		return out;
	});
/** @param {any} page */
const items = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__tp.test.v1.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.map((it) => ({ id: it.id, name: it.name, kind: it.kind, size: it.size, hash: it.hash }));
	});
/** @param {any} page */
const toasts = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__tp.test.v1.toastStore.subscribe((x) => (v = x))();
		return v.map((t) => String(t.text ?? ''));
	});
/** @param {any} page @param {string} name @param {Buffer} buffer */
const pick = (page, name, buffer) => page.setInputFiles('#import-file', { name, mimeType: 'application/octet-stream', buffer });
/** @param {any} page @param {string} uuid */
const entry = async (page, uuid) => (await dbg(page)).entries.find((/** @type {any} */ e) => e.uuid === uuid) ?? null;
const near = (/** @type {number} */ a, /** @type {number} */ b, eps = 0.06) => Math.abs(a - b) <= eps;
/** h.eventually that hands back the value it settled on @template T @param {() => Promise<T>} fn @param {(v: T) => boolean} pred @param {string} label @param {number} [timeout] @returns {Promise<T>} */
async function until(fn, pred, label, timeout = 10000) {
	/** @type {any} */
	let last;
	await h.eventually(async () => (last = await fn()), pred, label, timeout);
	return last;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	/** @type {string[]} */
	const sparkRequests = [];
	A.page.on('request', (/** @type {any} */ r) => {
		if (/spark/i.test(r.url())) sparkRequests.push(r.url());
	});
	await h.connect(B, A);

	// ---- §0 feature unused -------------------------------------------------------------------
	await A.page.waitForTimeout(1500);
	const d0 = await dbg(A.page);
	h.check(!d0.runtimeLoaded && !d0.sparkLoaded, '§0 no splat in the scene: the splat runtime and Spark are not loaded');
	h.check(sparkRequests.length === 0, `§0 ...and no Spark chunk was requested (${sparkRequests.length})`);
	h.check((await carriers(A.page)).length === 0, '§0 no carrier objects');

	// ---- §1 import a .splat ------------------------------------------------------------------
	const N = 2000;
	await pick(A.page, 'shell.splat', splatFile(N));
	await h.eventually(() => carriers(A.page), (c) => c.length === 1, '§1 premise: A has one splat carrier after the import', 20000);
	const [cA] = await carriers(A.page);
	console.log(`  record ${JSON.stringify({ ...cA.splat, bounds: cA.splat.bounds.map((v) => +v.toFixed(3)) })} pos ${cA.pos.map((v) => +v.toFixed(3))}`);
	h.check(cA.splat.count === N && cA.splat.file === 'shell.splat' && /^[0-9a-f]{64}$/.test(cA.splat.hash), `§1 the record: ${N} splats, the file, its content hash`);
	const b = cA.splat.bounds;
	h.check(near(b[0], -0.5) && near(b[3], 0.5) && near(b[1], 0) && near(b[4], 1) && near(b[2], -0.5) && near(b[5], 0.5), `§1 bounds hug the shell (${b.map((v) => v.toFixed(2)).join(' ')})`);
	h.check(near(cA.pos[1] + b[1], 0, 0.02), `§1 placed with its bottom on the ground (y ${(cA.pos[1] + b[1]).toFixed(3)})`);
	const eA = await until(() => entry(A.page, cA.uuid), (e) => !!e && e.state === 'ready' && e.visible, '§1 A draws it (runtime ready, visible)', 30000);
	h.check(!!eA && eA.numSplats === N, `§1 ...every splat (${eA?.numSplats})`);
	h.check((await items(A.page)).some((it) => it.kind === 'splat' && it.hash === cA.splat.hash), '§1 the file is in A\'s Library as a splat item');
	const eB = await until(() => entry(B.page, cA.uuid), (e) => !!e && e.state === 'ready' && e.visible, '§1 B received the carrier, pulled the bytes and draws it', 45000);
	h.check(!!eB && eB.numSplats === N, `§1 ...B draws every splat too (${eB?.numSplats})`);

	// ---- §2 the frame shows it ---------------------------------------------------------------
	await A.page.evaluate((u) => {
		const v1 = window.__tp.test.v1;
		let cam;
		v1.globalCamera.subscribe((c) => (cam = c))();
		cam.position.set(0, 0.6, 2.2);
		cam.lookAt(0, 0.5, 0);
		v1.TControls?.subscribe?.((t) => t?.detach?.())?.();
		v1.selectedObjects.set([]);
		v1.selectedObject.set(null);
		void u;
	}, cA.uuid);
	await A.page.waitForTimeout(600);
	const shotOn = await h.grabFrame(A);
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { opacity: 0 }), cA.uuid);
	await h.eventually(() => entry(A.page, cA.uuid), (e) => !!e && !e.visible, '§2 premise: opacity 0 hides the splat mesh', 5000);
	await A.page.waitForTimeout(400);
	const shotOff = await h.grabFrame(A);
	const delta = await h.frameDelta(A.page, shotOn, shotOff);
	console.log(`  frame delta on vs off: ${JSON.stringify(delta)}`);
	h.check(delta.fraction > 0.02, `§2 the splats change the frame (${(delta.fraction * 100).toFixed(1)} % of pixels)`);
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { opacity: 1 }), cA.uuid);

	// ---- §3 opacity + crop replicate, undo ---------------------------------------------------
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { opacity: 0.5 }), cA.uuid);
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { crop: [-0.5, 0, -0.5, 0.5, 0.5, 0.5] }), cA.uuid);
	const recB = await until(
		async () => (await carriers(B.page)).find((c) => c.uuid === cA.uuid),
		(c) => !!c && c.splat.opacity === 0.5 && Array.isArray(c.splat.crop),
		'§3 B has the opacity and the crop box',
		10000
	);
	h.check(!!recB && near(recB.box[4], 0.5, 1e-3) && near(recB.box[1], 0, 1e-3), `§3 B's proxy box follows the crop (y ${recB?.box[1]}..${recB?.box[4]})`);
	const cropB = await until(() => entry(B.page, cA.uuid), (e) => !!e && e.crop !== '', '§3 B applied the crop edit to the splats', 5000);
	h.check(!!cropB, '§3 ...as a Spark edit');
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	const undone = await until(
		async () => (await carriers(B.page)).find((c) => c.uuid === cA.uuid),
		(c) => !!c && c.splat.crop === null,
		'§3 undo on A removes the crop on B',
		10000
	);
	h.check(!!undone && undone.splat.opacity === 0.5, '§3 ...one step: the opacity stays');

	// ---- §4 the .ply gate --------------------------------------------------------------------
	const before = (await items(A.page)).length;
	await pick(A.page, 'triangle.ply', MESH_PLY);
	await h.eventually(() => toasts(A.page), (t) => t.some((x) => /triangle\.ply is a mesh, not a Gaussian splat/.test(x)), '§4 a mesh .ply is refused with the way out', 10000);
	h.check((await items(A.page)).length === before, '§4 ...and nothing entered the Library');
	await pick(A.page, 'small.ply', gaussianPly(500, 1));
	await h.eventually(() => carriers(A.page), (c) => c.some((x) => x.splat.file === 'small.ply'), '§4 a small 3DGS .ply imports as it is', 20000);
	const small = (await carriers(A.page)).find((x) => x.splat.file === 'small.ply');
	h.check(small?.splat.count === 500 && small?.splat.sh === 1, `§4 ...500 splats, one colour band (${small?.splat.count}, sh ${small?.splat.sh})`);
	const BIG = 110000;
	const big = gaussianPly(BIG, 3);
	console.log(`  big .ply ${(big.length / 1048576).toFixed(1)} MB`);
	await pick(A.page, 'big.ply', big);
	await h.eventually(
		() => A.page.evaluate(() => {
			let d;
			window.__tp.test.v1.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
			return d ? { id: d.id, title: d.title, message: d.message, items: d.items } : null;
		}),
		(d) => !!d && d.id === 'splat-reduce',
		'§4 an over-cap .ply asks to make a smaller copy',
		30000
	);
	await A.page.evaluate(() => window.__tp.test.v1.confirmDialog.resolveConfirm('reduce'));
	await h.eventually(() => carriers(A.page), (c) => c.some((x) => x.splat.file === 'big.spz'), '§4 the smaller copy is placed as big.spz', 90000);
	const bigItem = (await items(A.page)).find((it) => it.name === 'big.spz');
	const bigRec = (await carriers(A.page)).find((x) => x.splat.file === 'big.spz');
	h.check(!!bigItem && bigItem.size <= 25 * 1024 * 1024, `§4 ...under the 25 MB cap (${((bigItem?.size ?? 0) / 1048576).toFixed(1)} MB from ${(big.length / 1048576).toFixed(1)} MB)`);
	h.check(bigRec?.splat.count === BIG, `§4 ...every splat kept (${bigRec?.splat.count})`);
	h.check(!(await items(A.page)).some((it) => it.name === 'big.ply'), '§4 the over-cap original is not stored');

	// ---- §5 Photo parity + Cinematic ---------------------------------------------------------
	const photo = await A.page.evaluate(async () => {
		const { meshKind, parityNotes } = await import('/src/lib/photo/photoCore.js');
		let g, scene;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		window.__tp.test.v1.globalScene.subscribe((v) => (scene = v))();
		const kinds = [];
		scene.traverse((o) => {
			if (o.userData?.splat || o.userData?.splatVisual) kinds.push(meshKind(o));
		});
		return { kinds, notes: parityNotes({ 'skip-splat': kinds.filter((k) => k === 'skip-splat').length }) };
	});
	h.check(photo.kinds.filter((k) => k === 'skip-splat').length === 3 && photo.kinds.every((k) => k === 'skip-splat' || k === 'skip-helper'), `§5 Photo: three carriers counted, Spark meshes are helpers (${photo.kinds.join(' ')})`);
	h.check(/Gaussian splats/.test(photo.notes[0]?.note ?? ''), '§5 ...and the parity note names them');
	await A.page.evaluate(() => window.__tp.test.v1.cinematicState.cinematicState.update((s) => ({ ...s, mode: 'on' })));
	await h.eventually(() => dbg(A.page), (d) => d.entries.every((e) => !e.visible), '§5 Cinematic on: every splat mesh stands down', 5000);
	await A.page.evaluate(() => window.__tp.test.v1.cinematicState.cinematicState.update((s) => ({ ...s, mode: 'off' })));
	await h.eventually(() => dbg(A.page), (d) => d.entries.filter((e) => e.state === 'ready').every((e) => e.visible), '§5 Cinematic off: they draw again', 5000);

	// ---- §6 save + reload --------------------------------------------------------------------
	const zipHasSplat = await A.page.evaluate(async (hash) => {
		const s = window.__tp.test.v1.sessions;
		const payload = s.buildSessionPayload('splat save');
		const assets = await import('/src/lib/sceneAssets.js');
		let list = [];
		assets.refreshSceneAssets();
		await new Promise((r) => setTimeout(r, 500));
		assets.sceneAssets.subscribe((v) => (list = v))();
		return { listed: list.some((e) => e.group === 'splats' && e.hash === hash), objects: JSON.stringify(payload.objects ?? '').includes(hash) };
	}, cA.splat.hash);
	h.check(zipHasSplat.listed, '§6 the scan is a scene asset (Scene ▸ splats), so a .tpscene bundles its bytes');
	h.check(zipHasSplat.objects, '§6 the saved objects carry the record');
	await A.page.evaluate(async () => {
		window.__tp.test.v1.autosave.autosaveEnabled.set(true);
		await window.__tp.test.v1.autosave.saveNow();
	});
	await h.freshReload(A);
	await h.answerRestore(A, 'restore', 30000);
	const back = await until(() => carriers(A.page), (c) => c.length === 3, '§6 the reload restores the three splat objects', 30000);
	h.check(!!back && back.find((c) => c.uuid === cA.uuid)?.splat.opacity === 0.5, '§6 ...with their records');
	const eR = await until(() => entry(A.page, cA.uuid), (e) => !!e && e.state === 'ready' && e.visible, '§6 the runtime draws it again from the Library', 30000);
	h.check(eR?.numSplats === N, `§6 ...every splat (${eR?.numSplats})`);

	// ---- §7 edit guards + Inspector ----------------------------------------------------------
	await A.page.evaluate((u) => window.__tp.test.v1.meshEdit?.enterEditMode?.(u), cA.uuid);
	await h.eventually(() => toasts(A.page), (t) => t.some((x) => /Gaussian splat: its box is only a click target/.test(x)), '§7 mesh edit refuses a splat', 5000);
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), cA.uuid);
	const insp = await until(
		() => A.page.evaluate(() => ({ facts: document.querySelector('#splat-facts')?.textContent ?? '', opacity: !!document.querySelector('#splat-opacity') })),
		(x) => /2,000 splats/.test(x.facts) && x.opacity,
		'§7 the Inspector shows the Splat section',
		15000
	);
	h.check(!!insp, `§7 ...facts "${insp?.facts.trim()}"`);
	await A.page.screenshot({ path: `${OUT}/splats-inspector.png` }).catch(() => {});

	await h.finish(browser);
});
