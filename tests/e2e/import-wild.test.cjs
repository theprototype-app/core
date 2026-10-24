// "FILES FROM THE WILD" — real AI-generated models through the whole import pipeline.
//
// The fixtures are the Scenario 3D Collection's outputs picked for their extremes (largest file,
// most triangles / materials / draw calls, no PBR, odd scale, Z-up, unapplied root transforms,
// PartCrafter multi-part, scene builders, Rodin HighPack, a texture whose MIME type lies, FBX),
// named in tests/fixtures/wild/manifest.json with the numbers the headless bench
// (tools/bench/wild-assets.mjs) measured. NOTHING IS COMMITTED: `node scripts/fetch-wild-assets.cjs`
// fills the cache; with an empty cache this suite prints SKIP and passes, so CI stays green.
//
// Per fixture (one page, one at a time, the scene cleared between):
//   1. it imports — placed, no page error, no console error;
//   2. what the app measured is what the bench measured (triangles, draw calls, largest mesh,
//      textures), and the budget gate asked exactly when the app's own rule (importVerdict) says it
//      should for the bench's numbers;
//   3. LOD: an import over the triangle threshold carries its LOD group (46 P2); under it, a dense
//      mesh is taken by auto LOD (31 P2, ≥ 3000 triangles) and a skinned one by neither;
//   4. scene-lint's static budget rule on the saved scene matches the measured cost;
//   5. the export round trip (the "For Quest / web" glTF-Transform preset) keeps the look: the same
//      framing before and after, pixel diff under a tolerance;
//   6. 59 modelSanity: replacing the model with ITSELF flags exactly what the file alone carries
//      (scale and Z-up need a different old model, so they cannot fire; unapplied root transforms
//      can) — the bench's `fileIssues`.
// Then the Replace pairs: generator A's model replaced by generator B's for the SAME input keeps
// uuid / name / pose / physics / flow wiring in ONE undo step, and the sanity dialog lists exactly
// the issues modelSanity's rule gives for the two measured boxes.
//
//   WILD_ONLY=<substr,…>  only fixtures whose id / path / model / reason contains one of them
//   WILD_MAX_MB=<n>       skip fixtures larger than n MB (default: none)
//   WILD_NO_ROUNDTRIP=1   skip step 5 (the slowest)
//   SHOTS_DIR=<dir>       keep the before/after frames of step 5
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const h = require('./helpers.cjs');
const { cacheDir, datasetDir, readManifest } = require('../../scripts/fetch-wild-assets.cjs');
const { lintSession } = require('../../scripts/scene-lint.cjs');
const { openWildPage, deliver } = require('./wildPage.cjs');

/** the look may change this much in the round trip: share of pixels off by more than the delta */
const LOOK_FRACTION = 0.04;
const LOOK_DELTA = 48;
/** fixtures above this many bytes run last */
const HEAVY = 100e6;
/** …and above this many triangles */
const HEAVY_TRIS = 3e6;

const roots = [cacheDir(), datasetDir()].filter(Boolean);
/** @param {string} rel */
const locate = (rel) => roots.map((r) => path.join(/** @type {string} */ (r), rel)).find((f) => fs.existsSync(f)) ?? null;
/** @param {string} file */
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** fixtures on disk with the right bytes, after the env filters @param {any[]} list */
function available(list) {
	const only = process.env.WILD_ONLY ? process.env.WILD_ONLY.split(',') : null;
	const maxMB = Number(process.env.WILD_MAX_MB) || Infinity;
	return list.filter((f) => {
		if (only && !only.some((o) => [f.id, f.path, f.model, ...(f.why ?? [])].join(' ').includes(o))) return false;
		const file = locate(f.path);
		if (!file || fs.statSync(file).size / 1e6 > maxMB) return false;
		return sha256(file) === f.sha256;
	});
}

/** one line per fixture for the evidence table */
const rows = [];

h.run(async () => {
	let manifest;
	try {
		manifest = readManifest();
	} catch {
		console.log('SKIP no tests/fixtures/wild/manifest.json');
		process.exit(0);
	}
	const fixtures = available(manifest.fixtures ?? []);
	const pairs = (manifest.pairs ?? []).filter((p) => available([p.a]).length && available([p.b]).length);
	if (!fixtures.length && !pairs.length) {
		console.log(`SKIP no import-wild fixtures in the cache (${roots.join(', ') || 'none'}) — run: node scripts/fetch-wild-assets.cjs`);
		process.exit(0);
	}
	console.log(`import-wild: ${fixtures.length} of ${manifest.fixtures.length} fixtures, ${pairs.length} of ${(manifest.pairs ?? []).length} pairs (cache ${roots.join(', ')})`);

	let browser = await h.launch({ args: h.GPU_ARGS });
	const ANSWERS = { 'This model is heavy': 'load', 'replace-model-sanity': 'asis' };
	const open = async () => {
		// a 4M+ triangle file can take the WHOLE browser down, not just its tab
		if (!browser.isConnected()) {
			console.log('  (the browser died — launching a new one)');
			browser = await h.launch({ args: h.GPU_ARGS });
		}
		const A = await openWildPage(browser, locate, ANSWERS, { context: { viewport: { width: 1280, height: 800 } } });
		await A.page.evaluate(() => window.__stores.lod.lodEnabled.set(true));
		return A;
	};
	let A = await open();

	// the delayed object sync (sendObjects waits 500 ms) must survive the model leaving the scene
	// first — found by this suite: a replace followed by the next fixture's clear threw
	// "Cannot read properties of null (reading 'parent')" from inside the timer
	const smallest = [...fixtures].filter((f) => f.format === 'glb').sort((a, b) => (a.expect?.bytes ?? 0) - (b.expect?.bytes ?? 0))[0];
	if (smallest) {
		const before = h.pageErrors(A).length;
		await deliver(A.page, locate, smallest.path);
		await A.page.evaluate(async () => {
			const s = window.__stores;
			s.commandsHandler.clearSceneLocal();
			await s.fileHandler.importFile(new File([/** @type {any} */ (window).__wildFiles.a], 'quick.glb'), 'quick');
			s.commandsHandler.clearSceneLocal();
		});
		await A.page.waitForTimeout(900);
		const thrown = h.pageErrors(A).slice(before);
		h.check(thrown.length === 0, 'an import cleared within the 500 ms sync delay throws nothing' + (thrown.length ? ` — ${thrown[0].slice(0, 120)}` : ''));
	}

	// the heaviest last: a file that takes the tab down costs the run one fresh page, not the rest
	const heavy = (/** @type {any} */ f) => Number((f.expect?.bytes ?? 0) > HEAVY || (f.expect?.cost.triangles ?? 0) > HEAVY_TRIS);
	const order = [...fixtures].sort((a, b) => heavy(a) - heavy(b));
	const light = order.filter((f) => !heavy(f));
	const heavies = order.filter((f) => heavy(f));
	const runFixture = async (/** @type {any} */ f) => {
		console.log(`\n=== ${f.family} · ${f.model} · ${f.path} (${f.why.join('; ')})`);
		const consoleAt = A.page.__console.length;
		try {
			await oneFixture(A.page, f);
		} catch (error) {
			const message = String(/** @type {any} */ (error)?.message ?? error).split('\n')[0];
			if (A.crashed || A.page.isClosed() || !browser.isConnected()) {
				const whole = !browser.isConnected();
				// what the tab had been asked before it died (the dialog log survives on the node side)
				const asked = A.page.__console.slice(consoleAt).filter((/** @type {any} */ m) => m.text.startsWith('[wild]')).map((/** @type {any} */ m) => m.text);
				h.check(false, `${f.family} ${f.id.slice(6, 14)}: the ${whole ? 'BROWSER' : 'TAB'} CRASHED importing ${(f.expect?.bytes / 1e6 || 0).toFixed(0)} MB / ${((f.expect?.cost.triangles ?? 0) / 1e6).toFixed(1)}M tris (${asked.join('; ') || 'no dialog reached node before it died'})`);
				rows.push({ id: f.id, model: f.model, family: f.family, crashed: whole ? 'browser' : 'tab', asked });
				await A.ctx.close().catch(() => {});
				A = await open();
			} else {
				h.check(false, `${f.id}: the suite step threw — ${message}`);
				rows.push({ id: f.id, model: f.model, error: message.slice(0, 200) });
			}
		}
	};
	for (const f of light) await runFixture(f);
	for (const p of pairs) {
		console.log(`\n=== ${p.why}: ${p.a.model} → ${p.b.model} (group ${p.group})`);
		try {
			await onePair(A.page, p);
		} catch (error) {
			h.check(false, `${p.why}: the suite step threw — ${String(/** @type {any} */ (error)?.message ?? error).split('\n')[0]}`);
			if (A.crashed || A.page.isClosed() || !browser.isConnected()) A = await open();
		}
	}
	// the heaviest last (light fixtures, then the Replace pairs, then these)
	for (const f of heavies) await runFixture(f);
	if (process.env.SHOTS_DIR) fs.writeFileSync(path.join(process.env.SHOTS_DIR, 'import-wild.json'), JSON.stringify(rows, null, 1));
	await h.finish(browser);
});

/** @param {any} page @param {any} f */
async function oneFixture(page, f) {
	const e = f.expect; // null for an unmeasured format (FBX)
	const tag = `${f.family} ${f.id.slice(6, 14)}`;
	const errorsBefore = h.pageErrors({ page }).length;
	const consoleBefore = page.__console.length;
	const name = (f.model + '-' + f.id.slice(6, 12) + '.' + f.format).replace(/[^\w.-]/g, '_');

	// ---- 1. import ----------------------------------------------------------------------------
	await deliver(page, locate, f.path);
	const r = await page.evaluate(
		async ({ name }) => {
			const s = window.__stores;
			/** @type {any} */
			const w = window;
			s.commandsHandler.clearSceneLocal();
			w.__wild.dialogs = [];
			const t0 = performance.now();
			const uuid = await s.fileHandler.importFile(new File([w.__wildFiles.a], name), name);
			const importMs = performance.now() - t0;
			await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
			const firstFrameMs = performance.now() - t0;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const root = uuid ? g.getObjectByProperty('uuid', uuid) : null;
			let verdict;
			s.importGate.lastImportVerdict.subscribe((v) => (verdict = v))();
			const cost = root ? s.importBudget.modelCost(root) : null;
			return {
				uuid,
				importMs: Math.round(importMs),
				firstFrameMs: Math.round(firstFrameMs),
				animated: uuid ? s.animatedImports.hasAnimatedImport(uuid) : false,
				lod: root?.userData?.lod ?? null,
				optimized: root?.userData?.optimized ? { lod: root.userData.optimized.lod, resized: root.userData.optimized.texturesResized, max: root.userData.optimized.textureMaxAfter } : null,
				cost,
				verdict: verdict && { gate: verdict.gate, asking: verdict.asking.map((/** @type {any} */ a) => a.key), incoming: verdict.incoming, profile: verdict.profile },
				dialogs: w.__wild.dialogs.map((/** @type {any} */ d) => d.title)
			};
		},
		{ name }
	);
	const row = { id: f.id, model: f.model, family: f.family, why: f.why.join('; '), importMs: r.importMs, firstFrameMs: r.firstFrameMs, tris: r.cost?.triangles, draws: r.cost?.draws, gate: r.verdict?.gate, lod: !!r.lod };
	rows.push(row);
	h.check(!!r.uuid, `${tag}: imported (${r.importMs} ms, first frame ${r.firstFrameMs} ms)`);
	if (!r.uuid) return;
	const newErrors = h.pageErrors({ page }).slice(errorsBefore);
	h.check(newErrors.length === 0, `${tag}: no page error during the import` + (newErrors.length ? ` — ${newErrors[0].slice(0, 160)}` : ''));
	const consoleErrors = page.__console.slice(consoleBefore).filter((/** @type {any} */ m) => m.type === 'error');
	h.check(consoleErrors.length === 0, `${tag}: no console error during the import` + (consoleErrors.length ? ` — ${consoleErrors[0].text.slice(0, 160)}` : ''));
	const unexpected = r.dialogs.filter((/** @type {string} */ t) => t !== 'This model is heavy');
	h.check(unexpected.length === 0, `${tag}: no unexpected dialog (${unexpected.join(', ') || 'none'})`);
	if (!e) {
		console.log(`  (unmeasured ${f.format}: app cost ${JSON.stringify(r.cost)})`);
		await cleanup(page);
		return;
	}

	// ---- 2. the app measures what the bench measured; the gate follows the app's own rule ------
	const p = await page.evaluate(
		({ e }) => {
			const s = window.__stores;
			let settings;
			s.importOptimize.importSettings.subscribe((v) => (settings = v))();
			const decision = s.gltfOptimize.importDecision({ triangles: e.cost.triangles, maxTextureSide: e.cost.maxTextureSize }, settings);
			// what will be placed (46 P2): when the import optimizes a textured glTF, the engine fits
			// EVERY texture to the cap (gltfOptimize/core.js fitSize), whichever threshold it crossed
			const engine = decision.optimize && e.cost.maxTextureSize > 0 && (decision.textures || settings.compress) && /\.(glb|gltf)$/i.test(e.path);
			const fit = (/** @type {number[]} */ [w, h]) => {
				const max = settings.maxTextureSize;
				if (!engine || !max || Math.max(w, h) <= max) return [w, h];
				const k = max / Math.max(w, h);
				return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
			};
			const dims = (e.textureDims ?? []).map(fit);
			const placed = {
				...e.cost,
				maxTextureSize: dims.length ? Math.max(...dims.flat()) : engine ? Math.min(e.cost.maxTextureSize, settings.maxTextureSize) : e.cost.maxTextureSize,
				textureBytes: dims.length ? dims.reduce((n, [w, h]) => n + Math.round(w * h * 4 * (4 / 3)), 0) : e.cost.textureBytes
			};
			let renderer;
			s.globalRenderer.subscribe((v) => (renderer = v))();
			const verdict = s.importBudget.importVerdict(s.importBudget.emptyCost(), placed, s.sceneBudget.profileFor(renderer));
			return { decision, engine, settings: { triangleThreshold: settings.triangleThreshold, lodLevels: settings.lodLevels }, gate: verdict.gate, asking: verdict.asking.map((/** @type {any} */ a) => a.key), placed };
		},
		{ e: { ...e, path: f.path } }
	);
	const c = r.cost;
	h.check(c.triangles === e.cost.triangles, `${tag}: triangles as the bench measured (${c.triangles} vs ${e.cost.triangles})`);
	h.check(c.draws === e.cost.draws && c.meshes === e.cost.meshes, `${tag}: draw calls as the bench measured (${c.draws} vs ${e.cost.draws})`);
	// when the import engine rewrote the file (46 P2) it welds vertices and drops duplicate images, so
	// the placed model may only be LIGHTER than the file on those two axes
	const same = (/** @type {number} */ app, /** @type {number} */ bench) => (p.engine ? app <= bench : app === bench);
	h.check(same(c.maxMeshVertices, e.cost.maxMeshVertices), `${tag}: largest mesh as the bench measured (${c.maxMeshVertices} vs ${e.cost.maxMeshVertices} vertices${p.engine ? ', ≤ after the import engine' : ''})`);
	h.check(same(c.textures, e.cost.textures), `${tag}: textures as the bench measured (${c.textures} vs ${e.cost.textures}${p.engine ? ', ≤ after the import engine' : ''})`);
	h.check(c.maxTextureSize === p.placed.maxTextureSize, `${tag}: largest placed texture ${c.maxTextureSize} px (bench ${e.cost.maxTextureSize} → ${p.placed.maxTextureSize} after the import resize)`);
	h.check(r.verdict?.gate === p.gate, `${tag}: the budget gate ${p.gate ? 'asked' : 'stayed quiet'} as importVerdict says for the bench's numbers (app ${r.verdict?.gate}: ${r.verdict?.asking.join(',') || '-'} · bench ${p.asking.join(',') || '-'})`);
	h.check(r.dialogs.includes('This model is heavy') === p.gate, `${tag}: the "heavy" dialog ${p.gate ? 'showed' : 'did not show'}`);

	// ---- 3. LOD --------------------------------------------------------------------------------
	const wantGroup = p.decision.optimize && p.decision.lod && !e.skinned;
	h.check(!!r.lod === wantGroup, `${tag}: LOD group ${wantGroup ? 'stamped' : 'not stamped'} (${e.cost.triangles} tris vs threshold ${p.settings.triangleThreshold}${e.skinned ? ', skinned' : ''})`);
	const countAuto = () => page.evaluate(
		({ uuid }) => {
			const s = window.__stores;
			s.lod.scanForLod();
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const root = g.getObjectByProperty('uuid', uuid);
			const mine = new Set();
			root?.traverse((/** @type {any} */ o) => o.isMesh && mine.add(o.uuid));
			return s.lod.lodStats().meshes.filter((/** @type {any} */ m) => mine.has(m.uuid)).length;
		},
		{ uuid: r.uuid }
	);
	const wantAuto = !wantGroup && !e.skinned && !e.morph && e.cost.maxMeshTriangles >= 3000;
	// a LOD GROUP claims its meshes from auto LOD once the group draws (lod.js scanForLod); until then
	// both may hold them — wait for the claim, and say how long the overlap lasted
	let auto = await countAuto();
	const t0 = Date.now();
	while (wantGroup && auto > 0 && Date.now() - t0 < 30000) {
		await page.waitForTimeout(1000);
		auto = await countAuto();
	}
	const overlap = wantGroup ? Math.round((Date.now() - t0) / 1000) : 0;
	h.check(wantAuto ? auto > 0 : auto === 0, `${tag}: auto LOD ${wantAuto ? 'takes' : 'leaves'} its meshes (${auto} registered, largest mesh ${e.cost.maxMeshTriangles} tris${overlap ? `; the group claimed them after ${overlap} s` : ''})`);
	row.lodOverlapS = overlap;
	row.autoLod = auto;

	// ---- 4. scene-lint's static budget on the saved scene ----------------------------------------
	const lintView = await page.evaluate(() => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('import-wild', { thumbnail: false });
		// the LINT VIEW: scene-lint reads a geometry's box and triangle count, never its vertices,
		// so each position array becomes its two box corners and each index array its length —
		// a 3M-triangle model is ~100 MB of JSON otherwise
		for (const entry of payload.objects ?? []) {
			for (const g of entry.geometries ?? []) {
				const pos = g.data?.attributes?.position;
				if (pos?.isInterleavedBufferAttribute) {
					// keep the INTERLEAVED shape (scene-lint must read it), shrunk to two vertices
					const ib = g.data.interleavedBuffers?.[pos.data];
					const raw = ib && g.data.arrayBuffers?.[ib.buffer];
					if (!raw) continue;
					const a = new Float32Array(Uint32Array.from(raw).buffer);
					const stride = ib.stride || 3;
					const lo = [Infinity, Infinity, Infinity];
					const hi = [-Infinity, -Infinity, -Infinity];
					for (let i = pos.offset || 0; i + 2 < a.length; i += stride)
						for (let k = 0; k < 3; k++) {
							lo[k] = Math.min(lo[k], a[i + k]);
							hi[k] = Math.max(hi[k], a[i + k]);
						}
					const two = new Float32Array(2 * stride);
					two.set(lo, pos.offset || 0);
					two.set(hi, stride + (pos.offset || 0));
					const count = g.data.index?.array?.length ?? Math.floor(a.length / stride);
					g.data = {
						attributes: { position: pos },
						interleavedBuffers: { [pos.data]: ib },
						arrayBuffers: { [ib.buffer]: Array.from(new Uint32Array(two.buffer)) },
						index: { array: { length: count } }
					};
					continue;
				}
				if (!pos?.array?.length) continue;
				const a = pos.array;
				const n = pos.itemSize || 3;
				const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
				for (let i = 0; i + 2 < a.length; i += n)
					for (let k = 0; k < 3; k++) {
						box[k] = Math.min(box[k], a[i + k]);
						box[k + 3] = Math.max(box[k + 3], a[i + k]);
					}
				const count = g.data.index?.array?.length ?? a.length / n;
				g.data = { attributes: { position: { itemSize: 3, array: box } }, index: { array: { length: count } } };
			}
			delete entry.images;
			delete entry.textures;
		}
		return JSON.stringify({ objects: payload.objects, animated: (payload.animated ?? []).length, environment: payload.environment });
	});
	const session = JSON.parse(lintView);
	const budget = lintSession(session).filter((x) => x.rule === 'budget-static');
	const inObjects = !r.animated;
	const wantWarn = inObjects && e.cost.meshes > 150;
	const wantInfo = inObjects && e.cost.triangles > 300000;
	h.check(budget.some((x) => x.severity === 'warn') === wantWarn, `${tag}: scene-lint ${wantWarn ? 'warns' : 'does not warn'} about draw calls (${e.cost.meshes} meshes, budget 150${r.animated ? '; animated, saved as bytes' : ''})`);
	h.check(budget.some((x) => x.severity === 'info') === wantInfo, `${tag}: scene-lint ${wantInfo ? 'notes' : 'does not note'} the triangle budget (${e.cost.triangles} tris, budget 300k)`);

	// ---- 5. export round trip keeps the look -----------------------------------------------------
	const tripMax = Number(process.env.WILD_ROUNDTRIP_MAX_MB ?? 40) * 1e6;
	if (process.env.WILD_NO_ROUNDTRIP !== '1' && !r.animated && e.bytes > tripMax) console.log(`  (round trip skipped: ${(e.bytes / 1e6).toFixed(0)} MB > WILD_ROUNDTRIP_MAX_MB)`);
	if (process.env.WILD_NO_ROUNDTRIP !== '1' && !r.animated && e.bytes <= tripMax) {
		await frameObject(page, r.uuid);
		const before = await shot(page);
		const trip = await page.evaluate(
			async ({ uuid, name }) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((x) => (g = x))();
				const root = g.getObjectByProperty('uuid', uuid);
				const t0 = performance.now();
				const raw = await s.fileHandler.gltfBytesFor([root], { binary: true });
				if (!raw) return { error: 'gltfBytesFor gave nothing' };
				const { bytes: out, report } = await s.gltfOptimize.optimizeGltf(new Uint8Array(raw), s.gltfOptimize.EXPORT_PRESETS.quest.options);
				const exportMs = performance.now() - t0;
				root.visible = false;
				const back = await s.fileHandler.importFile(new File([out], 'roundtrip-' + name.replace(/\.\w+$/, '') + '.glb'), 'roundtrip', undefined, undefined, undefined, { noOptimize: true });
				const twin = back ? g.getObjectByProperty('uuid', back) : null;
				if (twin) {
					twin.position.copy(root.position);
					twin.quaternion.copy(root.quaternion);
					twin.scale.copy(root.scale);
				}
				await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
				return { back, exportMs: Math.round(exportMs), rawBytes: raw.byteLength, outBytes: out.byteLength, tris: twin ? s.importBudget.modelCost(twin).triangles : 0, report: report ? { ms: report.ms } : null };
			},
			{ uuid: r.uuid, name }
		);
		h.check(!trip.error && !!trip.back, `${tag}: the Quest / web export re-imports (${trip.error ?? `${(trip.rawBytes / 1e6).toFixed(1)} MB → ${(trip.outBytes / 1e6).toFixed(1)} MB in ${trip.exportMs} ms`})`);
		if (trip.back) {
			await page.waitForTimeout(1500); // KTX2 twins + LOD levels settle
			const after = await shot(page);
			const d = await h.frameDelta(page, before, after, LOOK_DELTA);
			if (process.env.SHOTS_DIR) {
				fs.writeFileSync(path.join(process.env.SHOTS_DIR, `${f.id}-a.png`), before);
				fs.writeFileSync(path.join(process.env.SHOTS_DIR, `${f.id}-b.png`), after);
			}
			row.lookDiff = d.fraction;
			row.exportMB = +(trip.outBytes / 1e6).toFixed(2);
			h.check(d.fraction <= LOOK_FRACTION, `${tag}: the round trip keeps the look (${(d.fraction * 100).toFixed(2)}% pixels off by > ${LOOK_DELTA}, limit ${LOOK_FRACTION * 100}%)`);
			h.check(trip.tris >= e.cost.triangles * 0.98, `${tag}: the round trip keeps the triangles (${trip.tris} of ${e.cost.triangles})`);
		}
		await page.evaluate(({ uuid }) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			for (const c of [...g.children]) if (c.uuid !== uuid) g.remove(c);
			const root = g.getObjectByProperty('uuid', uuid);
			if (root) root.visible = true;
		}, { uuid: r.uuid });
	}

	// ---- 6. modelSanity on the file alone (a replace by itself) ----------------------------------
	const sane = await page.evaluate(
		async ({ uuid, name }) => {
			const s = window.__stores;
			/** @type {any} */
			const w = window;
			w.__wild.dialogs = [];
			const out = await s.modelReplace.replaceModelFromFile(uuid, new File([w.__wildFiles.a], name), { fixes: 'ask', source: 'menu' });
			return { ok: !!out, issues: (out?.issues ?? []).map((/** @type {any} */ i) => i.kind), dialog: w.__wild.dialogs.some((/** @type {any} */ d) => d.id === 'replace-model-sanity') };
		},
		{ uuid: r.uuid, name }
	);
	const want = [...e.fileIssues].sort().join(',');
	h.check(sane.ok && sane.issues.sort().join(',') === want, `${tag}: modelSanity flags what the file carries (${sane.issues.join(',') || 'nothing'} · bench ${want || 'nothing'})`);
	h.check(sane.dialog === e.fileIssues.length > 0, `${tag}: the sanity dialog ${e.fileIssues.length ? 'asked' : 'stayed away'}`);
	row.sanity = sane.issues.join(',');
	await cleanup(page);
}

/**
 * The viewport for the look comparison: no toasts, nothing selected (an import selects what it placed,
 * and the gizmo would be in one frame only), rendering resumed (the overload guard pauses a heavy scene
 * on its own — a paused frame is not the model's look; whether it fired is recorded), then the canvas.
 * @param {any} page
 */
async function shot(page) {
	const paused = await page.evaluate(() => {
		const s = window.__stores;
		let p;
		s.overloadGuard.renderPaused.subscribe((v) => (p = v))();
		if (p) s.overloadGuard.resumeRendering();
		s.selectedObjects.set([]);
		s.selectedObject.set(null);
		if (!document.getElementById('wild-no-toasts')) {
			const st = document.createElement('style');
			st.id = 'wild-no-toasts';
			st.textContent = '.toasts-stack { visibility: hidden !important; }';
			document.head.appendChild(st);
		}
		return p?.reason ?? null;
	});
	if (paused) console.log(`  (the overload guard had paused rendering: ${paused})`);
	await page.waitForTimeout(800);
	return h.grabFrame({ page });
}

/** the camera on the object's box, three quarters from the front @param {any} page @param {string} uuid */
async function frameObject(page, uuid) {
	await page.evaluate(
		({ uuid }) => {
			const s = window.__stores;
			const get = (/** @type {any} */ store) => {
				let v;
				store.subscribe((/** @type {any} */ x) => (v = x))();
				return v;
			};
			const g = get(s.objectsGroup);
			const cam = get(s.globalCamera);
			const orbit = get(s.orbitControls);
			const root = g.getObjectByProperty('uuid', uuid);
			s.selectedObjects.set([]);
			s.selectedObject.set(null);
			// the world box from the meshes' own bounding boxes (no THREE import in a page function)
			const min = [Infinity, Infinity, Infinity];
			const max = [-Infinity, -Infinity, -Infinity];
			root.updateWorldMatrix(true, true);
			root.traverse((/** @type {any} */ o) => {
				if (!o.isMesh || !o.geometry) return;
				if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
				const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
				for (let i = 0; i < 3; i++) {
					min[i] = Math.min(min[i], b.min.getComponent(i));
					max[i] = Math.max(max[i], b.max.getComponent(i));
				}
			});
			const c = min.map((v, i) => (v + max[i]) / 2);
			const r = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
			const dist = r / Math.sin(((cam.fov ?? 50) * Math.PI) / 360) * 1.1;
			cam.near = dist / 200;
			cam.far = dist * 200;
			cam.position.set(c[0] + dist * 0.55, c[1] + dist * 0.35, c[2] + dist * 0.76);
			cam.updateProjectionMatrix();
			if (orbit) {
				orbit.target.set(c[0], c[1], c[2]);
				orbit.update();
			} else cam.lookAt(c[0], c[1], c[2]);
		},
		{ uuid }
	);
	await page.waitForTimeout(1200);
}

/** @param {any} page */
async function cleanup(page) {
	await page.evaluate(() => window.__stores.commandsHandler.clearSceneLocal());
	await page.waitForTimeout(300);
}

/** Replace generator A's model by generator B's (same input): identity kept, sanity as predicted.
 * @param {any} page @param {any} p */
async function onePair(page, p) {
	const name = (/** @type {any} */ side) => (side.model + '.glb').replace(/[^\w.-]/g, '_');
	await deliver(page, locate, p.a.path, 'a');
	await deliver(page, locate, p.b.path, 'b');
	const out = await page.evaluate(
		async ({ na, nb }) => {
			const s = window.__stores;
			/** @type {any} */
			const w = window;
			s.commandsHandler.clearSceneLocal();
			w.__wild.dialogs = [];
			const uuid = await s.fileHandler.importFile(new File([w.__wildFiles.a], na), 'Wild A');
			if (!uuid) return { error: 'A did not import' };
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const o = g.getObjectByProperty('uuid', uuid);
			o.position.set(1.5, 0, -2);
			o.rotation.set(0, 0.4, 0);
			o.updateMatrix();
			o.userData.physics = { mode: 'dynamic', mass: 3 };
			s.flowGraphsCtl.createObjectGraph(uuid);
			s.nodesHandler.createFlowNode({ id: 'w-click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } }, uuid);
			s.nodesHandler.createFlowNode({ id: 'w-vis', type: 'visibility', position: { x: 220, y: 0 }, data: { type: 'visibility' } }, uuid);
			s.nodesHandler.createFlowEdge({ id: 'e-w', source: 'w-click', target: 'w-vis', targetHandle: 'trigger' }, uuid);
			const depth = () => new Promise((r) => s.history.undoStack.subscribe((/** @type {any} */ st) => r(st.length))());
			const d0 = await depth();
			const pose = () => [o.position.toArray(), o.rotation.toArray().slice(0, 3)].flat().map((v) => +Number(v).toFixed(4)).join(',');
			const before = pose();
			w.__wild.dialogs = [];
			const res = await s.modelReplace.replaceModelFromFile(uuid, new File([w.__wildFiles.b], nb), { fixes: 'ask', source: 'menu' });
			const live = g.getObjectByProperty('uuid', uuid);
			let graphs;
			s.flowGraphs.subscribe((x) => (graphs = x))();
			return {
				ok: !!res,
				issues: (res?.issues ?? []).map((/** @type {any} */ i) => i.kind).sort(),
				dialog: w.__wild.dialogs.find((/** @type {any} */ d) => d.id === 'replace-model-sanity')?.items ?? null,
				same: !!live && live.name === 'Wild A',
				pose: live ? [live.position.toArray(), live.rotation.toArray().slice(0, 3)].flat().map((v) => +Number(v).toFixed(4)).join(',') === before : false,
				physics: live?.userData?.physics?.mass === 3,
				graph: (graphs?.[uuid]?.nodes ?? []).map((/** @type {any} */ n) => n.type).sort().join(','),
				undo: (await depth()) - d0
			};
		},
		{ na: name(p.a), nb: name(p.b) }
	);
	const tag = `${p.why} (${p.a.family} → ${p.b.family})`;
	h.check(!out.error && out.ok, `${tag}: replaced${out.error ? ' — ' + out.error : ''}`);
	if (out.error) return;
	h.check(out.same && out.pose, `${tag}: the object keeps its uuid, name and pose`);
	h.check(out.physics, `${tag}: physics kept`);
	h.check(out.graph === 'onclick,visibility', `${tag}: the flow wiring kept (${out.graph})`);
	h.check(out.undo === 1, `${tag}: ONE undo step (${out.undo})`);
	const want = [...p.expectIssues].sort().join(',');
	h.check(out.issues.join(',') === want, `${tag}: modelSanity flags ${want || 'nothing'} as its rule gives for the measured boxes (${out.issues.join(',') || 'nothing'})`);
	h.check(!!out.dialog === p.expectIssues.length > 0, `${tag}: the sanity dialog ${p.expectIssues.length ? 'asked' + (out.dialog ? ': ' + out.dialog.join(' | ').slice(0, 160) : '') : 'stayed away'}`);
	await cleanup(page);
}
