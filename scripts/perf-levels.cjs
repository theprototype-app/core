#!/usr/bin/env node
// 33-scenes — THE LEVEL PROBE: draw calls per display frame for the General-tab LEVELS
// (scripts/level-templates.cjs), from named viewpoints, so "≤ 150 calls on a Quest" is a
// measured claim per scene and not a feeling. The Performance protocol's numbers (31 rules),
// read the way scripts/perf-games.cjs reads them: every render() pass in a display frame is
// summed (the shadow pass included), averaged over a short window per viewpoint.
//
//   node scripts/perf-levels.cjs --dir <scenes tree with templates/<slug>/scene.tpscene>
//        [--only tavern-interior,market-square] [--seconds 2] [--out <dir>] [--label run]
//
// Per level, on a FRESH page: load the .tpscene through the Templates path
// (`importSessionZip` + `requestLoadSession`), wait for every kit piece to refill
// (packRefsSettled) and every animated item to register, press Play, then for each
// viewpoint put the rig there and record. Two render modes per viewpoint:
//   desktop — the scene's own look (post stack + AO), what a desktop player sees;
//   vr      — the headset analogue: post off, Shaded, direct render (a fake XR session
//             cannot present, so this is the nearest desktop reading of the XR frame).
// The Quest budget applies to `vr`.
//
// Viewpoints come from VIEWS below (per slug), else the spawn alone.
const path = require('path');
const fs = require('fs');
const h = require('../tests/e2e/helpers.cjs');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const DIR = arg('dir', null);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const SECONDS = Number(arg('seconds', '2'));
const OUT = arg('out', '/home/deck/.code/lanes-30/after-33/33-scenes');
const LABEL = arg('label', 'run');
// the counterfactual: the same views with kit instancing OFF (kitInstancing.js)
const NO_INSTANCING = argv.includes('--no-instancing');
const CELL = Number(arg('cell', '0')) || 0;
const BUDGET = 150;
const PI = Math.PI;

/** [label, feet [x, y, z], yaw] — yaw 0 looks -Z (the spawn convention) */
const VIEWS = require('./level-views.cjs');

function startRecorder() {
	const s = window.__stores;
	let r;
	s.globalRenderer.subscribe((v) => (r = v))();
	const rec = { calls: 0, triangles: 0, renders: 0, frames: 0, last: 0, on: true, max: 0, cur: 0 };
	const inner = r.render;
	r.render = function (...a) {
		const out = inner.apply(this, a);
		const i = this.info?.render;
		if (rec.on && i) {
			rec.calls += i.calls;
			rec.cur += i.calls;
			rec.triangles += i.triangles;
			rec.renders++;
		}
		return out;
	};
	const tick = () => {
		if (!rec.on) return;
		rec.frames++;
		rec.max = Math.max(rec.max, rec.cur);
		rec.cur = 0;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	rec.stop = () => {
		rec.on = false;
		r.render = inner;
		const n = rec.frames || 1;
		return { calls: Math.round(rec.calls / n), maxCalls: rec.max, triangles: Math.round(rec.triangles / n), renders: Math.round((rec.renders / n) * 10) / 10 };
	};
	window.__levelRec = rec;
}

async function probe(browser, slug, bytes) {
	const peer = await h.setupPage(browser, slug, { context: { viewport: { width: 1280, height: 720 } } });
	const page = peer.page;
	const out = { slug, views: [] };
	try {
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.importSessionZip(new Uint8Array(arr).buffer);
			if (payload) await s.sessions.requestLoadSession(payload.id);
		}, Array.from(bytes));
		if (NO_INSTANCING) await page.evaluate(() => window.__stores.kitInstancing?.kitInstancingEnabled.set(false));
		if (CELL) await page.evaluate((c) => window.__stores.kitInstancing?.setKitCellMetres(c), CELL);
		await page.waitForTimeout(1500);
		await page.evaluate(() => window.__stores.packRefs.packRefsSettled());
		await page.waitForTimeout(2500);
		out.objects = await page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			let meshes = 0;
			g.traverse((n) => n.isMesh && meshes++);
			return { top: g.children.length, meshes, behaviors: window.__stores.animatedImports.behaviorUuids?.().length ?? 0 };
		});
		await page.locator('#play-button').click({ timeout: 10000 }).catch(() => page.evaluate(() => window.__stores.isLocked.set(true)));
		await page.waitForTimeout(2500);
		const views = VIEWS[slug] ?? [];
		for (const mode of ['desktop', 'vr']) {
			await page.evaluate((mode) => {
				const s = window.__stores;
				s.viewportOverrides.setRenderLayer('post', mode === 'desktop');
				// a headset starts with shadows OFF (the governor's XR entry floor, qualityGovernorCore
				// "step 1 = shadows off" — the protocol's "shadows off in Interact")
				if (mode === 'vr') {
					s.viewMode.set('shaded');
					s.lightParams.shadowQuality.set('off');
				}
			}, mode);
			for (const [label, feet, yaw] of views) {
				await page.evaluate(
					({ feet, yaw }) => {
						const s = window.__stores;
						let cam;
						s.playerCam.subscribe((c) => (cam = c))();
						const v = new s.THREE.Vector3(feet[0], feet[1] + 1.7, feet[2]);
						cam.parent?.worldToLocal(v);
						cam.position.copy(v);
						cam.quaternion.setFromEuler(new s.THREE.Euler(0, yaw, 0, 'YXZ'));
						cam.updateMatrixWorld(true);
					},
					{ feet, yaw }
				);
				await page.waitForTimeout(600);
				await page.evaluate(startRecorder);
				await page.waitForTimeout(SECONDS * 1000);
				const m = await page.evaluate(() => ({ ...window.__levelRec.stop(), batches: window.__stores.kitInstancing?.kitInstancingStats().batches ?? null, batched: window.__stores.kitInstancing?.kitInstancingStats().members ?? null }));
				out.views.push({ mode, label, ...m });
				if (process.env.SHOTS) await page.screenshot({ path: path.join(OUT, `view-${LABEL}-${slug}-${mode}-${label.replace(/\W+/g, '-')}.png`) });
			}
		}
		out.pageErrors = h.pageErrors ? h.pageErrors(peer).length : 0;
	} catch (e) {
		out.error = String(e?.message ?? e).split('\n')[0];
	} finally {
		await page.context().close().catch(() => {});
	}
	return out;
}

(async () => {
	if (!DIR) throw new Error('--dir <scenes tree> is required');
	const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
	const rows = (index.templates ?? []).filter((r) => (ONLY.length ? ONLY.includes(r.slug) : VIEWS[r.slug]));
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const results = [];
	for (const row of rows) {
		const file = path.join(DIR, 'templates', row.slug, 'scene.tpscene');
		if (!fs.existsSync(file)) continue;
		const r = await probe(browser, row.slug, fs.readFileSync(file));
		results.push(r);
		console.log(row.slug, r.error ?? '', JSON.stringify(r.objects ?? {}));
		for (const v of r.views) console.log(`  ${v.mode.padEnd(7)} ${v.label.padEnd(28)} calls ${String(v.calls).padStart(4)} (max ${v.maxCalls})${v.mode === 'vr' && v.calls > BUDGET ? ' OVER' : ''}  tris ${v.triangles}  renders/frame ${v.renders}  batches ${v.batches} (${v.batched} meshes)`);
	}
	await browser.close();
	let md = `# perf-levels ${LABEL}\n\nCalls per display frame (every render pass summed), mean over ${SECONDS} s per view. Quest budget ${BUDGET} applies to the vr column.\n\n| level | view | desktop calls | vr calls (max) | vr tris |\n|---|---|---:|---:|---:|\n`;
	for (const r of results) {
		const labels = [...new Set(r.views.map((v) => v.label))];
		for (const l of labels) {
			const d = r.views.find((v) => v.mode === 'desktop' && v.label === l);
			const v = r.views.find((x) => x.mode === 'vr' && x.label === l);
			md += `| ${r.slug} | ${l} | ${d?.calls ?? '-'} | ${v?.calls ?? '-'} (${v?.maxCalls ?? '-'})${v && v.calls > BUDGET ? ' ⚠' : ''} | ${v?.triangles ?? '-'} |\n`;
		}
	}
	fs.writeFileSync(path.join(OUT, `perf-levels-${LABEL}.md`), md);
	fs.writeFileSync(path.join(OUT, `perf-levels-${LABEL}.json`), JSON.stringify(results, null, 1));
	console.log(md);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
