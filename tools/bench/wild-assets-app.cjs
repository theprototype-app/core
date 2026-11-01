#!/usr/bin/env node
// Scenario 3D Collection — T1 IN THE APP: what each generator's output costs once it is imported.
//
//   node tools/bench/wild-assets-app.cjs --bench <bench.json> --stage <dir>   (hard-link the picks; then:)
//   WILD_ASSETS_DIR=<dir> APP_URL=https://theprototype.app:5476/ e2e-slot --dev . 5476 -- \
//     node tools/bench/wild-assets-app.cjs --bench <bench.json> --out <dir> [--groups 5] [--seconds 4]
//
// THE SET (owner scope trim 2026-10-24): 5 input groups — the owner's "Benchmark" tags' groups
// first, else the 5 with the most generators — and ONE asset per generator family per group (the
// family's median-size member there), from a headless bench run (tools/bench/wild-assets.mjs).
// Per asset, on a clean scene with the asset framed: import time (importFile, parse + optimize +
// gate), time to the first frame after it, then draw calls + triangles per display frame and the
// frame times AFTER auto LOD settled (scripts/perfProbe.cjs, the perf gate's own recorder), on the
// desktop profile and on the Quest analogue (a fake XR session, post + AO + shadows off, CPU x4 —
// perf-games.cjs --vr's recipe; one eye at the window size, so a relative number, not a Quest one).
// A desktop shot per asset; a contact sheet per group (sharp) in --out. NOT a frame-rate gate: the
// fps columns are relative between generators on one machine, so say which machine ran it.
// The data is CC BY 4.0, "Scenario"; the shots are evidence, never content.
const fs = require('fs');
const path = require('path');
const os = require('os');
const h = require('../../tests/e2e/helpers.cjs');
const fx = require('../../tests/e2e/fakeXR.cjs');
const { startRecorder, readScene, settleLod } = require('../../scripts/perfProbe.cjs');
const { openWildPage, deliver } = require('../../tests/e2e/wildPage.cjs');

const argv = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => (argv.includes('--' + n) ? argv[argv.indexOf('--' + n) + 1] : d);
const OUT = arg('out', path.resolve('wild-assets-app'));
const BENCH = arg('bench', path.join(OUT, 'bench.json'));
const GROUPS = Number(arg('groups', '5'));
const SECONDS = Number(arg('seconds', '4'));
const STATE = arg('state', path.join(os.homedir(), '.local/share/scenario-browser/state.json'));
const ROOTS = [process.env.WILD_ASSETS_DIR, path.join(os.homedir(), '.local/share/datasets/scenario-3d-collection/repo'), path.join(os.homedir(), '.cache/tp-wild/assets')].filter(Boolean);
/** @param {string} rel */
const locate = (rel) => ROOTS.map((r) => path.join(/** @type {string} */ (r), rel)).find((f) => fs.existsSync(f)) ?? null;

/** @param {any[]} rows */
function pickSet(rows) {
	let state = { tags: {} };
	try {
		state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
	} catch {
		/* no tags yet */
	}
	const ok = rows.filter((r) => r.m && locate(r.path));
	/** @type {Map<string, any[]>} */
	const byGroup = new Map();
	for (const r of ok) for (const g of r.groups) (byGroup.get(g) ?? byGroup.set(g, []).get(g))?.push(r);
	const owner = new Set(Object.entries(/** @type {any} */ (state).tags ?? {}).filter(([, t]) => (t?.cats ?? []).includes('Benchmark')).map(([id]) => id));
	const ranked = [...byGroup]
		.map(([g, list]) => ({ g, list, owner: list.some((r) => owner.has(r.id)), fams: new Set(list.map((r) => r.family)).size }))
		.sort((a, b) => Number(b.owner) - Number(a.owner) || b.fams - a.fams || b.list.length - a.list.length || (a.g < b.g ? -1 : 1))
		.slice(0, GROUPS);
	return ranked.map(({ g, list }) => {
		/** @type {Map<string, any[]>} */
		const fams = new Map();
		for (const r of list) (fams.get(r.family) ?? fams.set(r.family, []).get(r.family))?.push(r);
		const picks = [...fams].map(([, members]) => {
			const sorted = [...members].sort((a, b) => a.m.bytes - b.m.bytes);
			return sorted[Math.floor((sorted.length - 1) / 2)];
		});
		return { group: g, picks };
	});
}

/** in-page: frame the object at uuid (three-quarter view) @param {{uuid: string}} a */
function frame({ uuid }) {
	const s = window.__stores;
	const get = (/** @type {any} */ st) => {
		let v;
		st.subscribe((/** @type {any} */ x) => (v = x))();
		return v;
	};
	const g = get(s.objectsGroup);
	const cam = get(s.globalCamera);
	const orbit = get(s.orbitControls);
	const root = g.getObjectByProperty('uuid', uuid);
	s.selectedObjects.set([]);
	s.selectedObject.set(null);
	const box = new s.THREE.Box3().setFromObject(root);
	const c = box.getCenter(new s.THREE.Vector3());
	const r = Math.max(1e-3, box.getSize(new s.THREE.Vector3()).length() / 2);
	const dist = (r / Math.sin(((cam.fov ?? 50) * Math.PI) / 360)) * 1.1;
	cam.near = dist / 200;
	cam.far = dist * 200;
	cam.position.set(c.x + dist * 0.55, c.y + dist * 0.35, c.z + dist * 0.76);
	cam.updateProjectionMatrix();
	if (orbit) {
		orbit.target.copy(c);
		orbit.update();
	}
	return { center: c.toArray(), radius: r, dist };
}

/** @param {any} page @param {any} row */
async function importOne(page, row) {
	await deliver(page, locate, row.path);
	return page.evaluate(
		async ({ name }) => {
			const s = window.__stores;
			s.commandsHandler.clearSceneLocal();
			const t0 = performance.now();
			const uuid = await s.fileHandler.importFile(new File([/** @type {any} */ (window).__wildFiles.a], name), name);
			const importMs = performance.now() - t0;
			await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
			return { uuid, importMs: Math.round(importMs), firstFrameMs: Math.round(performance.now() - t0) };
		},
		{ name: (row.model + '.glb').replace(/[^\w.-]/g, '_') }
	);
}

/** @param {any} page @param {number} throttle */
async function measure(page, throttle) {
	await settleLod(page);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
	await page.evaluate(startRecorder);
	await page.waitForTimeout(SECONDS * 1000);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	const m = await page.evaluate(readScene);
	await cdp.detach().catch(() => {});
	return { calls: m.medianCalls, triangles: m.medianTriangles, fps: m.p50 ? Math.round(1000 / m.p50) : null, p95: m.p95 ? Math.round(m.p95) : null, lod: m.lodMeshes, coarse: m.lodCoarse };
}

h.run(async () => {
	if (!fs.existsSync(BENCH)) {
		console.log(`SKIP no bench (${BENCH}) — run tools/bench/wild-assets.mjs first`);
		process.exit(0);
	}
	const sets = pickSet(JSON.parse(fs.readFileSync(BENCH, 'utf8')).rows);
	// --stage <dir>: hard-link the picks into a small cache (a pc slot mirrors only WILD_ASSETS_DIR)
	if (argv.includes('--stage')) {
		const dir = arg('stage', '');
		let n = 0;
		for (const row of sets.flatMap((x) => x.picks)) {
			const from = locate(row.path);
			const to = path.join(dir, row.path);
			if (!from || fs.existsSync(to)) continue;
			fs.mkdirSync(path.dirname(to), { recursive: true });
			try {
				fs.linkSync(from, to);
			} catch {
				fs.copyFileSync(from, to);
			}
			n++;
		}
		console.log(`staged ${n} files (${sets.flatMap((x) => x.picks).length} picks) in ${dir}`);
		process.exit(0);
	}
	fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
	let browser = await h.launch({ args: h.GPU_ARGS });
	/** @type {any[]} */
	const results = [];
	for (const set of sets) {
		console.log(`\n=== group ${set.group}: ${set.picks.map((p) => p.family).join(', ')}`);
		for (const row of set.picks) {
			const out = { group: set.group, id: row.id, model: row.model, family: row.family, bytes: row.m.bytes, tris: row.m.cost.triangles };
			// a fresh context per asset: a 2M-triangle import must not slow the next one's numbers
			// a 4M+ triangle file can take the WHOLE browser down: the next asset gets a new one
			if (!browser.isConnected()) browser = await h.launch({ args: h.GPU_ARGS });
			// the heavy-model ask: load as it is (the measurement is of the file, not of a reduction)
			const A = await openWildPage(browser, locate, { 'This model is heavy': 'load' }, { context: { viewport: { width: 1280, height: 720 } }, storage: { lodEnabled: 'true' } });
			const page = A.page;
			try {
				await page.evaluate(() => window.__stores.qualityGovernor?.pinQuality?.());
				const imp = await importOne(page, row);
				Object.assign(out, imp);
				if (!imp.uuid) throw new Error('not imported');
				const view = await page.evaluate(frame, { uuid: imp.uuid });
				await page.waitForTimeout(1500);
				out.desktop = await measure(page, 1);
				const shot = path.join(OUT, 'shots', `${row.id}.png`);
				await page.screenshot({ path: shot });
				out.shot = shot;
				// the Quest analogue
				await fx.install(page);
				await fx.installSpace(page, { head: [view.center[0], view.center[1], view.center[2] + view.dist] });
				await page.evaluate(() => {
					const s = window.__stores;
					s.viewMode.set('shaded');
					s.viewportOverrides.setRenderLayer('post', false);
					s.lightParams.shadowQuality.set('off');
				});
				await page.waitForTimeout(1500);
				out.quest = await measure(page, 4);
				out.pageErrors = h.pageErrors(A).length;
			} catch (error) {
				out.error = String(/** @type {any} */ (error)?.message ?? error).split('\n')[0];
				if (!browser.isConnected()) out.error = 'the BROWSER crashed (' + out.error + ')';
			} finally {
				await A.ctx.close().catch(() => {});
			}
			console.log(JSON.stringify(out));
			results.push(out);
		}
	}
	await browser.close().catch(() => {});
	fs.writeFileSync(path.join(OUT, 'app-bench.json'), JSON.stringify(results, null, 1));
	await contactSheets(results);
	fs.writeFileSync(path.join(OUT, 'app-bench.md'), table(results));
	console.log(`app bench: ${results.length} assets → ${OUT}/app-bench.{json,md}`);
});

/** @param {any[]} results */
function table(results) {
	const out = [
		'| group | family | model | MB | tris k | import ms | first frame ms | desktop calls / tris k / fps | Quest-analogue calls / tris k / fps (p95 ms) | LOD meshes |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const r of results) {
		const d = r.desktop ?? {};
		const q = r.quest ?? {};
		out.push(
			`| ${r.group.replace(/^inputs\/asset_/, '').slice(0, 8)} | ${r.family} | ${r.model} | ${(r.bytes / 1e6).toFixed(1)} | ${(r.tris / 1e3).toFixed(0)} | ${r.importMs ?? '–'} | ${r.firstFrameMs ?? '–'} | ${d.calls ?? '–'} / ${d.triangles != null ? (d.triangles / 1e3).toFixed(0) : '–'} / ${d.fps ?? '–'} | ${q.calls ?? '–'} / ${q.triangles != null ? (q.triangles / 1e3).toFixed(0) : '–'} / ${q.fps ?? '–'} (${q.p95 ?? '–'}) | ${d.lod ?? '–'} |` + (r.error ? ` ERROR ${r.error}` : '')
		);
	}
	return out.join('\n') + '\n';
}

/** one sheet per group: the desktop shots side by side, labelled @param {any[]} results */
async function contactSheets(results) {
	const sharp = require('sharp');
	const W = 384;
	const H = 216;
	/** @type {Map<string, any[]>} */
	const byGroup = new Map();
	for (const r of results) if (r.shot && fs.existsSync(r.shot)) (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group))?.push(r);
	for (const [g, list] of byGroup) {
		const cols = Math.min(4, list.length);
		const rowsN = Math.ceil(list.length / cols);
		const tiles = await Promise.all(
			list.map(async (r, i) => {
				const label = `${r.family} · ${r.model} · ${(r.tris / 1e3).toFixed(0)}k tris · ${(r.bytes / 1e6).toFixed(1)} MB`;
				const svg = Buffer.from(`<svg width="${W}" height="22"><rect width="100%" height="100%" fill="#000" opacity="0.65"/><text x="6" y="15" font-family="sans-serif" font-size="12" fill="#fff">${label.replace(/[<&>]/g, '')}</text></svg>`);
				const img = await sharp(r.shot).resize(W, H, { fit: 'cover' }).composite([{ input: svg, top: H - 22, left: 0 }]).png().toBuffer();
				return { input: img, left: (i % cols) * W, top: Math.floor(i / cols) * H };
			})
		);
		const file = path.join(OUT, `sheet-${g.replace(/^inputs\//, '').replace(/\W+/g, '_')}.png`);
		await sharp({ create: { width: cols * W, height: rowsN * H, channels: 3, background: '#202020' } }).composite(tiles).png().toFile(file);
		console.log('sheet ' + file);
	}
}
