#!/usr/bin/env node
// 31-perf P0 — THE PERF PROBE: the roadmap-31 Performance-protocol table for the seven
// Games-tab games, measured the same way every time so a before/after means something.
//
//   node scripts/perf-games.cjs [--label baseline-1.17] [--only waves,football] [--vr]
//                               [--seconds 10] [--throttle 4] [--out <dir>]
//
// Per game, on a FRESH page against a running dev server (APP_URL, default this lane's
// https://theprototype.app:5263/):
//   1 install the game's modules from their REAL zips (the sibling modules checkout, or
//     PERF_MODULES_DIR), through the Modules manager's own zip input
//   2 load the game's REAL .tpscene through the Games-tab path (`importSessionZip` +
//     `requestLoadSession`, what `sceneTemplates.loadRemoteScene` runs) — read from the
//     scenes repo at a git REF (PERF_SCENES_REF, default `preview-1-17`: the games as 1.17
//     ships them) or a directory (PERF_SCENES_DIR)
//   3 press the real Play button, then the game's own HUD Play/Start button when it has one
//     (else the shell is set to `playing`), and with `--vr` a fake XR session walks the left
//     stick forward the whole time (tests/e2e/fakeXR.cjs — the real per-frame VR path)
//   4 settle 2 s, then CPU-throttle x4 (CDP `Emulation.setCPUThrottlingRate`) for the
//     measured window and record: every render() call's draw calls + triangles (summed per
//     display frame), every rAF frame's duration, and the JS heap before/after
//   5 read the scene: geometries/textures (renderer.info.memory), a texture-MB estimate
//     (unique textures, w*h*4 x 4/3 for mips), lights, shadow-casting lights, shadow-casting
//     meshes, meshes / instanced meshes / meshes with frustumCulled off, shader programs
//
// Writes `perf-<label>.md` + `perf-<label>.json` into --out (default
// /home/deck/.code/lanes-30/after-31/31-perf). Run it under `e2e-slot --exclusive`: the
// frame times are the whole point, and a second browser on the machine is noise.
//
// Budget column = the planner's Quest target: <= 150 draw calls, <= 300k triangles,
// <= 2 real-time lights, shadows off in Interact.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('../tests/e2e/helpers.cjs');
const fx = require('../tests/e2e/fakeXR.cjs');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes('--' + name);

const LABEL = arg('label', 'run');
const SECONDS = Number(arg('seconds', '10'));
const THROTTLE = Number(arg('throttle', '4'));
const VR = flag('vr');
const PROFILE = flag('profile');
const OUT = arg('out', '/home/deck/.code/lanes-30/after-31/31-perf');
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const ROOT = path.resolve(__dirname, '../..');
const SCENES_REF = process.env.PERF_SCENES_REF || 'preview-1-17';
const SCENES_DIR = process.env.PERF_SCENES_DIR || null;
const SCENES_REPO = process.env.PERF_SCENES_REPO || [path.join(ROOT, 'scenes'), path.join(ROOT, 'theprototype.app-scenes')].find((p) => fs.existsSync(p));
const MODULES_DIR = process.env.PERF_MODULES_DIR || null;

const BUDGET = { calls: 150, triangles: 300000, lights: 2 };

/** read a file of the scenes repo: a directory override, else `git show REF:path` */
function sceneFile(rel) {
	if (SCENES_DIR) {
		const p = path.join(SCENES_DIR, rel);
		return fs.existsSync(p) ? fs.readFileSync(p) : null;
	}
	if (!SCENES_REPO) return null;
	try {
		return execFileSync('git', ['-C', SCENES_REPO, 'show', SCENES_REF + ':' + rel], { maxBuffer: 256 * 1024 * 1024 });
	} catch {
		return null;
	}
}

/** @param {string} id */
function zipFor(id) {
	const p = MODULES_DIR ? path.join(MODULES_DIR, id + '.zip') : h.moduleZipPath(id);
	return fs.existsSync(p) ? p : null;
}

async function installZip(page, id, file) {
	await page.evaluate(() => window.__stores.modulesOpen.set(true));
	await page.waitForTimeout(400);
	await page.getByRole('tab', { name: /^User/ }).click();
	await page.waitForTimeout(200);
	await page.locator('#install-module-zip').setInputFiles({ name: id + '.zip', mimeType: 'application/zip', buffer: fs.readFileSync(file) });
	const t0 = Date.now();
	while (Date.now() - t0 < 30000) {
		const ids = await page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id));
		if (ids.includes(id)) break;
		await page.waitForTimeout(250);
	}
	await page.evaluate(() => window.__stores.modulesOpen.set(false));
	await page.waitForTimeout(300);
}

/** In-page: start the recorder (render wrapper + rAF frame times). */
function startRecorder() {
	const s = window.__stores;
	let r;
	s.globalRenderer.subscribe((v) => (r = v))();
	const rec = { calls: 0, triangles: 0, renders: 0, frames: [], last: 0, on: true, heap0: performance.memory?.usedJSHeapSize ?? null };
	const inner = r.render;
	r.render = function (...a) {
		const out = inner.apply(this, a);
		const i = this.info?.render;
		if (rec.on && i) {
			rec.calls += i.calls;
			rec.triangles += i.triangles;
			rec.renders++;
		}
		return out;
	};
	const tick = (t) => {
		if (!rec.on) return;
		if (rec.last) rec.frames.push(t - rec.last);
		rec.last = t;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	rec.stop = () => {
		rec.on = false;
		r.render = inner;
	};
	window.__perfRec = rec;
}

/** In-page: stop the recorder and read the scene. */
function readScene() {
	const s = window.__stores;
	const rec = window.__perfRec;
	rec.stop();
	let r;
	s.globalRenderer.subscribe((v) => (r = v))();
	let scene;
	s.globalScene?.subscribe?.((v) => (scene = v))();
	if (!scene) {
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		scene = g;
		while (scene?.parent) scene = scene.parent;
	}
	const frames = rec.frames.slice().sort((a, b) => a - b);
	const pct = (q) => (frames.length ? frames[Math.min(frames.length - 1, Math.max(0, Math.ceil(q * frames.length) - 1))] : null);
	const n = rec.frames.length || 1;
	let lights = 0,
		shadowLights = 0,
		meshes = 0,
		instanced = 0,
		instances = 0,
		unculled = 0,
		castMeshes = 0,
		points = 0,
		objects = 0,
		skinned = 0;
	const textures = new Set();
	scene?.traverseVisible?.((o) => {
		objects++;
		if (o.isLight && !o.isAmbientLight && !o.isHemisphereLight) {
			lights++;
			if (o.castShadow && r.shadowMap.enabled) shadowLights++;
		}
		if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
			if (o.isMesh) meshes++;
			if (o.isPoints) points++;
			if (o.isSkinnedMesh) skinned++;
			if (o.isInstancedMesh) {
				instanced++;
				instances += o.count;
			}
			if (o.frustumCulled === false) unculled++;
			if (o.isMesh && o.castShadow && r.shadowMap.enabled) castMeshes++;
			const mats = Array.isArray(o.material) ? o.material : [o.material];
			for (const m of mats) {
				if (!m) continue;
				for (const k in m) if (m[k]?.isTexture) textures.add(m[k]);
				for (const k in m.uniforms ?? {}) if (m.uniforms[k]?.value?.isTexture) textures.add(m.uniforms[k].value);
			}
		}
	});
	if (scene?.background?.isTexture) textures.add(scene.background);
	if (scene?.environment?.isTexture) textures.add(scene.environment);
	let bytes = 0;
	for (const t of textures) {
		const img = t.image;
		const one = Array.isArray(img) ? img[0] : img;
		const w = one?.naturalWidth || one?.videoWidth || one?.width || 0;
		const h = one?.naturalHeight || one?.videoHeight || one?.height || 0;
		const faces = Array.isArray(img) ? img.length : 1;
		bytes += w * h * 4 * faces * (t.generateMipmaps === false ? 1 : 4 / 3);
	}
	let state = null;
	s.gameState?.gameState?.subscribe((v) => (state = v?.state ?? null))();
	return {
		frames: rec.frames.length,
		seconds: rec.frames.reduce((a, b) => a + b, 0) / 1000,
		p50: pct(0.5),
		p95: pct(0.95),
		p99: pct(0.99),
		max: frames[frames.length - 1] ?? null,
		calls: Math.round(rec.calls / n),
		triangles: Math.round(rec.triangles / n),
		rendersPerFrame: Math.round((rec.renders / n) * 10) / 10,
		geometries: r.info.memory.geometries,
		textures: r.info.memory.textures,
		sceneTextures: textures.size,
		textureMB: Math.round((bytes / 1048576) * 10) / 10,
		programs: r.info.programs?.length ?? null,
		lights,
		shadowLights,
		castMeshes,
		shadowMap: r.shadowMap.enabled,
		objects,
		meshes,
		instanced,
		instances,
		unculled,
		points,
		skinned,
		pixelRatio: r.getPixelRatio(),
		heapMB: performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10 : null,
		heapDeltaMB: performance.memory && rec.heap0 != null ? Math.round(((performance.memory.usedJSHeapSize - rec.heap0) / 1048576) * 10) / 10 : null,
		state
	};
}

async function probeGame(browser, game) {
	const bytes = sceneFile(game.scene);
	if (!bytes) return { slug: game.slug, skipped: 'no scene at ' + (SCENES_DIR || SCENES_REF) + ':' + game.scene };
	const missing = (game.modules || []).filter((m) => !zipFor(m.id)).map((m) => m.id);
	if (missing.length) return { slug: game.slug, skipped: 'no zip for ' + missing.join(', ') };

	const peer = await h.setupPage(browser, game.slug, { context: { viewport: { width: 1280, height: 720 } } });
	const page = peer.page;
	try {
		for (const m of game.modules || []) await installZip(page, m.id, zipFor(m.id));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.importSessionZip(new Uint8Array(arr).buffer);
			if (payload) await s.sessions.requestLoadSession(payload.id);
		}, Array.from(bytes));
		await page.waitForTimeout(3000);
		if (VR) {
			await fx.install(page);
			await fx.installSpace(page, { head: [0, 1.6, 0] });
		}
		await page.locator('#play-button').click({ timeout: 10000 }).catch(() => page.evaluate(() => window.__stores.isLocked.set(true)));
		await page.waitForTimeout(1500);
		const start = page.locator('#hud-layer button', { hasText: /^\W*(Play|Start)\b/i }).first();
		let started = 'hud';
		if (await start.count()) await start.click({ timeout: 3000 }).catch(() => (started = 'hud-click-failed'));
		else started = 'none';
		await page.waitForTimeout(500);
		const state = await page.evaluate(() => {
			let v;
			window.__stores.gameState.gameState.subscribe((x) => (v = x))();
			return v?.state ?? null;
		});
		if (state === 'menu') {
			await page.evaluate(() => window.__stores.gameState.setGameState('playing'));
			started = started === 'hud' ? 'hud+shell' : 'shell';
		}
		if (VR) await fx.stick(page, 'left', 0, -1);
		await page.waitForTimeout(2000);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
		if (PROFILE) {
			await cdp.send('Profiler.enable');
			await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
			await cdp.send('HeapProfiler.enable');
			await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
			await cdp.send('Profiler.start');
		}
		await page.evaluate(startRecorder);
		await page.waitForTimeout(SECONDS * 1000);
		/** @type {any} */
		let profile = null;
		if (PROFILE) {
			const cpu = (await cdp.send('Profiler.stop')).profile;
			const heap = (await cdp.send('HeapProfiler.stopSampling')).profile;
			profile = { cpu: topSelf(cpu), alloc: topAlloc(heap, SECONDS) };
		}
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		const m = await page.evaluate(readScene);
		if (profile) m.profile = profile;
		const errors = h.pageErrors ? h.pageErrors(peer).length : 0;
		return { slug: game.slug, title: game.title, modules: (game.modules || []).map((x) => x.id), started, pageErrors: errors, ...m };
	} catch (e) {
		return { slug: game.slug, error: String(e?.message ?? e).split('\n')[0] };
	} finally {
		await page.context().close().catch(() => {});
	}
}

/** where a frame is: `fn url:line`, the url trimmed to its path under the app */
function site(cf) {
	const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
	return (cf.functionName || '(anon)') + ' ' + (url || '(native)') + ':' + (cf.lineNumber + 1);
}

/** CPU self time per function, top 30, ms over the window (throttled time) */
function topSelf(p) {
	const byId = new Map(p.nodes.map((n) => [n.id, n]));
	const self = new Map();
	for (let i = 0; i < p.samples.length; i++) {
		const n = byId.get(p.samples[i]);
		const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000;
		self.set(n.id, (self.get(n.id) ?? 0) + dt);
	}
	const agg = new Map();
	let total = 0;
	for (const [id, ms] of self) {
		const k = site(byId.get(id).callFrame);
		agg.set(k, (agg.get(k) ?? 0) + ms);
		total += ms;
	}
	return {
		totalMs: Math.round(total),
		top: [...agg].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, ms]) => ({ site: k, ms: Math.round(ms * 10) / 10, pct: Math.round((ms / total) * 1000) / 10 }))
	};
}

/** sampled allocation (bytes allocated and still sampled at stop) per function, top 30, KB/s */
function topAlloc(p, seconds) {
	const agg = new Map();
	let total = 0;
	const walk = (n) => {
		if (n.selfSize) {
			const k = site(n.callFrame);
			agg.set(k, (agg.get(k) ?? 0) + n.selfSize);
			total += n.selfSize;
		}
		for (const c of n.children || []) walk(c);
	};
	walk(p.head);
	return {
		totalKBps: Math.round(total / 1024 / seconds),
		top: [...agg].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, b]) => ({ site: k, KBps: Math.round((b / 1024 / seconds) * 10) / 10 }))
	};
}

function fmt(v, d = 0) {
	return v == null ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v);
}
const over = (v, cap) => (v != null && v > cap ? ' ⚠' : '');

function table(rows) {
	const head =
		'| game | calls/frame | tris/frame | geos | tex (MB) | lights (shadow) | cast meshes | meshes / inst / unculled | p50 ms | p95 ms | p99 ms | heap Δ MB | started |\n' +
		'|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|';
	const lines = rows.map((r) =>
		r.skipped || r.error
			? `| ${r.slug} | ${r.skipped ? 'SKIP: ' + r.skipped : 'ERROR: ' + r.error} |||||||||||| |`
			: `| ${r.slug} | ${fmt(r.calls)}${over(r.calls, BUDGET.calls)} | ${fmt(r.triangles)}${over(r.triangles, BUDGET.triangles)} | ${fmt(r.geometries)} | ${fmt(r.textures)} (${fmt(r.textureMB, 1)}) | ${fmt(r.lights)}${over(r.lights, BUDGET.lights)} (${fmt(r.shadowLights)}) | ${fmt(r.castMeshes)} | ${fmt(r.meshes)} / ${fmt(r.instanced)} / ${fmt(r.unculled)} | ${fmt(r.p50, 1)} | ${fmt(r.p95, 1)} | ${fmt(r.p99, 1)} | ${fmt(r.heapDeltaMB, 1)} | ${r.started}${r.state ? ' → ' + r.state : ''} |`
	);
	return head + '\n' + lines.join('\n');
}

(async () => {
	const index = JSON.parse((sceneFile('index.json') || '{}').toString());
	let games = (index.games || []).map((g) => ({ slug: g.slug, title: g.title, scene: g.scene, modules: g.modules || [] }));
	if (ONLY.length) games = games.filter((g) => ONLY.includes(g.slug));
	if (!games.length) {
		console.error('no games found (scenes ' + (SCENES_DIR || SCENES_REPO + '@' + SCENES_REF) + ')');
		process.exit(2);
	}
	const browser = await h.launch({ args: [...h.GPU_ARGS, '--enable-precise-memory-info'] });
	const version = await (async () => {
		const p = await h.setupPage(browser, 'gpu');
		const v = await p.page.evaluate(() => {
			let r;
			window.__stores.globalRenderer.subscribe((x) => (r = x))();
			const gl = r.getContext();
			const ext = gl.getExtension('WEBGL_debug_renderer_info');
			return { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), app: window.__stores.version?.APP_VERSION ?? null };
		});
		await p.page.context().close();
		return v;
	})();
	console.log('GPU: ' + version.gpu);
	const rows = [];
	for (const g of games) {
		const t0 = Date.now();
		const r = await probeGame(browser, g);
		rows.push(r);
		console.log(`${g.slug}: ${r.skipped ? 'SKIP ' + r.skipped : r.error ? 'ERROR ' + r.error : `${r.calls} calls, ${r.triangles} tris, p50 ${fmt(r.p50, 1)} p95 ${fmt(r.p95, 1)} ms`} (${Math.round((Date.now() - t0) / 1000)}s)`);
	}
	await browser.close();
	const meta = {
		label: LABEL,
		at: new Date().toISOString(),
		app: h.URL,
		gpu: version.gpu,
		scenes: SCENES_DIR || SCENES_REF,
		seconds: SECONDS,
		cpuThrottle: THROTTLE,
		vr: VR,
		viewport: '1280x720',
		budget: BUDGET
	};
	const md =
		`## perf-games — ${LABEL}${VR ? ' (VR-emulated, walking)' : ''}\n\n` +
		`${meta.at} · ${meta.app} · GPU: ${meta.gpu} · scenes ${meta.scenes} · ${SECONDS} s of Play at CPU x${THROTTLE} · 1280x720\n` +
		`Quest budget: ≤ ${BUDGET.calls} calls, ≤ ${BUDGET.triangles / 1000}k tris, ≤ ${BUDGET.lights} lights (⚠ = over). calls/tris are per display frame, every render() pass summed (shadow pass included).\n\n` +
		table(rows) +
		'\n';
	fs.mkdirSync(OUT, { recursive: true });
	let prof = '';
	for (const r of rows.filter((r) => r.profile)) {
		prof += `\n### ${r.slug} — CPU self time (${r.profile.cpu.totalMs} ms sampled)\n\n` + r.profile.cpu.top.map((t) => `- ${t.pct}% ${t.ms} ms — ${t.site}`).join('\n') + '\n';
		prof += `\n### ${r.slug} — sampled allocation incl. collected (${r.profile.alloc.totalKBps} KB/s)\n\n` + r.profile.alloc.top.map((t) => `- ${t.KBps} KB/s — ${t.site}`).join('\n') + '\n';
	}
	fs.writeFileSync(path.join(OUT, `perf-${LABEL}.md`), md + prof);
	fs.writeFileSync(path.join(OUT, `perf-${LABEL}.json`), JSON.stringify({ meta, rows }, null, 2));
	console.log('\n' + md);
	console.log('wrote ' + path.join(OUT, `perf-${LABEL}.{md,json}`));
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
