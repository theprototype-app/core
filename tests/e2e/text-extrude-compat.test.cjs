// 64-int — OLD 3D TEXT ON THE NEW BUILDER (#657, lane 64-extrude). Text's extrude no longer goes through three's
// ExtrudeGeometry (the builder shipped from 1.61 to 1.79) but through the mesh-kernel solid builder
// (src/lib/vector/vectorSolid.js, called from text3dBuild.buildExtruded). The ROW: scenes with extruded text saved
// on 1.61-1.79 open on this build looking the same, building no slower and no heavier, and Bake still gives the
// same kind of mesh. If old text looks different, the fix would be to keep the old builder path for old records.
//
// TWO TREES (the vector-old-peer pattern): the RELEASE is a v1.78.0 production build at OLD_APP_URL (its text
// builder is the 1.61 one: ExtrudeGeometry), the UNION is APP_URL. Without OLD_APP_URL every section prints SKIP and
// the run is green.
//   §0 premise: the release builds an ExtrudeGeometry, the union a plain BufferGeometry with the kernel's face
//      partition (`__topo`) — the two pages really run two different builders
//   §1 on a RELEASE page, with the release's own APIs (textPathEdit.createTextObject, textFonts.addGoogleFont with
//      Google mocked), five extruded texts: FLAT (depth 0 -> the record's 1 mm, no bevel), DEEP (60 cm), BEVELLED
//      (serif, a wide 4-segment bevel, letters with acute corners), a 200-letter PARAGRAPH (wrapped) and a GOOGLE-font
//      text; each waits until its solid is built (fonts land async). Saved the way a user's file is:
//      buildSessionPayload -> exportSessionZip (a .tpscene: it carries the Library font)
//   §2 a UNION page opens that file (importSessionZip + applySession), Google blocked: every text builds, from the
//      same record, with the font from the file
//   §3 triangles per text: the union's at most 20 % above the release's
//   §4 build time per text: text3dBuild.buildExtruded called directly on the page's own record + font (both builds
//      expose it), the shape key salted so the cache never answers; median of 2 x 7 rebuilds per page, rendering
//      paused on both pages: the union at most 20 % slower (+1 ms timer floor per text; the five summed: 20 % flat)
//   §5 silhouette: each text's geometry alone, rendered offscreen (own WebGLRenderer, orthographic camera, flat white
//      DoubleSide material, no lights / outline / post) from the FRONT and from the SIDE (the bevel profile), with the
//      SAME frame on both pages (the union of both bounding boxes). Binary masks compared: XOR / union <= 3 %, the
//      bounding-box edges within 6 px, and every boundary pixel within 6 px of the other mask's boundary (Hausdorff).
//      The masks are written as PGM to E2E_OUT (white both, light grey release only, dark grey union only)
//   §6 Bake of the bevelled text on both pages: the same mesh class (isMesh, object/geometry type, indexed or not,
//      gtype, record dropped, materials, material groups, normals); the union's extra face partition is printed and
//      must be a partition of exactly its own triangles
//   §7 no page errors on either page
// Every check line prints the measured numbers.
// Run: OLD_APP_URL=https://theprototype.app:7231/ APP_URL=https://theprototype.app:<union port>/ node tests/e2e/text-extrude-compat.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const OLD_URL = process.env.OLD_APP_URL;
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.env.E2E_OUT ?? 'test-results/text-extrude-compat';
const GOOGLE_FILE = path.join(ROOT, 'static', 'fonts', 'ibm-plex-sans-latin.woff2'); // served as Google's file for "Lobster"

const DRIFT_MAX = 0.03; // the pixel rule: XOR / union
const EDGE_MAX_PX = 6; // ...and every edge / target within 6 px
const SLOWER_MAX = 1.2; // build time and triangles: not worse by more than 20 %
const TIMER_FLOOR_MS = 1;
const ROUNDS = 2;
const BUILDS_PER_ROUND = 7;
const MAX_W = 1024;
const MAX_H = 768;

const PARAGRAPH = (() => {
	const base = 'The quick brown fox jumps over the lazy dog while seven wizards quietly box a jar of mixed nuts; ';
	let s = '';
	while (s.length < 200) s += base;
	return s.slice(0, 199) + '.';
})();

/** the five texts a 1.61-1.79 scene holds. `side: false` = no side profile to compare (a 1 mm slab) */
const TEXTS = [
	{ key: 'flat', at: [-3, 1, -4], side: false, patch: { text: 'Flat 1.61', mode: 'extruded', depth: 0, bevel: { size: 0 } } },
	{ key: 'deep', at: [0, 1, -4], side: true, patch: { text: 'DEEP 60', mode: 'extruded', depth: 0.6 } },
	{
		key: 'bevelled',
		at: [3, 1, -4],
		side: true,
		patch: { text: 'BEVEL AVW', mode: 'extruded', font: 'serif', depth: 0.15, bevel: { size: 0.02, thickness: 0.03, segments: 4 } }
	},
	{ key: 'paragraph', at: [0, 3, -6], side: true, patch: { text: PARAGRAPH, mode: 'extruded', font: 'plex-sans', size: 0.12, maxWidth: 3, depth: 0.04 } },
	{ key: 'google', at: [0, -1, -4], side: true, patch: { text: 'Google Ag&', mode: 'extruded', depth: 0.12 } } // + the Library font, below
];

/** per text: the runtime's view of the solid and the carrier's geometry @param {any} page @param {string[]} uuids */
const states = (page, uuids) =>
	page.evaluate((list) => {
		const T = window.__tp.test.v1;
		const dbg = T.textPath.textPathDebug();
		/** @type {any} */ let g;
		T.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		/** @type {Record<string, any>} */
		const out = {};
		for (const u of list) {
			const d = dbg.find((/** @type {any} */ x) => x.uuid === u);
			const o = g?.getObjectByProperty('uuid', u);
			const geo = o?.geometry;
			const verts = geo?.getAttribute?.('position')?.count ?? 0;
			out[u] = {
				mode: d?.mode ?? null,
				building: !!d?.solid?.building,
				tris: d?.solid?.triangles ?? 0,
				drawn: d?.solid?.drawn ?? null,
				missing: d?.solid?.missing ?? null,
				font: d?.font ?? null,
				fontUrl: String(d?.fontUrl ?? '').slice(0, 48),
				geoTris: geo ? (geo.index ? geo.index.count : verts) / 3 : 0,
				geoType: geo?.type ?? null,
				topo: !!geo?.userData?.__topo,
				castShadow: !!o?.castShadow,
				rec: o?.userData?.textPath ? JSON.stringify(o.userData.textPath) : null
			};
		}
		return out;
	}, uuids);

/** a solid that is built and is what the carrier shows (not the save's placeholder, not a sans stand-in) */
const isBuilt = (/** @type {any} */ s, /** @type {boolean} */ library) =>
	!!s && s.mode === 'extruded' && !s.building && s.tris > 0 && s.geoTris === s.tris && s.castShadow && (!library || s.fontUrl.startsWith('blob:'));

/** wait until every text is built and STAYS the same for two reads 1.5 s apart (a font landing rebuilds it) */
async function untilBuilt(page, made, label, timeout = 90000) {
	const uuids = Object.values(made);
	const t0 = Date.now();
	let prev = null;
	let last = null;
	while (Date.now() - t0 < timeout) {
		last = await states(page, uuids);
		const ok = Object.entries(made).every(([k, u]) => isBuilt(last[u], k === 'google'));
		const sig = JSON.stringify(uuids.map((u) => [last[u].tris, last[u].font, last[u].fontUrl]));
		if (ok && prev === sig) {
			h.check(true, `${label} (${Date.now() - t0} ms; ${Object.entries(made).map(([k, u]) => `${k} ${last[u].tris} tris`).join(', ')})`);
			return last;
		}
		prev = ok ? sig : null;
		await page.waitForTimeout(1500);
	}
	console.log('  last: ' + JSON.stringify(last));
	h.check(false, label);
	return last;
}

/** the geometry's local bounding box [minX, minY, minZ, maxX, maxY, maxZ] per uuid */
const bboxes = (page, uuids) =>
	page.evaluate((list) => {
		/** @type {any} */ let g;
		window.__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		/** @type {Record<string, number[] | null>} */
		const out = {};
		for (const u of list) {
			const geo = g?.getObjectByProperty('uuid', u)?.geometry;
			if (!geo) {
				out[u] = null;
				continue;
			}
			geo.computeBoundingBox();
			const b = geo.boundingBox;
			out[u] = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
		}
		return out;
	}, uuids);

/** one frame for both pages: the union of the two boxes, padded, isotropic pixels */
function viewFor(kind, a, b) {
	const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
	const hi = [0, 1, 2].map((i) => Math.max(a[i + 3], b[i + 3]));
	const c = lo.map((v, i) => (v + hi[i]) / 2);
	const [ha, va] = kind === 'front' ? [0, 1] : [2, 1];
	const pad = 0.05 * Math.max(hi[ha] - lo[ha], hi[va] - lo[va]);
	const fw = hi[ha] - lo[ha] + 2 * pad;
	const fh = hi[va] - lo[va] + 2 * pad;
	const px = Math.max(fw / MAX_W, fh / MAX_H);
	const W = Math.max(16, Math.ceil(fw / px));
	const H = Math.max(16, Math.ceil(fh / px));
	const far = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 20;
	// front: looking down -z; side: from +x looking down -x (screen right = -z)
	const eye = kind === 'front' ? [c[0], c[1], hi[2] + 10] : [hi[0] + 10, c[1], c[2]];
	return { kind, W, H, w: W * px, h: H * px, px, eye, at: c, far };
}

/**
 * Render ONE text's geometry alone into a target and return its mask (bit-packed, base64). The same code on both
 * builds: the page's own THREE, an own small WebGLRenderer (the app's renderer, its tone mapping, outline and post
 * passes stay out of it), an orthographic camera, a flat white DoubleSide material on black.
 */
const renderMask = (page, uuid, view) =>
	page.evaluate(
		({ u, v }) => {
			const T = window.__tp.test.v1;
			const THREE = T.THREE;
			/** @type {any} */ let g;
			T.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
			const o = g?.getObjectByProperty('uuid', u);
			if (!o?.geometry) return null;
			const geo = o.geometry;
			const verts = geo.getAttribute?.('position')?.count ?? 0;
			/** @type {any} */ const w = window;
			let R = w.__tpTextCompatRenderer;
			let shared = false;
			if (!R) {
				try {
					R = w.__tpTextCompatRenderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false, alpha: false });
				} catch {
					R = null;
				}
			}
			if (!R) {
				// no second context: the app's renderer, its state put back afterwards
				T.globalRenderer.subscribe((/** @type {any} */ x) => (R = x))();
				shared = true;
			}
			const rt = new THREE.WebGLRenderTarget(v.W, v.H);
			const scene = new THREE.Scene();
			const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
			scene.add(new THREE.Mesh(geo, mat)); // the carrier's own geometry, in its own frame (one material: every group drawn)
			const cam = new THREE.OrthographicCamera(-v.w / 2, v.w / 2, v.h / 2, -v.h / 2, 0.001, v.far);
			cam.position.set(v.eye[0], v.eye[1], v.eye[2]);
			cam.up.set(0, 1, 0);
			cam.lookAt(v.at[0], v.at[1], v.at[2]);
			cam.updateMatrixWorld();
			cam.updateProjectionMatrix();
			const was = R.getRenderTarget();
			const clear = new THREE.Color();
			R.getClearColor(clear);
			const clearA = R.getClearAlpha();
			const autoClear = R.autoClear;
			R.setRenderTarget(rt);
			R.setClearColor(0x000000, 1);
			R.autoClear = true;
			R.clear();
			R.render(scene, cam);
			const buf = new Uint8Array(v.W * v.H * 4);
			R.readRenderTargetPixels(rt, 0, 0, v.W, v.H, buf);
			R.setRenderTarget(was);
			R.setClearColor(clear, clearA);
			R.autoClear = autoClear;
			rt.dispose();
			mat.dispose();
			const bits = new Uint8Array(Math.ceil((v.W * v.H) / 8));
			let on = 0;
			for (let i = 0; i < v.W * v.H; i++)
				if (buf[i * 4] > 127) {
					bits[i >> 3] |= 1 << (i & 7);
					on++;
				}
			let s = '';
			for (let i = 0; i < bits.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bits.subarray(i, i + 0x8000)));
			return { b64: btoa(s), on, verts, shared };
		},
		{ u: uuid, v: view }
	);

/** render, again when the carrier was parked by an autosave export at that moment (its placeholder has ~12 verts) */
async function maskOf(page, uuid, view, wantVerts) {
	let r = null;
	for (let i = 0; i < 6; i++) {
		r = await renderMask(page, uuid, view);
		if (r && r.verts === wantVerts) break;
		await page.waitForTimeout(500);
	}
	if (!r) return null;
	const packed = Buffer.from(r.b64, 'base64');
	const mask = new Uint8Array(view.W * view.H);
	for (let i = 0; i < mask.length; i++) mask[i] = (packed[i >> 3] >> (i & 7)) & 1;
	return { mask, on: r.on, verts: r.verts, shared: r.shared };
}

/** squared Euclidean distance to the nearest seed pixel (Felzenszwalb & Huttenlocher, separable) */
function edt(seed, W, H) {
	const INF = 1e12;
	const grid = new Float64Array(W * H);
	for (let i = 0; i < W * H; i++) grid[i] = seed[i] ? 0 : INF;
	const n = Math.max(W, H);
	const f = new Float64Array(n);
	const d = new Float64Array(n);
	const v = new Int32Array(n);
	const z = new Float64Array(n + 1);
	const pass = (len) => {
		let k = 0;
		v[0] = 0;
		z[0] = -Infinity;
		z[1] = Infinity;
		for (let q = 1; q < len; q++) {
			let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
			while (s <= z[k]) {
				k--;
				s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
			}
			k++;
			v[k] = q;
			z[k] = s;
			z[k + 1] = Infinity;
		}
		k = 0;
		for (let q = 0; q < len; q++) {
			while (z[k + 1] < q) k++;
			d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
		}
	};
	for (let x = 0; x < W; x++) {
		for (let y = 0; y < H; y++) f[y] = grid[y * W + x];
		pass(H);
		for (let y = 0; y < H; y++) grid[y * W + x] = d[y];
	}
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) f[x] = grid[y * W + x];
		pass(W);
		for (let x = 0; x < W; x++) grid[y * W + x] = d[x];
	}
	return grid;
}

/** the mask's boundary: an object pixel with a background 4-neighbour (or on the image edge) */
function boundary(m, W, H) {
	const b = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (!m[i]) continue;
			if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !m[i - 1] || !m[i + 1] || !m[i - W] || !m[i + W]) b[i] = 1;
		}
	return b;
}

function bboxOfMask(m, W, H) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			if (m[y * W + x]) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
	return [x0, y0, x1, y1];
}

/** release mask `a` vs union mask `b`: drift (XOR / union), bbox edge deltas, boundary Hausdorff distance */
function compareMasks(a, b, W, H) {
	let xor = 0;
	let uni = 0;
	let onlyA = 0;
	let onlyB = 0;
	for (let i = 0; i < W * H; i++) {
		if (a[i] || b[i]) uni++;
		if (a[i] !== b[i]) {
			xor++;
			if (a[i]) onlyA++;
			else onlyB++;
		}
	}
	const ba = bboxOfMask(a, W, H);
	const bb = bboxOfMask(b, W, H);
	const edge = Math.max(...ba.map((v, i) => Math.abs(v - bb[i])));
	const bA = boundary(a, W, H);
	const bB = boundary(b, W, H);
	const dA = edt(bA, W, H);
	const dB = edt(bB, W, H);
	let hd = 0;
	let far = 0; // boundary pixels further than the rule
	for (let i = 0; i < W * H; i++) {
		if (bA[i]) {
			hd = Math.max(hd, dB[i]);
			if (dB[i] > EDGE_MAX_PX * EDGE_MAX_PX) far++;
		}
		if (bB[i]) {
			hd = Math.max(hd, dA[i]);
			if (dA[i] > EDGE_MAX_PX * EDGE_MAX_PX) far++;
		}
	}
	return { xor, uni, onlyA, onlyB, drift: uni ? xor / uni : 1, edge: Number.isFinite(edge) ? edge : Infinity, hausdorff: Math.sqrt(hd), far, ba, bb };
}

/** white = both, light grey = release only, dark grey = union only (rows flipped: GL reads bottom-up) */
function writePgm(file, a, b, W, H) {
	const px = Buffer.alloc(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			px[(H - 1 - y) * W + x] = a[i] && b[i] ? 255 : a[i] ? 170 : b[i] ? 85 : 0;
		}
	fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), px]));
}

/**
 * Time the builder on the page's own record + font: text3dBuild.buildExtruded(rec, url, profile), the same call the
 * runtime makes (both builds expose it as a debug hook). The size is salted by ~1e-10 so the shape-key cache never
 * answers; the glyph-loop cache (flattened outlines, the same code on both builds) is warm, so what is timed is
 * layout + the solid builder. The first build of each round is a warm-up.
 */
const timeBuilds = (page, uuid, n) =>
	page.evaluate(
		async ({ u, count }) => {
			const T = window.__tp.test.v1;
			const rec = T.textPathEdit.setTextPathFor(u, {}); // an empty patch: the normalized record back, no write
			if (!rec) return null;
			const url = await T.textPath.solidFontUrl(rec);
			const profile = T.textPath.textProfile();
			/** @type {any} */ const w = window;
			w.__tpTextCompatSalt = (w.__tpTextCompatSalt ?? 0) + 1;
			const salt = w.__tpTextCompatSalt * 100;
			/** @type {number[]} */
			const ms = [];
			let tris = 0;
			for (let i = 0; i <= count; i++) {
				const r = { ...rec, size: rec.size * (1 + (salt + i + 1) * 1e-10) };
				const t0 = performance.now();
				const out = await T.text3dBuild.buildExtruded(r, url, profile);
				const dt = performance.now() - t0;
				if (i > 0) ms.push(dt);
				tris = out?.info?.triangles ?? 0;
			}
			// the timed builds pushed geometries out of the builder's cache: free every one no object draws
			/** @type {Set<any>} */
			const drawn = new Set();
			T.objectsGroup.subscribe((/** @type {any} */ g) => g?.traverse((/** @type {any} */ o) => o.geometry && drawn.add(o.geometry)))();
			T.text3dBuild.releaseExtruded((/** @type {any} */ geo) => drawn.has(geo));
			return { ms, tris };
		},
		{ u: uuid, count: n }
	);
const median = (/** @type {number[]} */ xs) => {
	const s = [...xs].sort((p, q) => p - q);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pauseAll = (/** @type {any[]} */ peers, on) =>
	Promise.all(
		peers.map((P) =>
			P.page.evaluate((go) => (go ? window.__tp.test.v1.overloadGuard.pauseRendering('e2e: text-extrude-compat timing') : window.__tp.test.v1.overloadGuard.resumeRendering()), on).catch(() => {})
		)
	);

/** Bake the text, then read what kind of mesh it became */
const bakeAndRead = (page, uuid) =>
	page.evaluate(async (u) => {
		const T = window.__tp.test.v1;
		let out = await T.textPathEdit.bakeTextToMesh(u);
		// an autosave export parks the solid while it encodes; Bake then says "still being built": try again, as a user would
		for (let t = 0; !out.ok && /still being built/.test(out.error ?? '') && t < 40; t++) {
			await new Promise((r) => setTimeout(r, 250));
			out = await T.textPathEdit.bakeTextToMesh(u);
		}
		await new Promise((r) => setTimeout(r, 1500)); // past a late runtime build / an autosave park
		/** @type {any} */ let g;
		T.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', u);
		const geo = o?.geometry;
		const mats = Array.isArray(o?.material) ? o.material : [o?.material];
		const topo = geo?.userData?.__topo;
		const verts = geo?.getAttribute?.('position')?.count ?? 0;
		return {
			ok: !!out.ok,
			error: out.error ?? null,
			cls: {
				isMesh: !!o?.isMesh,
				type: o?.type ?? null,
				geometry: geo?.type ?? null,
				indexed: !!geo?.index,
				gtype: o?.userData?.geometryParams?.gtype ?? null,
				record: !!o?.userData?.textPath,
				params: !!geo?.parameters,
				materials: mats.map((m) => m?.type ?? null).join('+'),
				groupMaterials: [...new Set((geo?.groups ?? []).map((/** @type {any} */ gr) => gr.materialIndex))].sort().join(','),
				normals: !!geo?.getAttribute?.('normal'),
				uvs: !!geo?.getAttribute?.('uv')
			},
			verts,
			groups: geo?.groups?.length ?? 0,
			topo: topo ? { faces: topo.counts.length, tris: topo.tris.length, sum: topo.counts.reduce((s, c) => s + c, 0) } : null,
			name: o?.name ?? null
		};
	}, uuid);

h.run(async () => {
	if (!OLD_URL) {
		for (const s of ['§0 builders', '§1 release scene', '§2 union opens it', '§3 triangles', '§4 build time', '§5 silhouette', '§6 bake', '§7 page errors'])
			console.log(`SKIP ${s}: OLD_APP_URL not set (a v1.78.0 production build, e.g. https://theprototype.app:7231/)`);
		return;
	}
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch();
	// a PROD build's service worker would forward the Google fetches past page.route: block it on both pages
	const ctxOpts = { context: { serviceWorkers: 'block' } };

	// ---- §1 the release makes the scene ---------------------------------------------------------
	const R = await h.setupPage(browser, 'R-release', { url: OLD_URL, ...ctxOpts });
	const googleBytes = fs.readFileSync(GOOGLE_FILE);
	let googleCalls = 0;
	await R.page.context().route(/fonts\.(googleapis|gstatic)\.com/, (/** @type {any} */ route) => {
		googleCalls++;
		const u = route.request().url();
		if (u.includes('googleapis.com/css2'))
			return route.fulfill({ status: 200, contentType: 'text/css', body: `/* latin */\n@font-face { font-family: 'Lobster'; src: url(https://fonts.gstatic.com/s/lobster/v30/latin.woff2) format('woff2'); }` });
		return route.fulfill({ status: 200, contentType: 'font/woff2', body: googleBytes });
	});
	const google = await R.page.evaluate(() => window.__tp.test.v1.textFonts.addGoogleFont('Lobster'));
	h.check(!!google?.ok && googleCalls === 2, `§1 premise: the release adds the Google font "Lobster" (mocked: ${googleCalls} requests, ${google?.error ?? google?.font?.hash})`);
	const gpatch = TEXTS.find((t) => t.key === 'google').patch;
	Object.assign(gpatch, { fontAsset: google?.font?.hash, fontName: 'Lobster' });

	/** @type {Record<string, string>} */
	const made = {};
	for (const t of TEXTS) {
		const r = await R.page.evaluate(({ patch, at }) => {
			const out = window.__tp.test.v1.textPathEdit.createTextObject(patch, at);
			return out.object ? { uuid: out.object.uuid } : { error: out.error };
		}, t);
		h.check(!!r.uuid, `§1 the release creates the ${t.key} text (${r.error ?? r.uuid})`);
		if (r.uuid) made[t.key] = r.uuid;
	}
	await R.page.evaluate(() => window.__tp.test.v1.objectActions?.deselectObject?.());
	const relBuilt = await untilBuilt(R.page, made, '§1 the release builds all five solids (fonts land async)');
	for (const [k, u] of Object.entries(made))
		h.check(relBuilt[u]?.missing === 0 && relBuilt[u]?.drawn > 0, `§1 ${k}: ${relBuilt[u]?.drawn} letters drawn, ${relBuilt[u]?.missing} missing (font ${relBuilt[u]?.font})`);

	// ---- §0 premise: two different builders --------------------------------------------------------
	h.check(
		Object.values(made).every((u) => relBuilt[u]?.geoType === 'ExtrudeGeometry' && !relBuilt[u]?.topo),
		`§0 premise: the release builds three's ExtrudeGeometry (${Object.entries(made).map(([k, u]) => `${k} ${relBuilt[u]?.geoType}`).join(', ')})`
	);

	// the user's file: the payload, zipped as a .tpscene with its Library assets (the Google font rides it)
	const file = await R.page.evaluate(async (fontHash) => {
		const T = window.__tp.test.v1;
		T.sceneAssets.refreshSceneAssets?.();
		await new Promise((r) => setTimeout(r, 800));
		const assets = T.sceneAssets.sceneAssetList().map((/** @type {any} */ a) => a.hash);
		const s = await T.sessions;
		const payload = s.buildSessionPayload('text-extrude-compat', { thumbnail: false });
		const bytes = await s.exportSessionZip(payload);
		let b = '';
		for (let i = 0; i < bytes.length; i += 0x8000) b += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
		return { b64: btoa(b), size: bytes.length, font: assets.includes(fontHash), appVersion: payload.appVersion ?? null, objects: payload.objects?.length ?? null };
	}, google?.font?.hash);
	h.check(file.size > 0 && file.font, `§1 saved as a .tpscene (${file.size} bytes, app ${file.appVersion}); its asset list carries the Google font: ${file.font}`);

	// ---- §2 the union opens the file -------------------------------------------------------------
	const U = await h.setupPageQuiet(browser, 'U-union', [R], ctxOpts);
	let unionGoogle = 0;
	await U.page.context().route(/fonts\.(googleapis|gstatic)\.com/, (/** @type {any} */ route) => {
		unionGoogle++;
		return route.abort('failed');
	});
	h.check(
		await U.page.evaluate(() => typeof window.__tp.test.v1.text3dBuild?.buildExtruded === 'function'),
		'§2 premise: the union exposes the same builder entry (text3dBuild.buildExtruded)'
	);
	const opened = await U.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const u8 = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
		const s = await window.__tp.test.v1.sessions;
		const payload = await s.importSessionZip(u8.buffer);
		if (!payload) return { ok: false, why: 'importSessionZip returned null' };
		const applied = await s.applySession(payload, { backup: false, replicate: false, quiet: true });
		return { ok: applied !== false, why: null };
	}, file.b64);
	h.check(opened.ok, `§2 the union opens the release's file (${opened.why ?? 'applied'})`);
	const uniBuilt = await untilBuilt(U.page, made, '§2 the union builds all five solids from the file');
	h.check(
		Object.values(made).every((u) => uniBuilt[u]?.geoType === 'BufferGeometry' && uniBuilt[u]?.topo),
		`§0 premise: the union builds on the mesh kernel (a BufferGeometry with __topo: ${Object.entries(made).map(([k, u]) => `${k} ${uniBuilt[u]?.geoType}${uniBuilt[u]?.topo ? '+topo' : ''}`).join(', ')})`
	);
	for (const [k, u] of Object.entries(made)) {
		h.check(uniBuilt[u]?.rec !== null && uniBuilt[u]?.rec === relBuilt[u]?.rec, `§2 ${k}: the union holds the release's record unchanged (${uniBuilt[u]?.rec === relBuilt[u]?.rec ? 'identical' : 'DIFFERS'})`);
		h.check(uniBuilt[u]?.missing === 0 && uniBuilt[u]?.drawn === relBuilt[u]?.drawn, `§2 ${k}: ${uniBuilt[u]?.drawn} letters drawn (release ${relBuilt[u]?.drawn}), ${uniBuilt[u]?.missing} missing`);
	}
	h.check(
		uniBuilt[made.google]?.fontUrl.startsWith('blob:') && uniBuilt[made.google]?.font === relBuilt[made.google]?.font && unionGoogle === 0,
		`§2 the Google-font text draws with the font from the file (${uniBuilt[made.google]?.font}, ${unionGoogle} Google calls)`
	);

	// ---- §3 triangles --------------------------------------------------------------------------------
	for (const [k, u] of Object.entries(made)) {
		const r = relBuilt[u]?.tris ?? 0;
		const n = uniBuilt[u]?.tris ?? 0;
		h.check(r > 0 && n > 0 && n <= r * SLOWER_MAX, `§3 ${k}: union ${n} triangles vs release ${r} (${r ? ((100 * n) / r).toFixed(1) : '-'} %, rule <= 120 %)`);
	}

	// ---- §4 build time -------------------------------------------------------------------------------
	await pauseAll([R, U], true);
	let sumR = 0;
	let sumU = 0;
	for (const [k, u] of Object.entries(made)) {
		/** @type {number[]} */ const msR = [];
		/** @type {number[]} */ const msU = [];
		let triR = 0;
		let triU = 0;
		for (let round = 0; round < ROUNDS; round++) {
			const a = await timeBuilds(R.page, u, BUILDS_PER_ROUND);
			const b = await timeBuilds(U.page, u, BUILDS_PER_ROUND);
			if (a) {
				msR.push(...a.ms);
				triR = a.tris;
			}
			if (b) {
				msU.push(...b.ms);
				triU = b.tris;
			}
		}
		const mR = msR.length ? median(msR) : NaN;
		const mU = msU.length ? median(msU) : NaN;
		sumR += mR;
		sumU += mU;
		h.check(
			Number.isFinite(mR) && Number.isFinite(mU) && mU <= Math.max(mR * SLOWER_MAX, mR + TIMER_FLOOR_MS),
			`§4 ${k}: union median ${mU.toFixed(2)} ms vs release ${mR.toFixed(2)} ms (${((100 * mU) / mR).toFixed(0)} %, rule <= 120 % or +${TIMER_FLOOR_MS} ms; ${msU.length}/${msR.length} builds; ${triU}/${triR} tris; union [${msU.map((x) => x.toFixed(1)).join(' ')}] release [${msR.map((x) => x.toFixed(1)).join(' ')}])`
		);
	}
	h.check(sumU <= sumR * SLOWER_MAX, `§4 all five: union ${sumU.toFixed(1)} ms vs release ${sumR.toFixed(1)} ms summed medians (${((100 * sumU) / sumR).toFixed(0)} %, rule <= 120 %)`);
	await pauseAll([R, U], false);

	// ---- §5 silhouette, front and side -----------------------------------------------------------------
	const boxR = await bboxes(R.page, Object.values(made));
	const boxU = await bboxes(U.page, Object.values(made));
	let shared = false;
	for (const t of TEXTS) {
		const u = made[t.key];
		if (!u || !boxR[u] || !boxU[u]) {
			h.check(false, `§5 ${t.key}: no geometry to frame (release ${!!boxR[u]}, union ${!!boxU[u]})`);
			continue;
		}
		const fmt = (/** @type {number[]} */ b) => b.map((x) => x.toFixed(3)).join(',');
		console.log(`  §5 ${t.key} local bbox: release [${fmt(boxR[u])}] union [${fmt(boxU[u])}]`);
		for (const kind of ['front', 'side']) {
			if (kind === 'side' && !t.side) {
				console.log(`SKIP §5 ${t.key} side: a 1 mm slab has no side profile`);
				continue;
			}
			const view = viewFor(kind, boxR[u], boxU[u]);
			const a = await maskOf(R.page, u, view, relBuilt[u].tris * 3);
			const b = await maskOf(U.page, u, view, uniBuilt[u].tris * 3);
			if (!a || !b || !a.on || !b.on) {
				h.check(false, `§5 ${t.key} ${kind}: both pages render the text (release ${a?.on ?? 'none'} px, union ${b?.on ?? 'none'} px)`);
				continue;
			}
			shared ||= a.shared || b.shared;
			const c = compareMasks(a.mask, b.mask, view.W, view.H);
			writePgm(path.join(OUT, `${t.key}-${kind}.pgm`), a.mask, b.mask, view.W, view.H);
			const mm = (view.px * 1000).toFixed(2);
			const where = `${view.W}x${view.H} px at ${mm} mm/px; release ${a.on} px, union ${b.on} px`;
			h.check(
				c.drift <= DRIFT_MAX,
				`§5 ${t.key} ${kind}: drift ${(100 * c.drift).toFixed(2)} % (XOR ${c.xor} = ${c.onlyA} release-only + ${c.onlyB} union-only, of ${c.uni}; rule <= 3 %; ${where})`
			);
			h.check(
				c.edge <= EDGE_MAX_PX && c.hausdorff <= EDGE_MAX_PX,
				`§5 ${t.key} ${kind}: bbox edges within ${c.edge} px (release [${c.ba.join(',')}] union [${c.bb.join(',')}]), every edge within ${c.hausdorff.toFixed(1)} px (${c.far} boundary px past ${EDGE_MAX_PX}; rule <= ${EDGE_MAX_PX} px = ${(EDGE_MAX_PX * view.px * 1000).toFixed(1)} mm)`
			);
		}
	}
	if (shared) console.log('  §5 note: a page could not make a second WebGL context; the app renderer drew the masks there (state restored)');
	console.log(`  §5 masks: ${path.resolve(OUT)}/*.pgm (white both, light grey release only, dark grey union only)`);

	// ---- §6 Bake of an old text ----------------------------------------------------------------------
	const bakedR = await bakeAndRead(R.page, made.bevelled);
	const bakedU = await bakeAndRead(U.page, made.bevelled);
	console.log(`  §6 release baked: ${JSON.stringify(bakedR)}`);
	console.log(`  §6 union baked:   ${JSON.stringify(bakedU)}`);
	h.check(bakedR.ok && bakedU.ok, `§6 Bake succeeds on both (release ${bakedR.error ?? 'ok'}, union ${bakedU.error ?? 'ok'})`);
	const clsR = JSON.stringify(bakedR.cls);
	const clsU = JSON.stringify(bakedU.cls);
	h.check(clsR === clsU && bakedU.cls.isMesh && !bakedU.cls.record, `§6 the same mesh class on both: release ${clsR} / union ${clsU}`);
	h.check(
		bakedR.verts === relBuilt[made.bevelled].tris * 3 && bakedU.verts === uniBuilt[made.bevelled].tris * 3 && bakedU.verts <= bakedR.verts * SLOWER_MAX,
		`§6 the baked mesh is the built solid: union ${bakedU.verts} verts (${uniBuilt[made.bevelled].tris} tris), release ${bakedR.verts} verts (${relBuilt[made.bevelled].tris} tris); ${bakedU.groups}/${bakedR.groups} groups`
	);
	h.check(
		!bakedR.topo && (!bakedU.topo || (bakedU.topo.tris === bakedU.verts / 3 && bakedU.topo.sum === bakedU.topo.tris)),
		`§6 the union's extra face partition (geometry.userData.__topo, additive) covers exactly its own triangles: ${bakedU.topo ? `${bakedU.topo.faces} faces over ${bakedU.topo.tris} triangles` : 'none'}; release ${bakedR.topo ? 'HAS one' : 'none'}`
	);

	// ---- §7 no page errors ---------------------------------------------------------------------------
	h.check(h.pageErrors(R).length === 0, `§7 no page error on the release (${h.pageErrors(R).join(' | ') || 'none'})`);
	h.check(h.pageErrors(U).length === 0, `§7 no page error on the union (${h.pageErrors(U).join(' | ') || 'none'})`);

	await h.finish(browser);
});
