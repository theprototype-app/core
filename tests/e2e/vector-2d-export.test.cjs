// 64-int — A 2D SCENE AND A SCENE OF VECTOR + EXTRUDED SHAPES EXPORT AND RUN (release brief row:
// "Export: a 2D scene and a scene with vector + extruded shapes export and run (built-app suites)").
//
// Against a BUILT app (the exporter reads build/export-manifest.json; a dev server has none, so the
// suite SKIPs there). Each scene is exported through the builder API (static preset), checked by
// scripts/check-export.cjs, unzipped and served from a SECOND origin in a sandboxed iframe on a host
// page (the export-zip §3 / text-export §3 set-up), in a browser that can resolve no other host,
// every other request aborted and recorded.
//
// WHAT THE EXPORTER SHIPS (read from the code, asserted here):
//   - the runtime is the WHOLE build: every file export-manifest.json lists (scripts/export-manifest.cjs
//     excludes only the SW, the web-app manifest, templates/, hdri/, llms, cloud plugin), so every lazy
//     chunk — the vector builder (vector/vectorCore.js) and the sprite runtime (sprite2d/spriteRuntime.js)
//     among them — is in the zip (§2 / §5 "every manifest file" rows)
//   - a vector shape is saved BAKED: buildSessionPayload writes each object with objectToJSON (the full
//     triangles + vertex colours + the `geometryParams: {gtype: 'Vector', params}` record); only the PEER
//     wire drops a heavy shape's triangles (vectorGate.vectorWireElement). So the exported player draws the
//     file's own triangles and needs no builder for them (§5 file rows, §6 "the file's own triangles" row).
//     A record-only shape in the file would be a real bug the moment the player does not load the vector
//     chunk (a player without debugStores never imports it for a baked scene), and §5 catches it.
//   - a sprite is a plain textured plane in the file (its PNG embedded as a data: URL); its flipbook is
//     run by the sprite runtime, which the player's per-frame tick (sprite2dTick) loads once it finds a
//     sprite — §3 checks that load happened in the game, the planes are sized from their maps, the frame
//     advances, and the view camera is the template's orthographic one.
//
//   §1 the 2D template (tests/fixtures/sprite2d-64/template2d.tpscene, written by sprite2d-flat §7; SPRITE2D_TPSCENE
//      overrides) is opened in the editor: its sprites, their maps, the planes the tick sized, the 2D layers
//   §2 export (static preset): check-export passes; the zip carries every manifest file; scene.tpscene
//      carries every sprite's image
//   §3 the 2D game: boots into Play; the same sprites with their maps and plane sizes; the sprite runtime
//      loaded by the game's own tick; the camera it draws through is orthographic; the Player's flipbook
//      advances (map offset steps through the sheet) and Follow Path moves it; the frame is drawn (colour
//      count of a screenshot); no request leaves the origin, no 404, no page errors
//   §4 the vector scene in the editor: a rect, a star, a pen path (gradient fill + stroke), a star extruded
//      (depth 0.3, bevel 0.04, 3 bevel steps) and an extruded text
//   §5 export: check-export passes; every manifest file ships; scene.tpscene carries each shape BAKED (its
//      triangles, vertex count = the editor's) with its record (gtype Vector, the depth)
//   §6 the vector game: every shape present with geometry — vertex / index counts and bounds equal to the
//      editor's, drawn from the file's own triangles; the solid's z extent = its depth; the text solid has
//      the editor's triangle count; no foreign request, no 404, no page errors
//
// Counterfactual: an exporter that wrote shapes in the wire's record-only form fails §5's baked rows; a
// player whose tick never loads the sprite chunk fails §3's runtime / flipbook rows; a Game Start that
// does not look through the 2D camera fails §3's orthographic row.
// Run (after `npm run build`):
//   LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' E2E_PC= e2e-slot --local --dev <tree> 5997 -- \
//     env APP_URL=https://theprototype.app:5997/ node tests/e2e/vector-2d-export.test.cjs
// Evidence: E2E_OUT (default test-results/64-int/vector-2d-export) gets the two zips, the served-file log, shots.
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(ROOT, process.env.E2E_OUT ?? 'test-results/64-int/vector-2d-export');
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-vector-2d-export-'));
const GAME_PORT = Number(process.env.VECTOR_2D_EXPORT_GAME_PORT || 0);
const FIXTURE = path.resolve(ROOT, process.env.SPRITE2D_TPSCENE || 'tests/fixtures/sprite2d-64/template2d.tpscene');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.txt': 'text/plain' };

/** a static server that logs every path it is asked for @param {Record<string, string>} routes @param {number} port @param {{path: string, status: number}[]} log */
function serve(routes, port, log) {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0]);
		for (const [prefix, dir] of Object.entries(routes)) {
			if (!url.startsWith(prefix)) continue;
			let file = path.join(dir, url.slice(prefix.length) || 'index.html');
			if (!file.startsWith(dir)) break;
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
			if (!fs.existsSync(file)) break;
			log.push({ path: url, status: 200 });
			res.writeHead(200, { 'Content-Type': /** @type {any} */ (MIME)[path.extname(file)] || 'application/octet-stream' });
			fs.createReadStream(file).pipe(res);
			return;
		}
		log.push({ path: url, status: 404 });
		res.writeHead(404);
		res.end('not found');
	});
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** the builder API (static preset) in the editor page; the zip lands in OUT @param {any} page @param {string} title */
async function exportScene(page, title) {
	const ex = await page.evaluate(async (t) => {
		const res = await window.__tp.test.v1.exportBuilder.buildExport({ preset: 'static', title: t, thumbnail: false, startFullscreen: false, showFps: false, quality: 'auto', vrButton: false, useCdnForPacks: false });
		const buf = new Uint8Array(await res.blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { b64: btoa(s), name: res.fileName, warnings: res.warnings };
	}, title);
	const zipPath = path.join(OUT, ex.name);
	fs.writeFileSync(zipPath, Buffer.from(ex.b64, 'base64'));
	console.log(`[vector-2d-export] ${title}: ${zipPath} (${fs.statSync(zipPath).size} bytes) warnings: ${JSON.stringify(ex.warnings)}`);
	return zipPath;
}

/** scripts/check-export.cjs on a zip @param {string} zipPath */
function checkExport(zipPath) {
	try {
		return { ok: true, out: execFileSync('node', [path.join(ROOT, 'scripts/check-export.cjs'), zipPath, '--preset', 'static'], { encoding: 'utf8' }) };
	} catch (e) {
		return { ok: false, out: String(/** @type {any} */ (e).stdout || e) };
	}
}

/** the export's own rows: check-export, every runtime file of the manifest, the parsed session.json
 * @param {string} label @param {string} zipPath @param {string[]} runtimeFiles @param {string} dir unzip here */
function zipRows(label, zipPath, runtimeFiles, dir) {
	const check = checkExport(zipPath);
	console.log(check.out);
	h.check(check.ok, `${label} scripts/check-export.cjs passes the static-host zip`);
	const zip = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
	const missing = runtimeFiles.filter((f) => f !== 'index.html' && !zip[f]);
	h.check(
		runtimeFiles.length > 0 && missing.length === 0,
		`${label} the zip carries every runtime file the build lists (${runtimeFiles.length - missing.length}/${runtimeFiles.length} of export-manifest.json; missing: ${missing.slice(0, 3).join(', ') || 'none'}) — every lazy chunk, the vector builder and the sprite runtime among them`
	);
	// evidence only (a minified chunk's strings can change): which shipped chunk holds each runtime
	const holding = (/** @type {RegExp} */ re) =>
		Object.keys(zip).filter((f) => /^_app\/.*\.m?js$/.test(f) && re.test(strFromU8(zip[f]))).slice(0, 3);
	console.log(`  ${label} shipped chunks: sprite runtime ${JSON.stringify(holding(/sprite tick failed/))}, vector mesh builder ${JSON.stringify(holding(/vectorMeshDebug/))}`);
	for (const [rel, data] of Object.entries(zip)) {
		if (rel.endsWith('/')) continue;
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), data);
	}
	const scene = zip['scene.tpscene'] ? unzipSync(zip['scene.tpscene']) : {};
	const session = scene['session.json'] ? JSON.parse(strFromU8(scene['session.json'])) : null;
	h.check(!!session && Array.isArray(session.objects), `${label} the zip carries scene.tpscene with its session.json (${session ? session.objects.length + ' top-level objects' : 'MISSING'})`);
	return session;
}

/** a geometry entry of a session.json element, through the 102b shared table @param {any} session @param {any} element @param {string} uuid */
function fileGeometry(session, element, uuid) {
	const g = (element?.geometries ?? []).find((/** @type {any} */ x) => x.uuid === uuid);
	if (g && Number.isInteger(g.sharedGeometry)) return { ...session.sharedGeometries?.[g.sharedGeometry], uuid: g.uuid, shared: true };
	return g ?? null;
}

/** every sprite / 2D layer in a page or the game frame @param {any} target */
const spriteFacts = (target) =>
	target.evaluate(() => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		let g;
		S.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		/** @type {any[]} */
		const sprites = [];
		let layers = 0;
		g?.traverse((/** @type {any} */ o) => {
			if (o.userData?.layer2d && typeof o.userData.layer2d === 'object') layers++;
			if (!(o.isMesh && o.userData?.sprite && typeof o.userData.sprite === 'object')) return;
			const m = Array.isArray(o.material) ? o.material[0] : o.material;
			const map = m?.map;
			const img = map?.image;
			o.geometry?.computeBoundingBox?.();
			const b = o.geometry?.boundingBox;
			let shown = true;
			for (let n = o; n && n !== g; n = n.parent) if (!n.visible) shown = false;
			const w = new S.THREE.Vector3();
			o.getWorldPosition(w);
			sprites.push({
				uuid: o.uuid,
				name: o.name,
				shown,
				inScene: !!o.parent,
				map: !!map,
				img: img && (img.width ?? img.videoWidth) > 0 ? [img.width ?? img.videoWidth, img.height ?? img.videoHeight] : null,
				sized: o.geometry?.userData?.sprite2d ?? null,
				size: b && Number.isFinite(b.min.x) ? [+(b.max.x - b.min.x).toFixed(4), +(b.max.y - b.min.y).toFixed(4)] : null,
				offset: map ? [+map.offset.x.toFixed(4), +map.offset.y.toFixed(4)] : null,
				repeat: map ? [+map.repeat.x.toFixed(4), +map.repeat.y.toFixed(4)] : null,
				x: +w.x.toFixed(3)
			});
		});
		return { sprites: sprites.sort((a, b) => (a.name < b.name ? -1 : 1)), layers, loaded: S.sprite2dTick.sprite2dRuntimeLoaded() };
	});
const spritesReady = (/** @type {any} */ f) => f.loaded && f.sprites.length > 0 && f.sprites.every((/** @type {any} */ s) => s.map && s.img && s.sized);

/** sample one sprite's shown frame over time (the map offset the tick writes, spriteStatus, its world x)
 * @param {any} target @param {string} uuid @param {number} n @param {number} ms */
const flipbook = (target, uuid, n, ms) =>
	target.evaluate(
		async ([u, count, step]) => {
			const S = /** @type {any} */ (window).__tp.test.v1;
			let g;
			S.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			const out = [];
			const w = new S.THREE.Vector3();
			for (let i = 0; i < count; i++) {
				const map = (Array.isArray(o?.material) ? o.material[0] : o?.material)?.map;
				const st = o ? S.sprite2d.spriteStatus(o) : null;
				o?.getWorldPosition(w);
				out.push({ off: map ? +map.offset.x.toFixed(4) : null, frame: st?.frame ?? null, clip: st?.clip ?? null, playing: !!st?.playing, x: +w.x.toFixed(3) });
				await new Promise((r) => setTimeout(r, step));
			}
			return out;
		},
		[uuid, n, ms]
	);

/** what each vector shape is, keyed by uuid @param {any} target @param {string[]} uuids */
const shapeFacts = (target, uuids) =>
	target.evaluate((list) => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		let g;
		S.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		/** @type {Record<string, any>} */
		const out = {};
		for (const u of list) {
			const o = g?.getObjectByProperty('uuid', u);
			if (!o) {
				out[u] = null;
				continue;
			}
			const geo = o.geometry;
			const pos = geo?.attributes?.position;
			geo?.computeBoundingBox?.();
			const b = geo?.boundingBox;
			const p = o.userData?.geometryParams;
			out[u] = {
				name: o.name,
				gtype: p?.gtype ?? null,
				kind: p?.params?.kind ?? null,
				depth: p?.params?.depth ?? null,
				bevel: p?.params?.bevel ?? null,
				verts: pos?.count ?? 0,
				index: geo?.index?.count ?? null,
				colours: !!geo?.attributes?.color,
				pending: !!geo?.userData?.vectorPending,
				geoUuid: geo?.uuid ?? null,
				visible: !!o.visible && !!o.parent,
				box: b && pos?.count ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => +v.toFixed(4)) : null
			};
		}
		return out;
	}, uuids);
const vectorCount = (/** @type {any} */ target) =>
	target.evaluate(() => {
		let g;
		/** @type {any} */ (window).__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		let n = 0;
		g?.traverse((/** @type {any} */ o) => {
			if (o.isMesh && o.userData?.geometryParams?.gtype === 'Vector') n++;
		});
		return n;
	});

/** what the text runtime reports, keyed by the text (text-export's read) @param {any} target */
const texts = (target) =>
	target.evaluate(() =>
		Object.fromEntries(
			/** @type {any} */ (window).__tp.test.v1.textPath.textPathDebug().map((/** @type {any} */ d) => [d.text, { mode: d.mode, solid: d.solid, font: d.font, fontUrl: d.fontUrl }])
		)
	);
const solidBuilt = (/** @type {any} */ d) => !!d && d.mode === 'extruded' && !!d.solid && !d.solid.building && d.solid.triangles > 0;

/** distinct colours (4 bits a channel) on a grid of a screenshot, and the share of the commonest one
 * — decoded in the host page (node here has no PNG decoder) @param {any} p @param {Buffer} png */
const colourCount = (p, png) =>
	p.evaluate(async (b64) => {
		const img = new Image();
		await new Promise((res, rej) => {
			img.onload = res;
			img.onerror = rej;
			img.src = 'data:image/png;base64,' + b64;
		});
		const c = document.createElement('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
		g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		/** @type {Map<number, number>} */
		const seen = new Map();
		let n = 0;
		for (let y = 4; y < c.height; y += 8)
			for (let x = 4; x < c.width; x += 8) {
				const i = (y * c.width + x) * 4;
				const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
				seen.set(k, (seen.get(k) ?? 0) + 1);
				n++;
			}
		return { distinct: seen.size, top: +(Math.max(...seen.values()) / n).toFixed(3) };
	}, png.toString('base64'));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const manifest = await A.page.evaluate(() => fetch('export-manifest.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null), () => null));
	if (!manifest) {
		console.log('SKIP: no build/export-manifest.json — run against `npm run build` served by scripts/serve-build.cjs');
		await browser.close();
		return;
	}
	// what an export copies (exportBuilder.runtimeFiles, 63 PG1): minus the entry pages, and on a build with the slim
	// play entry minus the files only the editor / kit page reach (`editorOnly`) — 64-int-rel, on v1.83.0
	const slim = (manifest.files ?? []).some((/** @type {any} */ f) => f.path === 'play.html');
	const runtimeFiles = (manifest.files ?? [])
		.filter((/** @type {any} */ f) => !['index.html', 'play.html', 'kit.html'].includes(f.path) && !(slim && f.editorOnly))
		.map((/** @type {any} */ f) => f.path);
	h.check(fs.existsSync(FIXTURE), `premise: the saved 2D template is here (${path.relative(ROOT, FIXTURE)})`);

	// the second origin (games) and the host page origin, and a browser that reaches nothing else
	/** @type {{path: string, status: number}[]} */
	const served = [];
	const gameDirs = { '2d': path.join(WORK, 'game-2d'), vec: path.join(WORK, 'game-vec') };
	const game = /** @type {any} */ (await serve({ '/html/6421/': gameDirs['2d'], '/html/6422/': gameDirs.vec }, GAME_PORT, served));
	const gameOrigin = `http://127.0.0.1:${game.address().port}`;
	const bases = { '2d': `${gameOrigin}/html/6421/`, vec: `${gameOrigin}/html/6422/` };
	const hostDir = path.join(WORK, 'host');
	fs.mkdirSync(hostDir);
	for (const [key, base] of Object.entries(bases))
		fs.writeFileSync(
			path.join(hostDir, key + '.html'),
			`<!doctype html><html><head><meta charset="utf-8"><title>host</title><style>html,body{margin:0;height:100%;background:#222}iframe{position:fixed;left:0;top:0;width:1280px;height:720px;border:0}</style></head><body><iframe id="game_drop" src="${base}index.html" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-forms" allow="autoplay; fullscreen *; xr-spatial-tracking; gamepad" allowfullscreen></iframe></body></html>`
		);
	const host = /** @type {any} */ (await serve({ '/': hostDir }, 0, []));
	const hostOrigin = `http://localhost:${host.address().port}`;
	const offline = await h.launch({ args: [...h.GPU_ARGS, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });

	/** open one exported game in the host page; wait for its boot @param {'2d' | 'vec'} key @param {string} label */
	async function openGame(key, label) {
		const ctx = await offline.newContext({ viewport: { width: 1280, height: 720 } });
		await ctx.addInitScript(() => {
			try {
				localStorage.setItem('debugStores', 'true');
			} catch {
				/* the host page */
			}
		});
		/** @type {string[]} */
		const foreign = [];
		await ctx.route('**/*', (/** @type {any} */ route) => {
			const u = route.request().url();
			if (u.startsWith(gameOrigin + '/') || u.startsWith(hostOrigin + '/')) return route.continue();
			foreign.push(u);
			return route.abort('blockedbyclient');
		});
		ctx.on('request', (/** @type {any} */ req) => {
			const u = req.url();
			if (!/^(blob|data):/.test(u) && !u.startsWith(gameOrigin + '/') && !u.startsWith(hostOrigin + '/') && !foreign.includes(u)) foreign.push(u);
		});
		const p = await ctx.newPage();
		/** @type {string[]} */
		const errors = [];
		p.on('pageerror', (/** @type {any} */ e) => errors.push(e.message));
		await p.goto(`${hostOrigin}/${key}.html`, { waitUntil: 'domcontentloaded' });
		const frame = await (async () => {
			for (let i = 0; i < 200; i++) {
				const f = p.frames().find((fr) => fr.url().startsWith(bases[key]));
				if (f) return f;
				await p.waitForTimeout(100);
			}
			throw new Error('no game frame');
		})();
		await frame.waitForFunction(() => /** @type {any} */ (window).__tp?.test.v1?.exportRuntime?.exportRuntimeState, null, { timeout: 90000 });
		await h.eventually(() => frame.evaluate(() => /** @type {any} */ (window).__tp.test.v1.exportRuntime.exportRuntimeState.phase), (v) => v === 'playing' || v === 'failed', `${label} the exported game boots`, 90000);
		const phase = await frame.evaluate(() => /** @type {any} */ (window).__tp.test.v1.exportRuntime.exportRuntimeState);
		h.check(phase.phase === 'playing', `${label} the exported game is playing (${phase.phase}${phase.error ? ' — ' + phase.error : ''})`);
		return { ctx, p, frame, foreign, errors };
	}

	/** the rows every game ends with @param {any} G @param {'2d' | 'vec'} key @param {string} label */
	function originRows(G, key, label) {
		const prefix = new URL(bases[key]).pathname;
		const missing = served.filter((s) => s.status === 404 && s.path.startsWith(prefix)).map((s) => s.path);
		h.check(G.foreign.length === 0, `${label} not one request left the game's origin (${G.foreign.length}: ${G.foreign.slice(0, 4).join(', ') || 'none'})`);
		h.check(missing.length === 0, `${label} the game asked its origin for no file the zip lacks (${missing.slice(0, 4).join(', ') || 'none'})`);
		h.check(G.errors.length === 0, `${label} no page errors in the exported game (${G.errors.slice(0, 2).join(' | ') || 'none'})`);
	}

	// ==== THE 2D SCENE ================================================================================
	// ---- §1 the 2D template in the editor -----------------------------------------------------------
	await A.page.evaluate(async (/** @type {number[]} */ arr) => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false, quiet: true });
	}, Array.from(fs.readFileSync(FIXTURE)));
	await h.eventually(() => spriteFacts(A.page), spritesReady, '§1 the editor opens the 2D template: every sprite has its map and the tick sized its plane', 60000);
	const ed2 = await spriteFacts(A.page);
	const player = ed2.sprites.find((/** @type {any} */ s) => s.name === 'Player');
	console.log('  §1 editor sprites:', JSON.stringify(ed2.sprites.map((/** @type {any} */ s) => [s.name, s.img, s.size, s.repeat])));
	h.check(ed2.sprites.length >= 5 && ed2.layers >= 4 && !!player, `§1 the template holds ${ed2.sprites.length} sprites (${ed2.sprites.map((/** @type {any} */ s) => s.name).join(', ')}) in ${ed2.layers} 2D layers, the Player among them`);
	h.check(!!player && player.repeat?.[0] === 0.25, `§1 the Player is a 4-frame sheet (map repeat ${JSON.stringify(player?.repeat)})`);
	const edFlip = player ? await flipbook(A.page, player.uuid, 8, 80) : [];
	console.log('  §1 editor Player frames (premise, not a row):', JSON.stringify(edFlip.map((s) => s.off)));

	// ---- §2 export ----------------------------------------------------------------------------------
	const zip2d = await exportScene(A.page, '2D Export');
	await A.ctx.close();
	const s2d = zipRows('§2', zip2d, runtimeFiles, gameDirs['2d']);
	{
		/** @type {{name: string, image: boolean}[]} */
		const inFile = [];
		for (const el of s2d?.objects ?? []) {
			const images = new Map((el.images ?? []).map((/** @type {any} */ i) => [i.uuid, i]));
			const textures = new Map((el.textures ?? []).map((/** @type {any} */ t) => [t.uuid, t]));
			const materials = new Map((el.materials ?? []).map((/** @type {any} */ m) => [m.uuid, m]));
			const walk = (/** @type {any} */ o) => {
				if (o.userData?.sprite) {
					const mat = materials.get(Array.isArray(o.material) ? o.material[0] : o.material);
					const tex = mat?.map ? textures.get(mat.map) : null;
					const img = tex?.image ? images.get(tex.image) : null;
					const url = img ? (Array.isArray(img.url) ? img.url[0] : img.url) : null;
					inFile.push({ name: o.name, image: typeof url === 'string' ? url.startsWith('data:image/') : !!url });
				}
				for (const c of o.children ?? []) walk(c);
			};
			walk(el.object);
		}
		h.check(inFile.length === ed2.sprites.length && inFile.every((s) => s.image), `§2 scene.tpscene carries every sprite with its image embedded (${inFile.filter((s) => s.image).length}/${ed2.sprites.length}: ${inFile.map((s) => s.name + (s.image ? '' : ' NO IMAGE')).join(', ')})`);
	}

	// ---- §3 the 2D game ------------------------------------------------------------------------------
	const G2 = await openGame('2d', '§3');
	await h.eventually(() => spriteFacts(G2.frame), spritesReady, '§3 the game draws its sprites: every one has its map and its plane sized by the sprite runtime', 60000);
	const gx2 = await spriteFacts(G2.frame);
	console.log('  §3 game sprites:', JSON.stringify(gx2.sprites.map((/** @type {any} */ s) => [s.name, s.img, s.size, s.repeat, s.shown])));
	h.check(gx2.loaded, '§3 the game\'s own per-frame tick loaded the sprite runtime (sprite2dTick.sprite2dRuntimeLoaded) from the zip');
	h.check(gx2.layers === ed2.layers, `§3 the ${gx2.layers} 2D layers are there (${ed2.layers} in the editor)`);
	const same = ed2.sprites.map((/** @type {any} */ e) => {
		const g = gx2.sprites.find((/** @type {any} */ s) => s.uuid === e.uuid);
		return { name: e.name, ok: !!g && g.shown && JSON.stringify(g.img) === JSON.stringify(e.img) && JSON.stringify(g.size) === JSON.stringify(e.size) && JSON.stringify(g.repeat) === JSON.stringify(e.repeat), game: g ? [g.img, g.size, g.shown] : null };
	});
	h.check(
		gx2.sprites.length === ed2.sprites.length && same.every((s) => s.ok),
		`§3 every sprite is a shown textured plane with the editor's image size, plane size and frame repeat (${gx2.sprites.length}/${ed2.sprites.length}; off: ${JSON.stringify(same.filter((s) => !s.ok)) || 'none'})`
	);
	const camWhy = () =>
		G2.frame.evaluate(() => {
			const w = /** @type {any} */ (window);
			const t = w.__tp.test.v1;
			let prev = null;
			let game = null;
			let g = null;
			w.__stores.cameraPreview?.cameraPreview?.subscribe((v) => (prev = v))();
			w.__stores.gameState?.gameState?.subscribe((v) => (game = v))();
			t.objectsGroup.subscribe((v) => (g = v))();
			const markers = [];
			g?.traverse((o) => o.userData?.camera && markers.push({ uuid: o.uuid.slice(0, 8), kind: o.userData.camera.kind }));
			return { preview: prev, state: game?.state, markers, ortho: t.sprite2d.sprite2dDebug().ortho };
		});
	for (let i = 0; i < 20; i++) {
		if (await G2.frame.evaluate(() => /** @type {any} */ (window).__tp.test.v1.sprite2d.sprite2dDebug().ortho)) break;
		await G2.frame.waitForTimeout(500);
	}
	const dbg = await G2.frame.evaluate(() => /** @type {any} */ (window).__tp.test.v1.sprite2d.sprite2dDebug());
	if (!dbg.ortho) {
		console.log('  §3 camera diagnostics: ' + JSON.stringify(await camWhy()));
		// does the late-joiner catch-up fix it? (says whether the transition was missed or the look-through refused)
		await G2.frame.evaluate(() => /** @type {any} */ (window).__stores.flowRuntime?.syncGameCameraNow?.());
		await G2.frame.waitForTimeout(1500);
		console.log('  §3 after syncGameCameraNow(): ' + JSON.stringify(await camWhy()));
	}
	h.check(dbg.ortho === true && !dbg.xr, `§3 the camera the game draws through is orthographic — Game Start looks through the template's 2D camera (sprite2dDebug ${JSON.stringify({ sprites: dbg.sprites, layers: dbg.layers, ortho: dbg.ortho })})`);
	const gFlip = player ? await flipbook(G2.frame, player.uuid, 16, 100) : [];
	const offs = [...new Set(gFlip.map((s) => s.off))];
	h.check(
		offs.length >= 3 && offs.every((o) => [0, 0.25, 0.5, 0.75].includes(/** @type {number} */ (o))),
		`§3 the Player's flipbook advances: the map offset steps through the sheet over 1.6 s (${offs.length} frames shown: ${JSON.stringify(gFlip.map((s) => s.off))}; clip ${gFlip[0]?.clip}, playing ${gFlip[0]?.playing})`
	);
	const xs = gFlip.map((s) => s.x);
	h.check(xs.length > 1 && Math.abs(xs[xs.length - 1] - xs[0]) > 0.5, `§3 the game runs: Follow Path walks the Player (x ${xs[0]} -> ${xs[xs.length - 1]})`);
	await G2.p.waitForTimeout(500);
	const shot2d = await G2.p.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } });
	fs.writeFileSync(path.join(OUT, '2d-game.png'), shot2d);
	const col2d = await colourCount(G2.p, shot2d);
	h.check(col2d.distinct >= 8 && col2d.top < 0.9, `§3 the frame is drawn, not a blank or an error page (${col2d.distinct} distinct colours, the commonest covers ${Math.round(col2d.top * 100)}%)`);
	originRows(G2, '2d', '§3');
	await G2.ctx.close();

	// ==== THE VECTOR SCENE ============================================================================
	// ---- §4 vector shapes + extrude in the editor --------------------------------------------------
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	const made = await B.page.evaluate(() => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		const { addVectorShape } = S.vectorActions;
		const { vectorDefaults } = S.vectorRecord;
		const add = (/** @type {string} */ kind, /** @type {any} */ patch, /** @type {number[]} */ at) => addVectorShape({ ...vectorDefaults(kind), ...patch, kind }, { position: at, select: false })?.uuid ?? null;
		const rect = add('rect', { width: 1.2, height: 0.8, corner: 0.1, fill: '#4f8cff' }, [-3, 1, 0]);
		const star = add('star', { radius: 0.6, points: 7, fill: '#ffaa00' }, [-1.2, 1, 0]);
		const pen = add(
			'path',
			{
				paths: [{ closed: true, nodes: [{ x: -0.5, y: 0, ix: 0, iy: 0, ox: 0.2, oy: 0.4, smooth: false }, { x: 0.5, y: 0, ix: 0.1, iy: 0.3, ox: 0, oy: 0, smooth: false }, { x: 0, y: -0.6, ix: 0, iy: 0, ox: 0, oy: 0, smooth: false }] }],
				fillType: 'linear',
				gradAngle: 30,
				fill: '#00ff88',
				fill2: '#8800ff',
				strokeWidth: 0.03
			},
			[0.8, 1.2, 0]
		);
		const solid = add('star', { radius: 0.8, points: 5, fill: '#ff5ca8', depth: 0.3, bevel: 0.04, bevelSegments: 3 }, [3, 1, 0]);
		const t = S.addObjects.spawnAtPoint('/create Text', [0, 2.8, 0]);
		const text = t?.uuid && S.textPathEdit.setTextPathFor(t.uuid, { text: 'VEC', mode: 'extruded', depth: 0.2, bevel: { size: 0.02, thickness: 0.02, segments: 3 } }) ? t.uuid : null;
		return { rect, star, pen, solid, text };
	});
	const shapeIds = /** @type {string[]} */ ([made.rect, made.star, made.pen, made.solid].filter(Boolean));
	h.check(shapeIds.length === 4, `§4 four vector shapes made: rect, star, pen path, extruded star (${JSON.stringify(made)})`);
	h.check(!!made.text, '§4 an extruded text made');
	await h.eventually(() => texts(B.page), (t) => solidBuilt(t.VEC), '§4 the editor builds the text solid', 60000);
	const ed = await shapeFacts(B.page, shapeIds);
	const edText = (await texts(B.page)).VEC;
	for (const u of shapeIds) console.log(`  §4 editor ${ed[u]?.name}: ${ed[u]?.verts} verts, index ${ed[u]?.index}, box ${JSON.stringify(ed[u]?.box)}, depth ${ed[u]?.depth}`);
	h.check(shapeIds.every((u) => ed[u]?.gtype === 'Vector' && ed[u].verts > 0 && ed[u].colours && !ed[u].pending), `§4 every shape is a Vector mesh with triangles and vertex colours (${shapeIds.map((u) => ed[u]?.kind + ' ' + ed[u]?.verts).join(', ')})`);
	const es = ed[made.solid];
	h.check(!!es?.box && Math.abs(es.box[2]) < 1e-3 && Math.abs(es.box[5] - 0.3) < 1e-3 && es.depth === 0.3 && es.bevel === 0.04, `§4 the extruded star is a solid z 0..depth (${es?.box?.[2]}..${es?.box?.[5]}, depth ${es?.depth}, bevel ${es?.bevel})`);
	h.check(es?.verts > (ed[made.star]?.verts ?? 0), `§4 premise: the solid is a different mesh from the flat star (${es?.verts} vs ${ed[made.star]?.verts} verts)`);
	console.log(`  §4 editor text VEC: ${JSON.stringify(edText.solid)}`);

	// ---- §5 export ----------------------------------------------------------------------------------
	const zipVec = await exportScene(B.page, 'Vector Export');
	await B.ctx.close();
	const sv = zipRows('§5', zipVec, runtimeFiles, gameDirs.vec);
	/** @type {Record<string, any>} */
	const filed = {};
	for (const u of shapeIds) {
		const el = (sv?.objects ?? []).find((/** @type {any} */ e) => e.object?.uuid === u);
		const geo = el ? fileGeometry(sv, el, el.object.geometry) : null;
		const pos = geo?.data?.attributes?.position;
		filed[u] = {
			present: !!el,
			gtype: el?.object?.userData?.geometryParams?.gtype ?? null,
			depth: el?.object?.userData?.geometryParams?.params?.depth ?? null,
			verts: pos ? pos.array.length / pos.itemSize : 0,
			floats: pos ? pos.array.length : 0,
			colours: !!geo?.data?.attributes?.color,
			geoUuid: geo?.uuid ?? null,
			shared: !!geo?.shared
		};
	}
	console.log('  §5 in scene.tpscene:', JSON.stringify(shapeIds.map((u) => [ed[u]?.name, filed[u].verts, filed[u].floats > 4000 ? 'heavy on the wire' : 'light', filed[u].depth])));
	h.check(shapeIds.every((u) => filed[u].present && filed[u].gtype === 'Vector' && filed[u].depth === ed[u].depth), `§5 scene.tpscene carries every shape with its record (gtype Vector, depth ${shapeIds.map((u) => filed[u].depth).join(' / ')})`);
	h.check(
		shapeIds.every((u) => filed[u].verts === ed[u].verts && filed[u].colours),
		`§5 ...BAKED: each shape's triangles and vertex colours are in the file, the editor's vertex count (${shapeIds.map((u) => `${ed[u]?.kind}${ed[u]?.depth ? ' solid' : ''} ${filed[u].verts}/${ed[u]?.verts}`).join(', ')}) — a record-only shape would need the vector builder in the player`
	);

	// ---- §6 the vector game -------------------------------------------------------------------------
	const GV = await openGame('vec', '§6');
	await h.eventually(() => shapeFacts(GV.frame, shapeIds), (f) => shapeIds.every((u) => f[u]?.verts > 0), '§6 every vector shape is in the game with geometry', 30000);
	await h.eventually(() => texts(GV.frame), (t) => solidBuilt(t.VEC), '§6 the text solid is built in the game', 60000);
	await GV.p.waitForTimeout(1000); // a late rebuild would show up here
	const gx = await shapeFacts(GV.frame, shapeIds);
	const gText = (await texts(GV.frame)).VEC;
	for (const u of shapeIds) console.log(`  §6 game ${gx[u]?.name}: ${gx[u]?.verts} verts, index ${gx[u]?.index}, box ${JSON.stringify(gx[u]?.box)}, geometry ${gx[u]?.geoUuid === filed[u].geoUuid ? 'the file\'s own' : 'REBUILT'}`);
	h.check((await vectorCount(GV.frame)) === 4, `§6 the game holds exactly the 4 vector shapes (${await vectorCount(GV.frame)})`);
	for (const u of shapeIds) {
		const e = ed[u];
		const g = gx[u];
		h.check(
			!!g && g.gtype === 'Vector' && g.visible && g.verts === e.verts && g.index === e.index && JSON.stringify(g.box) === JSON.stringify(e.box) && g.colours && !g.pending,
			`§6 ${e.name} (${e.kind}${e.depth ? ', depth ' + e.depth : ''}): ${g?.verts}/${e.verts} vertices, index ${g?.index}/${e.index}, the editor's bounds, vertex colours, shown`
		);
	}
	h.check(
		shapeIds.every((u) => gx[u]?.geoUuid && gx[u].geoUuid === filed[u].geoUuid),
		`§6 the game draws each shape from the file's own triangles, not a rebuild from its record (${shapeIds.map((u) => (gx[u]?.geoUuid === filed[u].geoUuid ? 'file' : 'rebuilt')).join(', ')})`
	);
	const gs = gx[made.solid];
	h.check(!!gs?.box && Math.abs(gs.box[2]) < 1e-3 && Math.abs(gs.box[5] - 0.3) < 1e-3, `§6 the extruded star keeps its z extent = depth 0.3 in the game (${gs?.box?.[2]}..${gs?.box?.[5]})`);
	h.check(gText.solid.triangles === edText.solid.triangles && gText.solid.missing === 0, `§6 the extruded text "VEC" is the editor's solid (${gText.solid.triangles}/${edText.solid.triangles} triangles, font ${gText.font})`);
	const shotVec = await GV.p.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } });
	fs.writeFileSync(path.join(OUT, 'vector-game.png'), shotVec);
	const colVec = await colourCount(GV.p, shotVec);
	console.log(`  §6 frame: ${colVec.distinct} distinct colours, commonest ${Math.round(colVec.top * 100)}% (evidence: vector-game.png)`);
	originRows(GV, 'vec', '§6');
	await GV.ctx.close();

	fs.writeFileSync(path.join(OUT, 'served.txt'), served.map((s) => s.status + ' ' + s.path).join('\n') + '\n');
	await offline.close();
	host.close();
	game.close();
	fs.rmSync(WORK, { recursive: true, force: true });
	await h.finish(browser);
});
