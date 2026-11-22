// 48 S2 — A SEQUENCE PLAYS IN AN EXPORTED GAME.
//
// Against a BUILT app (the exporter reads build/export-manifest.json; a dev server has none —
// run against scripts/serve-build.cjs — `vite preview` does not serve build/export-manifest.json):
//   1. the editor builds a small scene: a camera, a sequence flagged AUTOPLAY with a camera shot
//      and an event item "go", and an On Sequence Event "go" node
//   2. the static-host export carries the sequence inside scene.tpscene (formatMinor 2)
//   3. the zip, served from a second origin, boots straight into Play, and the sequence
//      AUTOPLAYS there: it looks through the shot and the event pulses the graph
//
// Counterfactual: on v1.38.0 there is no sequence to carry — step 1 cannot build one.
// Run: LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' e2e-slot --dev <lane> 5482 --
//      env APP_URL=https://localhost:5482/ node tests/e2e/timeline-export.test.cjs
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { unzipSync } = require('fflate');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-tl-export-'));
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.glb': 'model/gltf-binary',
	'.tpscene': 'application/zip'
};

/** @param {Record<string, string>} routes */
function serve(routes) {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0]);
		for (const [prefix, dir] of Object.entries(routes)) {
			if (!url.startsWith(prefix)) continue;
			let file = path.join(dir, url.slice(prefix.length) || 'index.html');
			if (!file.startsWith(dir)) break;
			if (fs.existsSync(file) && fs.statSync(file).isDirectory())
				file = path.join(file, 'index.html');
			if (!fs.existsSync(file)) break;
			res.writeHead(200, {
				'Content-Type': /** @type {any} */ (MIME)[path.extname(file)] || 'application/octet-stream'
			});
			fs.createReadStream(file).pipe(res);
			return;
		}
		res.writeHead(404);
		res.end('not found');
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 720 } }
	});
	const pa = A.page;

	// ---------- 1. the scene ----------
	const made = await pa.evaluate(async () => {
		const S = window.__tp?.test.v1;
		let g;
		S.objectsGroup.subscribe((v) => (g = v))();
		const before = new Set(g.children.map((o) => o.uuid));
		S.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 400));
		const cam = g.children.find((o) => !before.has(o.uuid));
		cam.name = 'Intro cam';
		cam.position.set(0, 3, 9);
		cam.updateMatrix();
		const sq = S.sequences;
		const id = sq.createSequence('Intro', { duration: 4, autoplay: true });
		const camTrack = sq.addTrack(id, 'camera');
		const evTrack = sq.addTrack(id, 'event');
		sq.addItem(id, camTrack, { t: 0, dur: 3, camera: cam.uuid });
		sq.addItem(id, evTrack, { t: 0.5, name: 'go' });
		S.nodesHandler.createFlowNode({
			id: 'tlx-go',
			type: 'onseqevent',
			position: { x: 0, y: 0 },
			data: { type: 'onseqevent', sequence: '', event: 'go', pulse: 0.3 }
		});
		return { id, cam: cam.uuid };
	});
	h.check(
		!!made.id && !!made.cam,
		'the editor builds an autoplay sequence with a shot and an event'
	);

	// ---------- 2. the export carries it ----------
	const out = await pa.evaluate(async () => {
		const b = window.__tp.test.v1.exportBuilder;
		const res = await b.buildExport({
			preset: 'static',
			title: 'Timeline Export',
			thumbnail: false,
			startFullscreen: false,
			showFps: false,
			quality: 'auto',
			vrButton: false,
			useCdnForPacks: false
		});
		const buf = new Uint8Array(await res.blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000)
			s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { b64: btoa(s), name: res.fileName };
	});
	const zip = unzipSync(new Uint8Array(Buffer.from(out.b64, 'base64')));
	h.check(
		!!zip['scene.tpscene'] && !!zip['index.html'],
		`the export zip has index.html + scene.tpscene (${out.name})`
	);
	const inScene = await pa.evaluate(async (arr) => {
		const payload = await window.__tp.test.v1.sessions.readSessionZip(new Uint8Array(arr).buffer);
		const seqs = payload?.sequences ?? {};
		const one = Object.values(seqs)[0];
		return {
			minor: payload?.formatMinor,
			count: Object.keys(seqs).length,
			autoplay: one?.autoplay,
			tracks: one?.tracks?.length ?? 0
		};
	}, Array.from(zip['scene.tpscene']));
	h.check(
		inScene.count === 1 && inScene.autoplay === true && inScene.tracks === 2,
		`scene.tpscene carries the sequence (${JSON.stringify(inScene)})`
	);
	h.check(inScene.minor >= 2, 'with formatMinor >= 2'); // 2 brought sequences; 3 (2.0-n3c) keeps them
	await A.ctx.close();

	// ---------- 3. served elsewhere, it autoplays ----------
	const dir = path.join(WORK, 'game');
	for (const [rel, data] of Object.entries(zip)) {
		if (rel.endsWith('/')) continue;
		const file = path.join(dir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, data);
	}
	const server = /** @type {any} */ (await serve({ '/': dir }));
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem('debugStores', 'true');
		} catch {
			/* no storage */
		}
	});
	const g = await ctx.newPage();
	/** @type {string[]} */
	const errors = [];
	g.on('pageerror', (e) => errors.push(e.message));
	await g.goto(`http://127.0.0.1:${server.address().port}/index.html`, {
		waitUntil: 'domcontentloaded'
	});
	await g.waitForFunction(
		() => /** @type {any} */ (window).__tp?.test.v1?.exportRuntime?.exportRuntimeState,
		null,
		{ timeout: 90000 }
	);
	await h.eventually(
		() =>
			g.evaluate(() => /** @type {any} */ (window).__tp.test.v1.exportRuntime.exportRuntimeState.phase),
		(v) => v === 'playing' || v === 'failed',
		'the exported game boots into Play',
		90000
	);
	// watch from INSIDE the page: the 4 s sequence must not be missed between two CDP polls
	const seen = await g.evaluate(async (cam) => {
		const S = /** @type {any} */ (window).__tp?.test.v1;
		const out = { shot: false, run: false, go: false, fired: /** @type {any[]} */ ([]) };
		const t0 = performance.now();
		while (performance.now() - t0 < 6000) {
			const d = S.sequencePlayer.sequencePlayerDebug();
			if (d.runs.some((r) => r.mode === 'game' && r.inPlay)) out.run = true;
			if (d.preview === cam) out.shot = true;
			let m;
			S.flowTriggers.subscribe((v) => (m = v))();
			if (typeof m['tlx-go']?.lastT === 'number') out.go = true;
			out.fired = d.fired;
			if (out.run && out.shot && out.go) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		return out;
	}, made.cam);
	h.check(seen.run, 'the sequence AUTOPLAYS in the exported game');
	h.check(seen.shot, 'it looks through its camera shot');
	h.check(
		seen.go,
		`and its event pulses the graph's On Sequence Event (${JSON.stringify(seen.fired.map((f) => f.name))})`
	);
	h.check(
		!errors.length,
		`no page errors in the exported game (${errors.slice(0, 2).join(' | ') || 'none'})`
	);
	await ctx.close();
	server.close();
	await h.finish(browser);
});
