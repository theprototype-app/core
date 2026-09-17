// 26-E — THE SCENE-STRESS PROBE, shared by the manual rig and its regression suite.
//
// `scene-stress.cjs` is the measurement rig (a many-minute sweep, run by hand, like
// `net-stress.cjs`). `scene-stress.test.cjs` is the quick regression that proves the rig
// still measures what it says it measures. Both drive THIS file, so the suite covers the
// real measurement code rather than a copy of it that can drift.
//
// Everything that is timed is timed INSIDE the page. A CDP round trip is several
// milliseconds on this box, which is a third of a frame — a frame time measured across
// the bridge is a measurement of the bridge.
//
// Not a `.test.cjs`, so the runner never picks it up on its own.

/**
 * Nearest-rank percentile — the SAME rule `sceneBudget.frameStats` uses, so a number the
 * rig reports and a number the meter reports mean the same thing. PURE.
 * @param {number[]} sorted ascending @param {number} q 0..1
 */
function percentile(sorted, q) {
	if (!sorted.length) return null;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[index];
}

/** @param {number[]} values */
function summarize(values) {
	const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
	return {
		n: sorted.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		max: sorted.length ? sorted[sorted.length - 1] : null
	};
}

/**
 * Install `window.__stress` in the page. Idempotent. Returns the renderer string, so a
 * report can say what GPU its numbers came from (they are meaningless without it).
 * @param {any} page
 */
async function installProbe(page) {
	return page.evaluate(() => {
		/** @type {any} */
		const w = window;
		const s = w.__stores;
		/** @param {any} store */
		const read = (store) => {
			let v;
			store.subscribe((/** @type {any} */ x) => (v = x))();
			return v;
		};
		/** @param {number} ms */
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

		if (!w.__stress) {
			/** @type {any} */
			const ns = (w.__stress = { tasks: [] });
			try {
				ns.observer = new PerformanceObserver((list) => {
					for (const e of list.getEntries()) ns.tasks.push({ at: e.startTime, ms: e.duration });
				});
				ns.observer.observe({ entryTypes: ['longtask'] });
				ns.longTasksAvailable = true;
			} catch {
				ns.longTasksAvailable = false;
			}

			/** Long tasks that STARTED inside [from, now]. */
			ns.tasksSince = (/** @type {number} */ from) => {
				const hit = ns.tasks.filter((/** @type {any} */ t) => t.at >= from);
				return {
					count: hit.length,
					longest: hit.reduce((m, /** @type {any} */ t) => Math.max(m, t.ms), 0),
					busy: hit.reduce((m, /** @type {any} */ t) => m + t.ms, 0)
				};
			};

			/** Frame deltas for `ms`, optionally doing `each(dt)` every frame. */
			ns.frames = async (/** @type {number} */ ms, /** @type {any} */ each) => {
				/** @type {number[]} */
				const deltas = [];
				const started = performance.now();
				let last = await nextFrame();
				while (performance.now() - started < ms) {
					const now = /** @type {number} */ (await nextFrame());
					deltas.push(now - last);
					if (each) each(now - last);
					last = now;
				}
				return { deltas, tasks: ns.tasksSince(started), elapsed: performance.now() - started };
			};

			ns.renderer = () => {
				const r = read(s.globalRenderer);
				try {
					const gl = r.getContext();
					const dbg = gl.getExtension('WEBGL_debug_renderer_info');
					return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
				} catch {
					return 'unknown';
				}
			};

			ns.count = () => read(s.objectsGroup)?.children?.length ?? 0;

			/**
			 * Seed `n` boxes through the REAL create command (history, palette colour,
			 * shadow defaults, the poke) laid out on a square grid so every one is in
			 * frame. In chunks, yielding between them, because the thing being measured
			 * is the scene afterwards — not how badly a 10,000-iteration loop blocks.
			 */
			ns.seedCubes = async (/** @type {number} */ n, /** @type {number} */ chunk = 250) => {
				const started = performance.now();
				const side = Math.ceil(Math.sqrt(n));
				const gap = 1.6;
				const base = ns.count();
				for (let i = 0; i < n; i++) {
					s.commandsHandler.sceneCommand('/create box');
					const o = read(s.selectedObject);
					if (o?.position) o.position.set((i % side) * gap - (side * gap) / 2, 0.5, Math.floor(i / side) * gap - (side * gap) / 2);
					if (i % chunk === chunk - 1) await sleep(0);
				}
				// the creations are synchronous, but the palette/shadow sweeps ride pokes
				for (let t = 0; t < 200 && ns.count() < base + n; t++) await sleep(50);
				s.selectedObjects?.set?.([]);
				s.flushScenePokes?.();
				await nextFrame();
				return { ms: performance.now() - started, tasks: ns.tasksSince(started), count: ns.count() - base };
			};

			/** Point the editor camera at the whole grid, from above and to one side. */
			ns.frameAll = (/** @type {number} */ n) => {
				const side = Math.ceil(Math.sqrt(Math.max(1, n))) * 1.6;
				const cam = read(s.globalCamera);
				const controls = read(s.orbitControls);
				const d = Math.max(12, side * 0.9);
				cam.position.set(d * 0.6, d * 0.7, d * 0.8);
				cam.far = Math.max(cam.far, d * 6);
				cam.updateProjectionMatrix();
				controls?.target?.set?.(0, 0, 0);
				controls?.update?.();
			};

			/** A continuous orbit: what "the scene is heavy" feels like while navigating. */
			ns.orbit = (/** @type {number} */ ms) => {
				const controls = read(s.orbitControls);
				return ns.frames(ms, () => {
					if (controls?._rotateLeft) controls._rotateLeft(0.02);
					else if (controls?.rotateLeft) controls.rotateLeft(0.02);
					controls?.update?.();
				});
			};

			/** The budget sampler's own reading, after it has seen at least one window. */
			ns.metrics = async () => {
				await sleep(600);
				return s.sceneBudget.sampleSceneMetrics();
			};

			/** One autosave snapshot through the real writer. */
			ns.autosave = async () => {
				const started = performance.now();
				await s.autosave.saveNow();
				const status = read(s.autosave.autosaveStatus);
				return {
					wallMs: performance.now() - started,
					exportMs: status.lastExportMs,
					bytes: status.lastBytes,
					error: status.lastError,
					tasks: ns.tasksSince(started)
				};
			};

			/**
			 * Object list: close it, reopen it, and time until rows are in the DOM plus
			 * one painted frame. Above 500 rows 26-B windows the list, so the row count is
			 * reported too — a small count at 10k is the virtualisation working.
			 */
			ns.listRender = async () => {
				s.objectListClose.set(true);
				for (let t = 0; t < 40 && document.querySelector('#object-tree [role="treeitem"]'); t++) await sleep(25);
				await nextFrame();
				const started = performance.now();
				s.objectListClose.set(false);
				let rows = 0;
				for (let t = 0; t < 400; t++) {
					rows = document.querySelectorAll('#object-tree [role="treeitem"]').length;
					if (rows > 0) break;
					await new Promise((r) => setTimeout(r, 0));
				}
				await nextFrame();
				return { ms: performance.now() - started, rows, mode: document.querySelector('[data-object-rows]')?.getAttribute('data-object-rows') ?? null };
			};

			/**
			 * Import a dense model through the real GLB import path: a UV sphere of about
			 * `tris` triangles, exported to binary glTF in the page, handed to
			 * `fileHandler.importFile`. Timed until the object is in the scene.
			 */
			ns.importDense = async (/** @type {number} */ tris) => {
				const THREE = s.THREE;
				const Exporter = s.GLTFExporterModule.GLTFExporter;
				// a UV sphere of w x h segments has about 2*w*(h-1) triangles
				const h = Math.max(4, Math.round(Math.sqrt(tris / 2)));
				const wSeg = Math.max(4, Math.round(tris / (2 * (h - 1))));
				const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, wSeg, h), new THREE.MeshStandardMaterial({ color: 0x8899aa }));
				mesh.name = 'dense';
				const glb = await new Promise((resolve, reject) =>
					new Exporter().parse(mesh, resolve, reject, { binary: true })
				);
				mesh.geometry.dispose();
				const file = new File([/** @type {any} */ (glb)], 'dense.glb', { type: 'model/gltf-binary' });
				const before = ns.count();
				const started = performance.now();
				await s.fileHandler.importFile(file, 'dense', 'glb', [ (before % 6) * 2.5 - 6, 1, Math.floor(before / 6) * 2.5 - 6 ]);
				for (let t = 0; t < 600 && ns.count() <= before; t++) await sleep(20);
				s.selectedObjects?.set?.([]);
				return { ms: performance.now() - started, bytes: /** @type {any} */ (glb).byteLength, landed: ns.count() > before, tasks: ns.tasksSince(started) };
			};

			/** Run the simulation over what is in the scene for `ms`. */
			ns.physics = async (/** @type {number} */ ms) => {
				const physics = s.physics;
				if (!read(physics.simulating)) await physics.toggleSimulation();
				for (let t = 0; t < 100 && !read(physics.simulating); t++) await sleep(50);
				const startedOk = !!read(physics.simulating);
				await sleep(400); // the first steps build the world
				const run = await ns.frames(ms);
				const step = physics.physicsStepStats?.() ?? null;
				const metrics = s.sceneBudget.sampleSceneMetrics();
				const stillRunning = !!read(physics.simulating);
				if (stillRunning) physics.stopSimulation();
				return { startedOk, stillRunning, step, bodies: metrics.bodies ?? null, run };
			};
		}
		return w.__stress.renderer();
	});
}

/**
 * The per-size measurement, on a FRESH page so one size's heap and GPU state never
 * colours the next. Returns one report row. Every field is a number or null; nothing is
 * a string that a table would have to parse.
 * @param {any} h helpers.cjs
 * @param {any} browser
 * @param {{kind: 'cubes'|'dense', size: number, windowMs?: number, physics?: boolean, autosave?: boolean, denseTris?: number, storage?: Record<string,string>, viewport?: {width: number, height: number}}} opts
 */
async function measureScene(h, browser, opts) {
	const windowMs = opts.windowMs ?? 4000;
	const peer = await h.setupPage(browser, opts.kind + '-' + opts.size, {
		context: { viewport: opts.viewport ?? { width: 1280, height: 720 } },
		storage: opts.storage
	});
	try {
		const gpu = await installProbe(peer.page);
		/** @type {any} */
		const row = { kind: opts.kind, size: opts.size, gpu };
		const emptyIdle = await peer.page.evaluate((ms) => window.__stress.frames(ms), Math.min(2000, windowMs));
		row.emptyFrame = summarize(emptyIdle.deltas);

		if (opts.kind === 'cubes') {
			const seed = await peer.page.evaluate((n) => window.__stress.seedCubes(n), opts.size);
			row.seedMs = Math.round(seed.ms);
			row.seedLongTasks = seed.tasks.count;
			row.seedLongestTask = Math.round(seed.tasks.longest);
			row.objects = seed.count;
			await peer.page.evaluate((n) => window.__stress.frameAll(n), opts.size);
		} else {
			const tris = opts.denseTris ?? 200000;
			/** @type {number[]} */
			const imports = [];
			let bytes = 0;
			let landed = 0;
			let longest = 0;
			for (let i = 0; i < opts.size; i++) {
				const one = await peer.page.evaluate((t) => window.__stress.importDense(t), tris);
				imports.push(one.ms);
				bytes = one.bytes;
				if (one.landed) landed++;
				longest = Math.max(longest, one.tasks.longest);
			}
			row.importMsP50 = Math.round(summarize(imports).p50 ?? 0);
			row.importMsMax = Math.round(summarize(imports).max ?? 0);
			row.importLongestTask = Math.round(longest);
			row.glbBytes = bytes;
			row.objects = landed;
			await peer.page.evaluate(() => window.__stress.frameAll(36));
		}
		await peer.page.waitForTimeout(1200);

		const idle = await peer.page.evaluate((ms) => window.__stress.frames(ms), windowMs);
		row.idle = summarize(idle.deltas);
		row.idleLongTasks = idle.tasks.count;
		const orbit = await peer.page.evaluate((ms) => window.__stress.orbit(ms), windowMs);
		row.orbit = summarize(orbit.deltas);
		row.orbitLongTasks = orbit.tasks.count;
		row.orbitLongestTask = Math.round(orbit.tasks.longest);

		const m = await peer.page.evaluate(() => window.__stress.metrics());
		row.triangles = m.triangles;
		row.calls = m.calls;
		row.rendersPerFrame = m.rendersPerFrame ?? null;
		row.geometries = m.geometries;
		row.textures = m.textures;
		row.heapMB = m.heap ? Math.round(m.heap / 1048576) : null;
		row.meterP95 = m.frameP95;

		const list = await peer.page.evaluate(() => window.__stress.listRender());
		row.listMs = Math.round(list.ms);
		row.listRows = list.rows;
		row.listMode = list.mode;

		if (opts.autosave !== false) {
			const save = await peer.page.evaluate(() => window.__stress.autosave());
			row.autosaveExportMs = save.exportMs ? Math.round(save.exportMs) : null;
			row.autosaveWallMs = Math.round(save.wallMs);
			row.autosaveBytes = save.bytes || null;
			row.autosaveLongestTask = Math.round(save.tasks.longest);
			row.autosaveError = save.error || null;
		}

		if (opts.physics) {
			const run = await peer.page.evaluate((ms) => window.__stress.physics(ms), windowMs);
			row.physicsStarted = run.startedOk;
			row.physicsAutoStopped = run.startedOk && !run.stillRunning;
			row.bodies = run.bodies;
			row.stepP50 = run.step ? Math.round(run.step.p50 * 10) / 10 : null;
			row.stepP95 = run.step ? Math.round(run.step.p95 * 10) / 10 : null;
			row.physicsFrame = summarize(run.run.deltas);
		}
		row.pageErrors = h.pageErrors(peer).length;
		return row;
	} finally {
		await peer.ctx.close();
	}
}

module.exports = { percentile, summarize, installProbe, measureScene };
