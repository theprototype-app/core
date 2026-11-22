// 106 S0 — the PAGE half of the shadow measurement (one source for every device: a Playwright page on the Deck
// or the PC evaluates it, the HONOR's raw CDP tab evaluates the same text). Defines window.__s0 = { load,
// inventory, measure }. Needs localStorage.debugStores = 'true' (window.__stores).
// Frame cost two ways: `raf` = intervals between drawn frames (the app's whole frame, post included; capped by
// vsync where the browser keeps it), `forced` = N back-to-back renderer.render(scene, camera) each closed by a
// 1-pixel readPixels, so the GPU work of the scene + its shadow passes is timed without vsync (post excluded).
(() => {
	const S = () => window.__stores;
	const read = (store) => {
		let v;
		store.subscribe((x) => (v = x))();
		return v;
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const q = (arr, p) => {
		if (!arr.length) return null;
		const s = [...arr].sort((a, b) => a - b);
		return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
	};

	async function settle(ms) {
		let last = -1;
		for (let i = 0; i < 40; i++) {
			let c = 0;
			read(S().objectsGroup)?.traverse(() => c++);
			if (c === last && c > 0) break;
			last = c;
			await sleep(1500);
		}
		await sleep(ms);
		return last;
	}

	async function load(slug) {
		const s = S();
		s.sceneSwitch?.modulesOnOpen?.set('keep');
		let ok = 'not tried';
		for (let i = 0; i < 3 && ok !== true; i++) {
			try {
				await s.sceneTemplates.loadTemplatesIndex(true);
				const list = read(s.sceneTemplates.templates);
				const e = list.find((x) => x.slug === slug);
				if (!e) ok = 'no template ' + slug;
				else {
					const r = await s.sceneTemplates.loadRemoteScene(e);
					ok = r === true ? true : 'ret=' + String(r);
				}
			} catch (err) {
				ok = 'threw ' + String(err && err.message);
			}
			if (ok !== true) {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
				await sleep(4000);
			}
		}
		const objects = await settle(4000);
		const cam = read(s.globalCamera);
		return { ok, objects, pose: { p: cam.position.toArray(), q: cam.quaternion.toArray() } };
	}

	function pin(pose) {
		const cam = read(S().globalCamera);
		cam.position.fromArray(pose.p);
		cam.quaternion.fromArray(pose.q);
		cam.updateMatrixWorld(true);
	}

	/** what the scene draws today: renderer shadow state + every light that casts */
	function inventory() {
		const s = S();
		const r = read(s.globalRenderer);
		const scene = read(s.globalScene);
		const lights = [];
		let meshes = 0, casters = 0, casterTris = 0, tris = 0;
		scene.traverse((o) => {
			if (o.isLight && o.castShadow && o.visible) {
				const sh = o.shadow;
				const c = sh && sh.camera;
				lights.push({
					type: o.isSunLight ? 'Sun(cascaded)' : o.type,
					name: o.name || '',
					map: sh ? sh.mapSize.x : null,
					radius: sh ? sh.radius : null,
					frustum: c && c.isOrthographicCamera ? +(c.right - c.left).toFixed(1) : c ? 'persp' : null,
					far: c ? +c.far.toFixed(1) : null,
					atlas: sh && sh.map ? [sh.map.width, sh.map.height] : null
				});
			}
			if (o.isMesh && o.visible) {
				meshes++;
				const g = o.geometry;
				const n = g ? (g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0) / 3 : 0;
				const inst = o.isInstancedMesh ? o.count : 1;
				tris += n * inst;
				if (o.castShadow) {
					casters++;
					casterTris += n * inst;
				}
			}
		});
		const gl = r.getContext();
		const dbg = gl.getExtension('WEBGL_debug_renderer_info');
		return {
			gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
			ua: navigator.userAgent,
			canvas: [r.domElement.width, r.domElement.height],
			dpr: r.getPixelRatio(),
			shadowMap: { enabled: r.shadowMap.enabled, type: r.shadowMap.type },
			quality: (() => {
				try {
					return { shadowPref: localStorage.getItem('shadowQuality'), preset: localStorage.getItem('qualityPreset') };
				} catch {
					return null;
				}
			})(),
			lights,
			meshes,
			casters,
			tris: Math.round(tris),
			casterTris: Math.round(casterTris)
		};
	}

	const rafSample = (ms) =>
		new Promise((resolve) => {
			const f = [];
			let last = 0;
			const end = performance.now() + ms;
			const tick = (t) => {
				if (last) f.push(t - last);
				last = t;
				if (t < end) requestAnimationFrame(tick);
				else resolve(f);
			};
			requestAnimationFrame(tick);
		});

	function forced(n) {
		const s = S();
		const r = read(s.globalRenderer);
		const scene = read(s.globalScene);
		const cam = read(s.globalCamera);
		const gl = r.getContext();
		const px = new Uint8Array(4);
		const prev = r.getRenderTarget();
		r.setRenderTarget(null);
		r.render(scene, cam);
		gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
		const info = { calls: r.info.render.calls, tris: r.info.render.triangles };
		const t = [];
		for (let i = 0; i < n; i++) {
			const t0 = performance.now();
			r.render(scene, cam);
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
			t.push(performance.now() - t0);
		}
		r.setRenderTarget(prev);
		return { n, median: q(t, 0.5), p95: q(t, 0.95), ...info };
	}

	/** one level: set it (scene data, the real path), wait for the lazy chunk + recompiles, then sample */
	async function measure(level, opts = {}) {
		const s = S();
		const sampleMs = opts.sampleMs ?? 6000;
		const env = s.environment;
		if (opts.tier !== undefined && env.setShadowTierOverride) env.setShadowTierOverride(opts.tier || null);
		env.setSceneShadowLevel(level);
		await sleep(opts.waitMs ?? 3500);
		if (opts.pose) pin(opts.pose);
		await sleep(800);
		const f = await rafSample(sampleMs);
		const fr = forced(opts.forcedN ?? 30);
		const dbg = s.shadowLevels ? s.shadowLevels.shadowLevelDebug() : null;
		const contact = s.lightParams.contactShadowsWanted ? read(s.lightParams.contactShadowsWanted) : null;
		return {
			level,
			drawn: env.drawnSceneShadowLevel(),
			raf: { n: f.length, median: q(f, 0.5), p95: q(f, 0.95), over20: f.filter((x) => x > 20).length, over34: f.filter((x) => x > 34).length },
			forced: fr,
			contact,
			lights: inventory().lights,
			debug: dbg
		};
	}

	window.__s0 = { load, pin, inventory, measure, settle };
	return true;
})();
