#!/usr/bin/env node
// 31-perf P0 — THE PERF PROBE: the roadmap-31 Performance-protocol table for the seven
// Games-tab games, measured the same way every time so a before/after means something.
//
//   node scripts/perf-games.cjs [--label baseline-1.17] [--only waves,football] [--vr]
//                               [--seconds 10] [--throttle 4] [--out <dir>] [--phone]
//
// 33 G1 `--phone`: a PHONE profile instead of the desktop one — a 412x915 viewport at
// deviceScaleFactor 2.625, isMobile + hasTouch (what reproduces a phone's page scale and
// `(pointer: coarse)`), and CPU x6 unless --throttle says otherwise. The GPU is still this
// machine's, so the fill-rate half of a phone shows up only as the PIXELS it would push:
// the table adds the drawing-buffer size and the post passes per frame.
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
//     stick forward the whole time (tests/e2e/fakeXR.cjs — the real per-frame VR path) with
//     the post stack + AO off, the nearest desktop analogue of a headset's direct render (a
//     fake session cannot present, so it is still ONE eye at 1280x720 — not a Quest number)
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
const { startRecorder, readScene, settleLod, settleScene } = require('./perfProbe.cjs');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes('--' + name);

// 34 B2 `--check`: THE BUDGET GATE (see the header of perfBudget.cjs and perf/README.md) —
// counts only, in ONE pinned profile, games AND levels, judged against perf/budgets.json;
// exit 1 when red. `--games-only` / `--levels-only` narrow it, `--budgets <file>` swaps the file.
const CHECK = flag('check');
const budgetLib = require('./perfBudget.cjs');
const BUDGETS = CHECK ? budgetLib.loadBudgets(arg('budgets', budgetLib.BUDGETS_FILE)) : null;

const LABEL = arg('label', CHECK ? 'check' : 'run');
const SECONDS = Number(arg('seconds', CHECK ? '3' : '10'));
const PHONE = flag('phone');
// the gate reads counts, which a throttle does not change — it only makes a runner slower
const THROTTLE = Number(arg('throttle', CHECK ? '1' : PHONE ? '6' : '4'));
// the gate's profile IS the headset analogue (the Quest budget's own column), standing still
const VR = flag('vr') || CHECK;
const WALK = VR && !CHECK;
const PROFILE = flag('profile');
const OUT = arg('out', CHECK ? path.join(__dirname, '..', 'perf', 'out') : '/home/deck/.code/lanes-30/after-31/31-perf');
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const ROOT = path.resolve(__dirname, '../..');
const SCENES_REF = process.env.PERF_SCENES_REF || BUDGETS?.scenes?.ref || 'preview-1-17';
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

// 34 B2: the profile's one stored setting — the adaptive governor OFF, so a slow runner cannot
// step quality down (shadows, LOD bias) and count a different scene than a fast desk does
const CHECK_STORAGE = { autoQuality: 'false' };

async function probeGame(browser, game) {
	const bytes = sceneFile(game.scene);
	if (!bytes) return { slug: game.slug, skipped: 'no scene at ' + (SCENES_DIR || SCENES_REF) + ':' + game.scene };
	const missing = (game.modules || []).filter((m) => !zipFor(m.id)).map((m) => m.id);
	if (missing.length) return { slug: game.slug, skipped: 'no zip for ' + missing.join(', ') };

	const context = PHONE
		? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }
		: { viewport: { width: 1280, height: 720 } };
	const peer = await h.setupPage(browser, game.slug, { context, storage: CHECK ? CHECK_STORAGE : undefined });
	const page = peer.page;
	try {
		for (const m of game.modules || []) await installZip(page, m.id, zipFor(m.id));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.importSessionZip(new Uint8Array(arr).buffer);
			if (payload) await s.sessions.requestLoadSession(payload.id);
		}, Array.from(bytes));
		await page.waitForTimeout(3000);
		if (CHECK) await settleScene(page);
		if (VR) {
			await fx.install(page);
			await fx.installSpace(page, { head: [0, 1.6, 0] });
			// a headset never runs the desktop post stack (Outline renders XR direct), and a
			// fake session cannot present — so the nearest desktop analogue of the XR render is
			// the same scene with post + AO off and a direct frame (A8's no-composite path)
			await page.evaluate(() => {
				const s = window.__stores;
				s.viewMode.set('shaded');
				s.viewportOverrides.setRenderLayer('post', false);
			});
		}
		// the gate: a headset ENTERS with shadows off (the governor's XR entry floor, step 1) —
		// the protocol's "shadows off in Interact"; the governor itself is off (CHECK_STORAGE)
		if (CHECK) await page.evaluate(() => window.__stores.lightParams.shadowQuality.set('off'));
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
		if (WALK) await fx.stick(page, 'left', 0, -1);
		await page.waitForTimeout(2000);
		if (CHECK) await settleLod(page);
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
	// WHO CALLS the heaviest functions: for the top 6, the nearest ancestor frame that is
	// app code (src/ or a module blob) — a svelte runtime or three frame on its own says
	// what is slow, never why it runs
	const parent = new Map();
	for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
	const top = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 30);
	const heavy = new Set(top.slice(0, 6).map(([k]) => k));
	const callers = new Map();
	for (const [id, ms] of self) {
		const k = site(byId.get(id).callFrame);
		if (!heavy.has(k)) continue;
		let up = parent.get(id);
		let found = null;
		/** @type {string[]} */
		const chain = [];
		while (up != null) {
			const cf = byId.get(up).callFrame;
			if (/\/src\/|^blob:/.test(cf.url || '')) {
				found = site(cf);
				break;
			}
			if (cf.functionName !== byId.get(id).callFrame.functionName && chain.length < 4) chain.push(cf.functionName || '(anon)');
			up = parent.get(up);
		}
		if (!found) found = 'no app frame; via ' + (chain.join(' < ') || '-');
		const key = k + ' <- ' + found;
		callers.set(key, (callers.get(key) ?? 0) + ms);
	}
	return {
		totalMs: Math.round(total),
		top: top.map(([k, ms]) => ({ site: k, ms: Math.round(ms * 10) / 10, pct: Math.round((ms / total) * 1000) / 10 })),
		callers: [...callers].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, ms]) => ({ site: k, ms: Math.round(ms * 10) / 10 }))
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
		'| game | calls/frame | tris/frame | geos | tex (MB) | lights (shadow) | cast meshes | meshes / inst / unculled | LOD (coarse) | quality | renders/frame | Mpx (dpr) | physical / transparent | p50 ms | p95 ms | p99 ms | heap Δ MB | started |\n' +
		'|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|';
	const lines = rows.map((r) =>
		r.skipped || r.error
			? `| ${r.slug} | ${r.skipped ? 'SKIP: ' + r.skipped : 'ERROR: ' + r.error} ||||||||||||||||| |`
			: `| ${r.slug} | ${fmt(r.calls)}${over(r.calls, BUDGET.calls)} | ${fmt(r.triangles)}${over(r.triangles, BUDGET.triangles)} | ${fmt(r.geometries)} | ${fmt(r.textures)} (${fmt(r.textureMB, 1)}) | ${fmt(r.lights)}${over(r.lights, BUDGET.lights)} (${fmt(r.shadowLights)}) | ${fmt(r.castMeshes)} | ${fmt(r.meshes)} / ${fmt(r.instanced)} / ${fmt(r.unculled)} | ${fmt(r.lodMeshes)} (${fmt(r.lodCoarse)}) | ${fmt(r.quality)} | ${fmt(r.rendersPerFrame, 1)} | ${fmt(r.bufferPx, 2)} (${fmt(r.pixelRatio, 2)}) | ${fmt(r.physical)} / ${fmt(r.transparent)} | ${fmt(r.p50, 1)} | ${fmt(r.p95, 1)} | ${fmt(r.p99, 1)} | ${fmt(r.heapDeltaMB, 1)} | ${r.started}${r.state ? ' → ' + r.state : ''} |`
	);
	return head + '\n' + lines.join('\n');
}

/**
 * 34 B2 — THE GATE: every game and every level with viewpoints, counted in the pinned profile,
 * judged against perf/budgets.json. Exit 0 green, 1 red, 2 when it could not run at all.
 */
async function runCheck() {
	const index = JSON.parse((sceneFile('index.json') || '{}').toString());
	const gamesOnly = flag('games-only');
	const levelsOnly = flag('levels-only');
	const pick = (slug) => !ONLY.length || ONLY.includes(slug);
	const { checkLevel, VIEWS } = require('./perf-levels.cjs');
	const games = levelsOnly ? [] : (index.games || []).filter((g) => pick(g.slug)).map((g) => ({ slug: g.slug, title: g.title, scene: g.scene, modules: g.modules || [] }));
	const levels = gamesOnly ? [] : (index.templates || []).filter((t) => VIEWS[t.slug] && pick(t.slug));
	if (!games.length && !levels.length) {
		console.error('budget gate: nothing to measure (scenes ' + (SCENES_DIR || SCENES_REPO + '@' + SCENES_REF) + ')');
		process.exit(2);
	}
	// SWIFTSHADER=1 measures without the GPU — what a GitHub runner does (the determinism proof)
	const browser = await h.launch({ args: process.env.SWIFTSHADER ? [] : h.GPU_ARGS });
	/** @type {any[]} */
	const rows = [];
	const counts = (m) => ({ calls: m.medianCalls, triangles: m.medianTriangles, lights: m.lights, textureMB: m.textureMB, maxCalls: m.maxCalls, castLights: m.castLights, frames: m.renderedFrames });
	for (const g of games) {
		const t0 = Date.now();
		let r = await probeGame(browser, g);
		// one retry: a page that lost its recorder or WebGL context is the runner, not the scene
		if (r.error) r = await probeGame(browser, g);
		rows.push(r.skipped || r.error ? { kind: 'game', slug: g.slug, error: r.skipped ?? r.error } : { kind: 'game', slug: g.slug, ...counts(r), started: r.started, state: r.state });
		const last = rows[rows.length - 1];
		console.log(`game ${g.slug}: ${last.error ? 'NOT MEASURED ' + last.error : `${last.calls} calls (max ${last.maxCalls}), ${last.triangles} tris, ${last.lights} lights, ${last.textureMB} MB over ${last.frames} frames`} (${Math.round((Date.now() - t0) / 1000)}s)`);
	}
	for (const t of levels) {
		const t0 = Date.now();
		const bytes = sceneFile(t.scene || `templates/${t.slug}/scene.tpscene`);
		const once = () => checkLevel(browser, t.slug, /** @type {Buffer} */ (bytes), { seconds: SECONDS, storage: CHECK_STORAGE, settle: settleScene });
		let r = bytes ? await once() : { slug: t.slug, error: 'no scene file' };
		if (bytes && r.error) r = await once();
		if (r.error || !r.views?.length) rows.push({ kind: 'level', slug: t.slug, error: r.error ?? 'no views measured' });
		else for (const v of r.views) rows.push({ kind: 'level', slug: t.slug, view: v.label, ...counts(v) });
		console.log(`level ${t.slug}: ${r.error ?? r.views.map((v) => `${v.label} ${v.medianCalls}`).join(' · ')} (${Math.round((Date.now() - t0) / 1000)}s)`);
	}
	await browser.close();
	const verdict = budgetLib.judge(BUDGETS, rows);
	const head =
		`## perf budget gate — ${LABEL}\n\n${new Date().toISOString()} · ${h.URL} · scenes ${SCENES_DIR || SCENES_REF} · ` +
		`profile: headset analogue (1280x720, post off, Shaded, shadows off, governor off), standing at the spawn/viewpoint, ` +
		`median display frame over ${SECONDS} s · ${process.env.SWIFTSHADER ? 'SwiftShader' : 'GPU args'}\n\n`;
	const md = head + budgetLib.report(verdict);
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(path.join(OUT, `budget-${LABEL}.md`), md);
	fs.writeFileSync(path.join(OUT, `budget-${LABEL}.json`), JSON.stringify({ rows, verdict: { ok: verdict.ok, failures: verdict.failures, warnings: verdict.warnings } }, null, 1));
	console.log('\n' + md);
	console.log('wrote ' + path.join(OUT, `budget-${LABEL}.{md,json}`));
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
	process.exit(verdict.ok ? 0 : 1);
}

if (CHECK)
	runCheck().catch((e) => {
		console.error(e);
		process.exit(2);
	});
else (async () => {
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
		viewport: PHONE ? '412x915@2.625 (phone)' : '1280x720',
		budget: BUDGET
	};
	const md =
		`## perf-games — ${LABEL}${VR ? ' (VR-emulated, walking)' : ''}\n\n` +
		`${meta.at} · ${meta.app} · GPU: ${meta.gpu} · scenes ${meta.scenes} · ${SECONDS} s of Play at CPU x${THROTTLE} · ${meta.viewport}\n` +
		`Quest budget: ≤ ${BUDGET.calls} calls, ≤ ${BUDGET.triangles / 1000}k tris, ≤ ${BUDGET.lights} lights (⚠ = over). calls/tris are per display frame, every render() pass summed (shadow pass included).\n\n` +
		table(rows) +
		'\n';
	fs.mkdirSync(OUT, { recursive: true });
	let prof = '';
	for (const r of rows.filter((r) => r.profile)) {
		prof += `\n### ${r.slug} — CPU self time (${r.profile.cpu.totalMs} ms sampled)\n\n` + r.profile.cpu.top.map((t) => `- ${t.pct}% ${t.ms} ms — ${t.site}`).join('\n') + '\n';
		prof += `\n### ${r.slug} — who calls the heaviest (nearest app frame)\n\n` + r.profile.cpu.callers.map((t) => `- ${t.ms} ms — ${t.site}`).join('\n') + '\n';
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
