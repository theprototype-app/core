// 34 B2 — the IN-PAGE half of the perf probes, shared by scripts/perf-games.cjs (the seven games)
// and scripts/perf-levels.cjs (the General-tab levels), so a game and a level are counted the same
// way — moved here verbatim from perf-games.cjs (31-perf P0), plus the per-frame sums the budget
// gate reads (`--check`): a MEDIAN over the display frames that rendered, not a mean over every
// rAF tick, because on a GPU-less runner (SwiftShader, ~4 fps) a tick without a render would
// drag a mean down and make the same scene read lighter in CI than on a desk.
//
// Both functions are passed to page.evaluate, so they may use nothing from this file's scope.

/** In-page: start the recorder (render wrapper + rAF frame times). */
function startRecorder() {
	const s = window.__stores;
	let r;
	s.globalRenderer.subscribe((v) => (r = v))();
	// perFrame: [calls, triangles] summed over every render() of ONE display frame (34 B2)
	const rec = { calls: 0, triangles: 0, renders: 0, frames: [], last: 0, on: true, heap0: performance.memory?.usedJSHeapSize ?? null, perFrame: [], cur: [0, 0, 0] };
	const inner = r.render;
	r.render = function (...a) {
		const out = inner.apply(this, a);
		const i = this.info?.render;
		if (rec.on && i) {
			rec.calls += i.calls;
			rec.triangles += i.triangles;
			rec.renders++;
			rec.cur[0] += i.calls;
			rec.cur[1] += i.triangles;
			rec.cur[2]++;
		}
		return out;
	};
	const tick = (t) => {
		if (!rec.on) return;
		if (rec.cur[2]) rec.perFrame.push([rec.cur[0], rec.cur[1]]);
		rec.cur = [0, 0, 0];
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
	if (!rec) throw new Error('the recorder is gone (did the page reload?)');
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
		castLights = 0,
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
			if (o.castShadow) castLights++;
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
	// 33 G1: what a PHONE's GPU pays for — pixels per frame, and what shades them
	let physical = 0;
	let transparent = 0;
	scene?.traverseVisible?.((o) => {
		if (!o.isMesh) return;
		const mats = Array.isArray(o.material) ? o.material : [o.material];
		if (mats.some((m) => m?.isMeshPhysicalMaterial)) physical++;
		if (mats.some((m) => m?.transparent)) transparent++;
	});
	const buffer = r.getDrawingBufferSize(new s.THREE.Vector2());
	let bytes = 0;
	// 34 B2: ONE upload per image SOURCE — three shares the GL texture between Texture objects
	// that hold the same Source (every clone of a kit piece does), so counting Texture objects
	// read the Castle as 410 MB of what is a fraction of that on the GPU
	const sources = new Set();
	for (const t of textures) {
		const key = t.source ?? t.image;
		if (key && sources.has(key)) continue;
		if (key) sources.add(key);
		const img = t.image;
		const one = Array.isArray(img) ? img[0] : img;
		const w = one?.naturalWidth || one?.videoWidth || one?.width || 0;
		const h = one?.naturalHeight || one?.videoHeight || one?.height || 0;
		const faces = Array.isArray(img) ? img.length : 1;
		bytes += w * h * 4 * faces * (t.generateMipmaps === false ? 1 : 4 / 3);
	}
	let state = null;
	s.gameState?.gameState?.subscribe((v) => (state = v?.state ?? null))();
	// 31-perf: what LOD and the governor were doing (absent on a build without them)
	const lod = s.lod?.lodStats?.() ?? null;
	let quality = null;
	s.qualityGovernor?.qualityState?.subscribe((v) => (quality = v?.level ?? null))();
	// 34 B2: the median display frame that rendered (and the heaviest), what the gate reads
	const med = (k) => {
		const v = rec.perFrame.map((f) => f[k]).sort((a, b) => a - b);
		return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
	};
	return {
		frames: rec.frames.length,
		renderedFrames: rec.perFrame.length,
		medianCalls: med(0),
		maxCalls: rec.perFrame.length ? Math.max(...rec.perFrame.map((f) => f[0])) : null,
		medianTriangles: med(1),
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
		textureSources: sources.size,
		textureMB: Math.round((bytes / 1048576) * 10) / 10,
		programs: r.info.programs?.length ?? null,
		lights,
		castLights,
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
		pixelRatio: Math.round(r.getPixelRatio() * 100) / 100,
		bufferPx: Math.round((buffer.x * buffer.y) / 1000) / 1000,
		physical,
		transparent,
		heapMB: performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10 : null,
		heapDeltaMB: performance.memory && rec.heap0 != null ? Math.round(((performance.memory.usedJSHeapSize - rec.heap0) / 1048576) * 10) / 10 : null,
		lodMeshes: lod ? lod.entries : null,
		lodCoarse: lod ? lod.drawnCoarse : null,
		quality,
		state
	};
}

/**
 * 34 B2 (node side): wait until no LOD is still being made — 31-perf's auto levels are built in a
 * worker and 33's pack LOD files are fetched lazily after the first render, so until they land
 * the full-detail mesh is drawn. A GPU desk settles in well under a second; a runner may not, and
 * then it would count a different scene. Returns what was still pending at the timeout (0 = settled).
 * @param {any} page @param {number} [timeoutMs]
 */
async function settleLod(page, timeoutMs = 45000) {
	const t0 = Date.now();
	let pending = 0;
	while (Date.now() - t0 < timeoutMs) {
		pending = await page
			.evaluate(() => {
				const s = window.__stores;
				const auto = s.lod?.lodStats?.().meshes?.filter((m) => m.levels === null).length ?? 0;
				const groups = (s.lodGroup?.lodGroupStats?.() ?? []).reduce((n, g) => n + g.levels.filter((l) => l.status === 'loading').length, 0);
				return auto + groups;
			})
			.catch(() => 0);
		if (!pending) break;
		await page.waitForTimeout(250);
	}
	return pending;
}

/** 34 B2: wait for the scene to stop ARRIVING, so a slow runner counts the same scene a fast one
 * does: every kit piece refilled, the loader idle, and then the drawable content (meshes + vertices
 * under objectsGroup) unchanged for 1.5 s — the generic part catches what arrives on its own clock
 * (an `animRef` door fetches its GLB after packRefsSettled resolves: a SwiftShader run counted the
 * Tavern's spawn view 5 calls light before this) @param {any} page */
async function settleScene(page) {
	await page.evaluate(() => window.__stores.packRefs?.packRefsSettled?.()).catch(() => {});
	const t0 = Date.now();
	while (Date.now() - t0 < 60000) {
		const busy = await page.evaluate(() => !!window.__stores.sceneLoader?.loading?.()).catch(() => false);
		if (!busy) break;
		await page.waitForTimeout(250);
	}
	let last = '';
	let stableSince = Date.now();
	while (Date.now() - t0 < 90000) {
		const sig = await page
			.evaluate(() => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				let meshes = 0;
				let verts = 0;
				g?.traverse((o) => {
					if (o.isMesh) {
						meshes++;
						verts += o.geometry?.attributes?.position?.count ?? 0;
					}
				});
				return meshes + ':' + verts;
			})
			.catch(() => '');
		if (sig !== last) {
			last = sig;
			stableSince = Date.now();
		} else if (Date.now() - stableSince >= 1500) break;
		await page.waitForTimeout(300);
	}
	await page.waitForTimeout(500);
}

module.exports = { startRecorder, readScene, settleLod, settleScene };
