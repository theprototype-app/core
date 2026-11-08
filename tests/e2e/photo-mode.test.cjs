// Roadmap 98 P2 (lane 98-photo) — PHOTO MODE end to end:
//   1  boot: the path tracer chunk is NOT loaded by the editor until a photo is asked for
//   2  a small product scene (PBR, glass, emissive, a Basic material, particles) → Render photo with N samples →
//      a PNG of the view's size with N samples, not blank; the person's camera did not move; the parity note names
//      what was left out (particles) and what was approximated (Basic)
//   2b 98-int: a pro look with an HDRI (Product shot, Cinematic): the PMREM environment used to crash the tracer
//      ("Converting circular structure to JSON (hdriTarget)") — now it renders lit by an unrolled equirect
//   2c 98-int P6: the tracer shader is linked by the async compile, never synchronously at the first draw
//   3  Stop: a long render stops at once and keeps the still so far (reason "stopped", ≥ 1 sample)
//   4  Download PNG (a real download, .png) and Save to scene shots (a Library file under Scene shots/)
//   5  phone profile, alone: "not on this device" + the best raster still
//   6  phone profile connected to the desktop: the PC renders the phone's view and sends the PNG back
// Run: e2e-slot --dev <tree> 6983 -- node tests/e2e/photo-mode.test.cjs
const h = require('./helpers.cjs');

const SAMPLES = 8;

/** the photo hook's state @param {any} page */
const state = (page) =>
	page.evaluate(async () => {
		const m = await window.__stores.photo.mode();
		/** @type {any} */ let s;
		m.photoState.subscribe((v) => (s = v))();
		/** @type {any} */ let open;
		window.__stores.photo.photoOpen.subscribe((v) => (open = v))();
		return { open, status: s.status, place: s.place, why: s.why, samples: s.samples, reason: s.reason, error: s.error, width: s.width, height: s.height, notes: s.notes, saved: s.saved, type: s.blob?.type ?? null, size: s.blob?.size ?? 0 };
	});

/** the tracer module was fetched? (dev: a pre-bundled dep; build: a chunk naming WebGLPathTracer) @param {any} page */
const tracerLoaded = (page) => page.evaluate(async () => (await window.__stores.photo.render()).tracerLoaded());

/** how many distinct grey levels the still has (a blank frame has one or two) @param {any} page */
const stillVariety = (page) =>
	page.evaluate(async () => {
		const img = /** @type {HTMLImageElement|null} */ (document.querySelector('#photo-result'));
		if (!img) return 0;
		await img.decode().catch(() => {});
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 64;
		const ctx = c.getContext('2d');
		ctx.drawImage(img, 0, 0, 64, 64);
		const d = ctx.getImageData(0, 0, 64, 64).data;
		const seen = new Set();
		for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
		return seen.size;
	});

/** set the photo settings @param {any} page @param {any} p */
const prefs = (page, p) => page.evaluate((x) => window.__stores.photo.photoPrefs.update((v) => ({ ...v, ...x })), p);

/** the editor camera's pose @param {any} page */
const camPose = (page) =>
	page.evaluate(() => {
		/** @type {any} */ let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		return c ? [...c.position.toArray(), ...c.quaternion.toArray()].map((n) => Math.round(n * 1e4) / 1e4) : null;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS ?? [] });
	const A = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1280, height: 800 } } });

	// ---- 1. boot: no tracer
	h.check(!(await tracerLoaded(A.page)), '1 boot: the path tracer chunk is not loaded by the editor');

	// ---- 2c (runs FIRST: a later photo reuses the cached program and links nothing — the premise below).
	// 98-int P6 (device-lab PC profile: ONE 19.3 s getProgramInfoLog block at the first draw). The tracer's
	// shader must be linked by renderer.compile (async, KHR_parallel_shader_compile), never at draw time: three keys a
	// program by the target bound when it is built, so a compile with the canvas bound built the canvas variant and the
	// first draw into the float target linked a SECOND one synchronously. Counted on any GPU (the variant mismatch is
	// not Windows-only; only the 19 s is).
	{
		const r = await A.page.evaluate(async () => {
			const s = window.__stores;
			/** @type {any} */ let rr;
			s.globalRenderer.subscribe((v) => (rr = v))();
			const gl = rr.getContext();
			/** @type {{inCompile: boolean, toneMapped: boolean}[]} */
			const links = [];
			let inCompile = 0;
			const link = gl.linkProgram;
			gl.linkProgram = function (/** @type {any} */ p) {
				const src = (gl.getAttachedShaders(p) || []).map((/** @type {any} */ x) => gl.getShaderSource(x) || '').join('\n');
				if (/uniform BVH bvh/.test(src)) links.push({ inCompile: inCompile > 0, toneMapped: /#define TONE_MAPPING/.test(src) });
				return link.call(this, p);
			};
			const compile = rr.compile;
			rr.compile = function (/** @type {any[]} */ ...a) {
				inCompile++;
				try {
					return compile.apply(this, a);
				} finally {
					inCompile--;
				}
			};
			try {
				// a scene the earlier renders did not see (a fresh define set), so the tracer has to build a program now
				const { THREE } = s;
				/** @type {any} */ let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.4, 0.12, 64, 8), new THREE.MeshPhysicalMaterial({ color: '#3a7', transmission: 0.5, roughness: 0.2 }));
				knot.name = 'P6 knot';
				g.add(knot);
				const out = await (await s.photo.render()).renderPhoto({ samples: 2, seconds: 60, width: 96, height: 64, denoise: false });
				g.remove(knot);
				return { ok: true, samples: out.samples, links };
			} catch (e) {
				return { ok: false, error: String(/** @type {any} */ (e)?.message ?? e), links };
			} finally {
				gl.linkProgram = link;
				rr.compile = compile;
			}
		});
		const atDraw = r.links.filter((l) => !l.inCompile);
		h.check(r.ok && r.links.length > 0, `2c premise: the photo linked a path-tracer program (${JSON.stringify(r)})`);
		h.check(r.ok && atDraw.length === 0, `2c P6: no path-tracer program is linked at draw time — every link is the async compile (${atDraw.length} at draw, ${r.links.length} in all)`);
		h.check(r.links.every((l) => !l.toneMapped), `2c P6: no canvas (tone-mapped) variant of the tracer shader is built (${r.links.filter((l) => l.toneMapped).length})`);
	}

	// ---- 2. a small product scene
	await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = await s.photo.three();
		const box = s.addObjects.spawnAtPoint('/create box', [-1.2, 0.5, 0]);
		const ball = s.addObjects.spawnAtPoint('/create sphere', [0, 0.5, 0]);
		const lamp = s.addObjects.spawnAtPoint('/create box', [1.2, 0.5, 0]);
		const flat = s.addObjects.spawnAtPoint('/create box', [0, 0.5, -1.5]);
		await new Promise((r) => setTimeout(r, 800));
		box.material = new THREE.MeshStandardMaterial({ color: '#c0392b', roughness: 0.4, metalness: 0.2 });
		ball.material = new THREE.MeshPhysicalMaterial({ color: '#ffffff', transmission: 1, roughness: 0.02, thickness: 0.5, ior: 1.5 });
		lamp.material = new THREE.MeshStandardMaterial({ color: '#111111', emissive: '#ffcc66', emissiveIntensity: 4 });
		flat.material = new THREE.MeshBasicMaterial({ color: '#2e86de' });
		const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 2, 0)]), new THREE.PointsMaterial({ size: 0.2 }));
		pts.name = 'photo-test-points';
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		g.add(pts);
		s.objectActions?.applySelectionSet?.([]);
	});
	await A.page.waitForTimeout(800);
	const poseBefore = await camPose(A.page);
	await prefs(A.page, { samples: SAMPLES, seconds: 120, denoise: true, scale: 0.5 });
	await A.page.evaluate(() => window.__stores.photo.open());
	await A.page.locator('#photo-dialog').waitFor({ state: 'visible', timeout: 30000 });
	await A.page.waitForFunction(() => document.querySelector('#photo-where')?.getAttribute('data-place') === 'here', null, { timeout: 30000 });
	h.check(true, '2 the Photo window opens and says it renders here (desktop)');
	await A.page.click('#photo-start');
	await A.page.locator('#photo-result').waitFor({ timeout: 180000 });
	const s2 = await state(A.page);
	const canvas = await A.page.evaluate(() => {
		/** @type {any} */ let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		return { w: r.domElement.width, h: r.domElement.height };
	});
	h.check(s2.status === 'done' && s2.type === 'image/png' && s2.size > 1000, `2 a PNG came back (${s2.status}, ${s2.type}, ${s2.size} bytes${s2.error ? ', ' + s2.error : ''})`);
	h.check(s2.samples >= SAMPLES && s2.reason === 'samples', `2 it holds ${SAMPLES} samples (${s2.samples}, stopped by ${s2.reason})`);
	h.check(Math.abs(s2.width - Math.round(canvas.w * 0.5)) <= 1 && Math.abs(s2.height - Math.round(canvas.h * 0.5)) <= 1, `2 half the view size (${s2.width}x${s2.height} for a ${canvas.w}x${canvas.h} view)`);
	const variety = await stillVariety(A.page);
	h.check(variety > 12, `2 the still is not blank (${variety} colour levels)`);
	h.check(JSON.stringify(await camPose(A.page)) === JSON.stringify(poseBefore), '2 the person\'s camera did not move');
	const kinds = (s2.notes ?? []).map((n) => n.kind);
	h.check(kinds.includes('points') && kinds.includes('basic'), `2 the parity note names particles (left out) and Basic (approximated): ${kinds.join(', ')}`);
	h.check(await tracerLoaded(A.page), '2 the tracer chunk loaded on demand');

	// ---- 2b. HDRI pro looks (98-int counterfactual: red on cadada36 with the circular-JSON error)
	for (const look of ['product', 'cinematic']) {
		const r = await A.page.evaluate(async (name) => {
			const s = window.__stores;
			await s.proPresets.applyProPreset(name);
			const { hdriStatus } = s.hdriStores;
			/** @type {any} */ let st;
			const t0 = Date.now();
			for (;;) {
				hdriStatus.subscribe((v) => (st = v))();
				// ready, and the bigger sky cube in too (it lands later and swaps the background: not our undo)
				if ((st.state === 'ready' && (!st.sky || st.skyWidth > 0)) || st.state === 'failed' || st.state === 'missing' || Date.now() - t0 > 60000) break;
				await new Promise((res) => setTimeout(res, 250));
			}
			/** @type {any} */ let scene;
			s.globalScene.subscribe((v) => (scene = v))();
			const before = { env: scene.environment, bg: scene.background };
			try {
				const out = await (await s.photo.render()).renderPhoto({ samples: 4, seconds: 60, width: 160, height: 100, denoise: false });
				const bmp = await createImageBitmap(out.blob);
				const c = document.createElement('canvas');
				c.width = 32;
				c.height = 20;
				const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
				ctx.drawImage(bmp, 0, 0, 32, 20);
				const d = ctx.getImageData(0, 0, 32, 20).data;
				let sum = 0;
				for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
				return { ok: true, hdri: st.state, env: out.env, mean: Math.round(sum / (d.length / 4) / 3), restored: scene.environment === before.env && (scene.background === before.bg || !scene.background?.isDataTexture) };
			} catch (e) {
				return { ok: false, hdri: st.state, error: String(/** @type {any} */ (e)?.message ?? e) };
			}
		}, look);
		h.check(r.ok && r.hdri === 'ready' && r.env === 'cubeuv', `2b ${look}: the HDRI look path-traces lit by its own sky (${JSON.stringify(r)})`);
		h.check(!!r.ok && r.mean > 8 && !!r.restored, `2b ${look}: not black (mean ${r.mean}) and the live sky is back after the render`);
	}

	// ---- 3. Stop
	await prefs(A.page, { samples: 2048, seconds: 600 });
	await A.page.click('#photo-start');
	// waitForFunction needs a SYNCHRONOUS predicate (a Promise is truthy): read a cached module
	await A.page.evaluate(async () => {
		/** @type {any} */ (window).__photoMode = await window.__stores.photo.mode();
	});
	await A.page.waitForFunction(
		() => {
			/** @type {any} */ let s;
			/** @type {any} */ (window).__photoMode.photoState.subscribe((v) => (s = v))();
			return s.status === 'rendering' && s.samples >= 1;
		},
		null,
		{ timeout: 120000, polling: 250 }
	);
	const t0 = Date.now();
	await A.page.click('#photo-stop');
	const stopped = await A.page
		.waitForFunction(
			() => {
				/** @type {any} */ let s;
				/** @type {any} */ (window).__photoMode.photoState.subscribe((v) => (s = v))();
				return s.status !== 'rendering';
			},
			null,
			{ timeout: 30000, polling: 250 }
		)
		.then(() => true, () => false);
	if (!stopped) console.log('INFO stop state', JSON.stringify(await state(A.page)), JSON.stringify(await A.page.evaluate(async () => (await window.__stores.photo.mode()).photoDebug())));
	const s3 = await state(A.page);
	h.check(s3.reason === 'stopped' && s3.samples >= 1 && s3.samples < 2048 && s3.type === 'image/png', `3 Stop keeps the still so far (${s3.status}, ${s3.reason}, ${s3.samples} samples, ${Date.now() - t0} ms, open ${s3.open}${s3.error ? ', ' + s3.error : ''})`);

	// ---- 4. Download + Save to scene shots
	const [dl] = await Promise.all([A.page.waitForEvent('download', { timeout: 30000 }), A.page.click('#photo-download')]);
	h.check(/^photo-.*\.png$/.test(dl.suggestedFilename()), `4 Download PNG: ${dl.suggestedFilename()}`);
	await A.page.click('#photo-save');
	await A.page.locator('#photo-saved').waitFor({ timeout: 30000 });
	const lib = await A.page.evaluate(() => {
		/** @type {any[]} */ let items = [];
		/** @type {any[]} */ let folders = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		window.__stores.explorer.explorerFolders.subscribe((v) => (folders = v))();
		const shots = folders.find((f) => f.name === 'Scene shots');
		const under = folders.filter((f) => f.parentId === shots?.id).map((f) => f.id);
		return items.filter((i) => under.includes(i.folderId) && /\.png$/.test(i.name)).map((i) => i.name);
	});
	h.check(lib.length >= 1, `4 Save to scene shots: a PNG in the Library under Scene shots/ (${lib.join(', ')})`);

	// ---- 5. phone profile, alone
	const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
	const B = await h.setupPage(browser, 'phone', { context: PHONE });
	await B.page.evaluate(() => window.__stores.photo.open());
	await B.page.waitForFunction(() => document.querySelector('#photo-where')?.getAttribute('data-place') === 'raster', null, { timeout: 30000 });
	const why = await B.page.locator('#photo-where').innerText();
	h.check(/Not on this device/.test(why), `5 phone alone: "${why.trim().slice(0, 90)}…"`);
	await B.page.click('#photo-start');
	await B.page.locator('#photo-result').waitFor({ timeout: 60000 });
	const s5 = await state(B.page);
	h.check(s5.place === 'raster' && s5.reason === 'raster' && s5.type === 'image/png', `5 phone alone: the best raster still instead (${s5.place}, ${s5.reason}, ${s5.type})`);
	h.check(!(await tracerLoaded(B.page)), '5 the phone never loaded the tracer');

	// ---- 6. phone + PC in one session: the PC renders it
	// the (non-modal) Photo windows sit over the header: close both before pressing Connect
	for (const P of [A, B]) await P.page.evaluate(() => window.__stores.photo.photoOpen.set(false));
	await A.page.waitForTimeout(300);
	await h.connect(A, B);
	await B.page.waitForFunction(
		() => {
			/** @type {any} */ let f;
			window.__stores.peerFacts?.peerFacts?.subscribe?.((v) => (f = v))();
			return !f || Object.values(f).some((x) => /** @type {any} */ (x)?.device === 'desktop');
		},
		null,
		{ timeout: 30000 }
	);
	await B.page.evaluate(() => window.__stores.photo.photoPrefs.update((v) => ({ ...v, samples: 4, seconds: 60, scale: 0.5 })));
	// re-open so the window re-checks where
	await B.page.evaluate(async () => (await window.__stores.photo.mode()).closePhoto());
	await B.page.evaluate(() => window.__stores.photo.open());
	await B.page.waitForFunction(() => document.querySelector('#photo-where')?.getAttribute('data-place') === 'peer', null, { timeout: 30000 });
	h.check(true, '6 phone + PC: the window says a computer in this session renders it');
	await B.page.click('#photo-start');
	await B.page.locator('#photo-result').waitFor({ timeout: 180000 });
	const s6 = await state(B.page);
	h.check(s6.status === 'done' && s6.reason === 'peer' && s6.samples >= 4 && s6.type === 'image/png', `6 the PC's PNG came back (${s6.status}, ${s6.reason}, ${s6.samples} samples${s6.error ? ', ' + s6.error : ''})`);
	h.check((await stillVariety(B.page)) > 12, '6 and it is not blank');
	const dbg = await A.page.evaluate(async () => (await window.__stores.photo.mode()).photoDebug());
	h.check(!dbg.answering, '6 the PC is free again');

	await h.finish(browser);
});
