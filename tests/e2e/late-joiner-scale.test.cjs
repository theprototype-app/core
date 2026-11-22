// fix-late-joiners — A LATE JOINER INTO A BIG SCENE, AND ITS TEMPLATES.
//
//   1. scale: the host holds a 500-object scene (plain meshes, textured meshes, groups, names with spaces)
//      plus TEMPLATES (a hidden original a Spawn node copies, a hidden "zone" box, an object whose only
//      mesh is invisible). B joins late over the real PeerJS path. Measured on B, from the approval:
//      the first host object, every host object, and main-thread long tasks while it lands.
//      Gates (brief row 1): every object within LJ_MAX_MS (5000) and no long task over LJ_LONGTASK_MS (200).
//      Brief row 2: every template reaches B (hidden, same name, same parent), and names keep their spaces.
//   2. reload: B reloads and joins again; the same objects, the templates too, no duplicates.
//
// CPU (default 4) throttles B's main thread for the measured join (the Deck is ~4x slower than the PC).
// LJ_COUNT (500) sets the scene size. The numbers print as `LJ-METRIC {...}` lines for the PR.
// Run (dev):   e2e-slot --dev <lane> 7204 -- env APP_URL=https://theprototype.app:7204/ node tests/e2e/late-joiner-scale.test.cjs
// Run (built): npm run build; LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' e2e-slot --dev <lane> 7204 -- env APP_URL=https://theprototype.app:7204/ node tests/e2e/late-joiner-scale.test.cjs
const h = require('./helpers.cjs');

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(String(row));
const COUNT = Number(process.env.LJ_COUNT || 500);
const CPU = Number(process.env.CPU || 4);
const MAX_MS = Number(process.env.LJ_MAX_MS || 5000);
const LONGTASK_MS = Number(process.env.LJ_LONGTASK_MS || 200);
// REPORT=1: print the numbers and never fail on the two timing gates (the base-tag measurement)
const REPORT = process.env.REPORT === '1';
// PROFILE=1: a CPU profile of B over the measured join, top self time by function
const PROFILE = process.env.PROFILE === '1';

/** the profile's top self-time functions @param {any} profile */
function printProfile(profile) {
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const self = new Map();
	const dt = profile.timeDeltas;
	for (let i = 0; i < profile.samples.length; i++) {
		const n = byId.get(profile.samples[i]);
		const f = n.callFrame;
		const key = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`;
		self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
	}
	const total = [...self.values()].reduce((a, b) => a + b, 0);
	console.log(`PROFILE total ${Math.round(total)} ms (throttled wall)`);
	for (const [k, ms] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(Math.round(ms)).padStart(6)} ms  ${k}`);
	// the same samples by 2 s window, each native call charged to its nearest app caller (who compiled, who read)
	const parent = new Map();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const appCaller = (id) => {
		const chain = [];
		for (let cur = id, d = 0; cur !== undefined && d < 40; cur = parent.get(cur), d++) {
			const f = byId.get(cur).callFrame;
			if (f.url) chain.push(`${f.functionName || '(anon)'}@${String(f.url).split('/').pop()}:${f.lineNumber + 1}`);
			if (chain.length >= 3) break;
		}
		return chain.join(' < ');
	};
	const windows = new Map();
	let t = 0;
	for (let i = 0; i < profile.samples.length; i++) {
		t += (dt[i] ?? 0) / 1000;
		const n = byId.get(profile.samples[i]);
		const name = n.callFrame.functionName || '(anon)';
		if (name === '(idle)' || name === '(program)' || name === '(garbage collector)') continue;
		const w = Math.floor(t / 2000) * 2;
		const key = `${name} [${appCaller(n.id)}]`;
		const m = windows.get(w) ?? new Map();
		m.set(key, (m.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
		windows.set(w, m);
	}
	for (const [w, m] of [...windows.entries()].sort((a, b) => a[0] - b[0])) {
		const busy = [...m.values()].reduce((a, b) => a + b, 0);
		console.log(`PROFILE ${w}-${w + 2} s: busy ${Math.round(busy)} ms`);
		for (const [k, ms] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`    ${String(Math.round(ms)).padStart(5)} ms  ${k.slice(0, 260)}`);
	}
}

// LJ_GPU=d3d12 (the pc host, WSL): the real GPU through Mesa's d3d12 driver (docs/pc-host.md ▸ The GPU). The plain
// GPU_ARGS there land on llvmpipe, a CPU rasteriser, whose shader compiles and context creation are the costliest
// part of a join and say nothing about a device's GPU. The CPU throttle stays: the Deck's CPU is the slow part.
const GPU_LAUNCH =
	process.env.LJ_GPU === 'd3d12' ? ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] : h.GPU_ARGS;
if (process.env.LJ_GPU === 'd3d12') process.env.GALLIUM_DRIVER = 'd3d12';

h.run(async () => {
	const browser = await h.launch({ args: GPU_LAUNCH });
	const A = await h.setupPage(browser, 'A');

	// ---- the host's scene ------------------------------------------------------------------------------
	const built = await A.page.evaluate(async (count) => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		const THREE = await s.THREE;
		let g;
		/** @type {any} */ (window).__stores.objectsGroup.subscribe((v) => (g = v))();
		const geos = [new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.SphereGeometry(0.3, 16, 12), new THREE.CylinderGeometry(0.2, 0.2, 0.6, 16)];
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 64;
		const c2 = canvas.getContext('2d');
		c2.fillStyle = '#c84'; c2.fillRect(0, 0, 64, 64); c2.fillStyle = '#333'; c2.fillRect(0, 0, 32, 32); c2.fillRect(32, 32, 32, 32);
		const tex = new THREE.CanvasTexture(canvas);
		let made = 0;
		const mesh = (i) => {
			const textured = i % 25 === 0;
			const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL((i * 0.137) % 1, 0.6, 0.5), ...(textured ? { map: tex } : {}) });
			const m = new THREE.Mesh(geos[i % 3].clone(), mat);
			m.name = (i % 3 === 0 ? 'Crate ' : i % 3 === 1 ? 'Ball ' : 'Post ') + i;
			m.position.set((i % 25) - 12, 0.3 + Math.floor(i / 625), Math.floor(i / 25) % 25 - 12);
			made++;
			return m;
		};
		// thirty made the way a person makes them (the create command), so the scene holds real app primitives
		const ch = await s.commandsHandler;
		const kinds = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule'];
		for (let k = 0; k < 30; k++) {
			ch.sceneCommand('/create ' + kinds[k % kinds.length]);
			made++;
		}
		await new Promise((r) => setTimeout(r, 500));
		for (const o of g.children.slice(-30)) o.name = 'Made ' + o.name;
		// groups of five (a tenth of the scene sits in groups), the rest at the root
		let i = 0;
		// the templates below are four more, so the scene holds exactly `count`
		while (made < count - 4) {
			if (i % 50 === 0 && made + 6 <= count - 4) {
				const grp = new THREE.Group();
				grp.name = 'Shelf ' + i;
				grp.position.set(0, 0, 14 + i / 50);
				for (let k = 0; k < 5; k++) { const m = mesh(i + k); m.position.set(k - 2, 0.3, 0); grp.add(m); }
				g.add(grp);
				made++;
				i += 5;
			} else {
				g.add(mesh(i++));
			}
		}
		// TEMPLATES — objects nobody sees while the scene runs
		const tmat = new THREE.MeshStandardMaterial({ color: 0xffcc00 });
		const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 24), tmat);
		coin.name = 'Coin template';
		coin.visible = false;
		coin.position.set(0, 5, -20);
		g.add(coin);
		const zone = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), new THREE.MeshStandardMaterial({ color: 0x00ff00, transparent: true, opacity: 0.2 }));
		zone.name = 'Gate zone';
		zone.visible = false;
		zone.position.set(8, 1, -18);
		g.add(zone);
		// a group whose only child is hidden (a prefab-style original parked out of sight)
		const orig = new THREE.Group();
		orig.name = 'Enemy original';
		orig.position.set(-8, 0, -18);
		const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), new THREE.MeshStandardMaterial({ color: 0xaa2222 }));
		body.name = 'Enemy body';
		body.visible = false;
		orig.add(body);
		g.add(orig);
		/** @type {any} */ (window).__stores.pokeScene?.();
		s.commandsHandler.pokeScene?.();
		// a Spawn node that copies the coin template (the scene graph)
		const spawnId = 'lj-spawn';
		const selId = 'lj-sel';
		const graph = {
			nodes: [
				{ id: selId, type: 'objectselector', position: { x: 0, y: 0 }, data: { selectedObjects: [coin.uuid], uuid: coin.uuid } },
				{ id: spawnId, type: 'spawn', position: { x: 300, y: 0 }, data: { count: 1, maxAlive: 32, interval: 0, spread: 0.5, x: 0, y: 3, z: 0 } }
			],
			edges: [{ id: 'lj-e1', source: selId, sourceHandle: 'out', target: spawnId, targetHandle: 'source' }]
		};
		const st = /** @type {any} */ (window).__stores;
		st.setActiveGraph?.('scene');
		st.flowGraphs.update((all) => ({ ...all, scene: graph }));
		st.flowNodes.set(graph.nodes);
		st.flowEdges.set(graph.edges);
		const all = [];
		g.traverse((o) => { if (o !== g) all.push({ uuid: o.uuid, name: o.name, visible: o.visible, parent: o.parent === g ? null : o.parent.uuid }); });
		// how many leaf meshes travel as their recipe (fix-late-joiners row 1; absent on a base build)
		let recipe = -1;
		let madeRecipe = -1;
		if (typeof ch.primitiveSyncable === 'function') {
			recipe = 0;
			g.traverse((o) => { if (o.isMesh && ch.primitiveSyncable(o)) recipe++; });
			madeRecipe = g.children.filter((o) => /^Made /.test(o.name) && ch.primitiveSyncable(o)).length;
		}
		return { all, templates: [coin.uuid, zone.uuid, orig.uuid, body.uuid], recipe, madeRecipe };
	}, COUNT);
	console.log(`host scene: ${built.all.length} objects (${built.templates.length} templates); as a recipe: ${built.recipe} meshes, ${built.madeRecipe} of the 30 made by /create`);
	h.check(built.all.length >= COUNT, `premise: the host holds ${COUNT}+ objects (${built.all.length})`);
	const hostByUuid = new Map(built.all.map((o) => [o.uuid, o]));

	/** B's view of the host's objects @param {any} page */
	const peerObjects = (page) =>
		page.evaluate(() => {
			let g;
			/** @type {any} */ (window).__stores.objectsGroup.subscribe((v) => (g = v))();
			const out = [];
			g.traverse((o) => { if (o !== g) out.push({ uuid: o.uuid, name: o.name, visible: o.visible, parent: o.parent === g ? null : o.parent.uuid }); });
			return out;
		});

	/** the join, measured on B from the approval click @param {any} B */
	const measuredJoin = async (B) => {
		const cdp = await B.page.context().newCDPSession(B.page);
		const uuids = built.all.map((o) => o.uuid);
		await B.page.evaluate((want) => {
			const w = /** @type {any} */ (window);
			const wanted = new Set(want);
			w.__lj = { on: false, t0: 0, conn: -1, first: -1, all: -1, longtasks: [], frames: 0, links: [] };
			// every shader program this page links while the scene lands (a compile is the costliest thing a join does)
			for (const C of [w.WebGL2RenderingContext, w.WebGLRenderingContext]) {
				if (!C || C.prototype.__ljWrapped) continue;
				const link = C.prototype.linkProgram;
				C.prototype.linkProgram = function (prog) {
					if (w.__lj?.on) w.__lj.links.push(Math.round(performance.now() - w.__lj.t0));
					return link.call(this, prog);
				};
				C.prototype.__ljWrapped = true;
			}
			new PerformanceObserver((l) => {
				if (w.__lj.on) for (const e of l.getEntries()) w.__lj.longtasks.push(Math.round(e.duration));
			}).observe({ type: 'longtask', buffered: false });
			const tick = () => {
				const r = w.__lj;
				if (r.on && r.all < 0) {
					r.frames++;
					let g;
					w.__stores.objectsGroup.subscribe((v) => (g = v))();
					let n = 0;
					g.traverse((o) => { if (wanted.has(o.uuid)) n++; });
					const t = Math.round(performance.now() - r.t0);
					if (r.conn < 0) {
						let p;
						w.__tp.test.v1.peers.subscribe((v) => (p = v))();
						if (Object.values(p?.connections ?? {}).some((c) => c?.open)) r.conn = t;
					}
					if (n > 0 && r.first < 0) r.first = t;
					if (n >= wanted.size) r.all = t;
					if (n !== r.have) (r.curve ??= []).push([t, n]);
					// the drain's own state: parked objects and the draw gap the governor set
					try {
						const v1 = w.__tp.test.v1;
						const backlog = v1.commandsHandler?.ingestBacklog?.() ?? -1;
						let gap = -1;
						v1.qualityGovernor?.ingestDrawGap?.subscribe?.((x) => (gap = x))();
						r.maxBacklog = Math.max(r.maxBacklog ?? 0, backlog);
						r.maxGap = Math.max(r.maxGap ?? 0, gap);
					} catch {}
					r.have = n;
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		}, uuids);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
		if (PROFILE) {
			await cdp.send('Profiler.enable');
			await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
			await cdp.send('Profiler.start');
		}
		await (await h.openDial(B.page)).fill(A.id);
		await B.page.getByRole('button', { name: 'Connect', exact: true }).click();
		await h.approveButton(A.page).waitFor({ timeout: 30000 });
		await B.page.evaluate(() => { const w = /** @type {any} */ (window); w.__lj.on = true; w.__lj.t0 = performance.now(); });
		await h.approveButton(A.page).click();
		const done = await h.eventually(
			() => B.page.evaluate(() => /** @type {any} */ (window).__lj),
			(r) => r.all >= 0,
			'B holds every host object',
			90000
		);
		if (PROFILE) printProfile((await cdp.send('Profiler.stop')).profile);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		const r = await B.page.evaluate(() => { const w = /** @type {any} */ (window); w.__lj.on = false; return w.__lj; });
		const metric = {
			objects: uuids.length,
			cpu: CPU,
			connMs: r.conn,
			firstMs: r.first,
			allMs: r.all,
			// what the brief gates: the apply, from the moment the joiner's link to the host is open
			applyMs: r.all >= 0 && r.conn >= 0 ? r.all - r.conn : -1,
			have: r.have,
			longtasks: r.longtasks.length,
			maxLongtaskMs: r.longtasks.length ? Math.max(...r.longtasks) : 0,
			over200: r.longtasks.filter((d) => d > 200).length,
			frames: r.frames,
			// programs linked during the join, and when (0.5 s buckets)
			// objects held at each second after the approval (the arrival curve)
			curve: (() => { const out = {}; for (const [t, n] of r.curve ?? []) out[Math.floor(t / 1000)] = n; return Object.entries(out).map(([k, v]) => k + 's:' + v).join(' '); })(),
			maxBacklog: r.maxBacklog ?? -1,
			maxDrawGap: r.maxGap ?? -1,
			programs: r.links.length,
			programBuckets: Object.entries(r.links.reduce((m, t) => ((m[Math.floor(t / 500) * 500] = (m[Math.floor(t / 500) * 500] ?? 0) + 1), m), {})).map(([k, v]) => k + ':' + v).join(' '),
			url: h.URL
		};
		console.log('LJ-METRIC ' + JSON.stringify(metric));
		// which programs B holds, and what tells its MeshStandardMaterial programs apart (the compile per object hunt)
		const programs = await B.page.evaluate(() => {
			let r;
			/** @type {any} */ (window).__tp.test.v1.globalRenderer.subscribe((v) => (r = v))();
			const list = r?.info?.programs ?? [];
			const names = {};
			for (const p of list) names[p.name] = (names[p.name] ?? 0) + 1;
			const std = list.filter((p) => p.name === 'MeshStandardMaterial').map((p) => String(p.cacheKey).split(','));
			const differs = {};
			for (const k of std.slice(1)) k.forEach((v, i) => { if (v !== std[0][i]) differs[i] = (differs[i] ?? new Set()).add(v); });
			const gl = r?.getContext?.();
			const dbg = gl?.getExtension?.('WEBGL_debug_renderer_info');
			const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter?.(gl.RENDERER);
			return { gpu: String(gpu).slice(0, 120), parallel: !!gl?.getExtension?.('KHR_parallel_shader_compile'), total: list.length, names, differs: Object.fromEntries(Object.entries(differs).slice(0, 12).map(([i, set]) => [i, [std[0][+i], ...[...set].slice(0, 4)].map((x) => String(x).slice(0, 60))])) };
		});
		console.log('LJ-PROGRAMS ' + JSON.stringify(programs));
		return { metric, ok: !!done };
	};

	/** brief row 2 + names: every host object on B, same name / visibility / parent @param {any} B @param {string} label */
	const sameObjects = async (B, label) => {
		const mine = await peerObjects(B.page);
		const byUuid = new Map(mine.map((o) => [o.uuid, o]));
		const missing = built.all.filter((o) => !byUuid.has(o.uuid));
		const renamed = built.all.filter((o) => byUuid.has(o.uuid) && byUuid.get(o.uuid).name !== o.name);
		const moved = built.all.filter((o) => byUuid.has(o.uuid) && byUuid.get(o.uuid).parent !== o.parent);
		const dupes = mine.length - byUuid.size;
		h.check(!missing.length, `${label}: every host object reached B (${missing.length} missing${missing.length ? ': ' + missing.slice(0, 5).map((o) => o.name).join(', ') : ''})`);
		h.check(!renamed.length, `${label}: names arrive as written, spaces kept (${renamed.length} renamed${renamed.length ? ': ' + renamed.slice(0, 3).map((o) => `"${o.name}" -> "${byUuid.get(o.uuid).name}"`).join(', ') : ''})`);
		h.check(!moved.length, `${label}: every object under the same parent (${moved.length} moved)`);
		h.check(dupes === 0, `${label}: no uuid twice (${dupes})`);
		for (const u of built.templates) {
			const host = hostByUuid.get(u);
			const got = byUuid.get(u);
			h.check(!!got && got.visible === host.visible && got.name === host.name, `${label}: template "${host.name}" is on B, hidden as on the host (${got ? 'visible=' + got.visible + ' name=' + JSON.stringify(got.name) : 'MISSING'})`);
		}
		const graph = await B.page.evaluate(() => {
			let g;
			/** @type {any} */ (window).__stores.flowGraphs.subscribe((v) => (g = v))();
			return (g.scene?.nodes ?? []).map((n) => n.type);
		});
		h.check(graph.includes('spawn') && graph.includes('objectselector'), `${label}: B holds the spawner graph (${graph.join(',')})`);
	};

	let B;
	if (want(1) || want(2)) {
		B = await h.setupPageQuiet(browser, 'B', [A]);
		const { metric } = await measuredJoin(B);
		if (!REPORT) {
			h.check(metric.applyMs >= 0 && metric.applyMs <= MAX_MS, `row 1: B holds all ${metric.objects} objects within ${MAX_MS} ms of its link opening, at CPU x${CPU} (${metric.applyMs} ms; link ${metric.connMs}, first ${metric.firstMs}, all ${metric.allMs} ms after the approval)`);
			h.check(metric.maxLongtaskMs <= LONGTASK_MS, `row 1: no long task over ${LONGTASK_MS} ms while it lands (max ${metric.maxLongtaskMs} ms, ${metric.longtasks} long tasks)`);
		}
		// a moment for anything that trails the batch (names / parents fixed up after the last object)
		await B.page.waitForTimeout(1500);
		await sameObjects(B, 'join');
	}

	if (want(2) && B) {
		console.log('\n=== 2. reload ===');
		await h.freshReload(B);
		await h.answerRestore(B).catch(() => {});
		// a reloaded tab rejoins by itself (reload-rejoin); dial only when it did not
		let rejoined = false;
		for (const until = Date.now() + 45000; Date.now() < until && !rejoined; await B.page.waitForTimeout(500))
			rejoined = await B.page
				.evaluate((hid) => new Promise((r) => /** @type {any} */ (window).__tp.test.v1.peers.subscribe((p) => r(!!p?.connections?.[hid]?.open))()), A.id)
				.catch(() => false);
		h.check(true, `B ${rejoined ? 'rejoined by itself' : 'did not rejoin by itself: dialling'} after its reload`);
		if (!rejoined) await h.connect(B, A);
		await h.eventually(
			() => peerObjects(B.page).then((o) => o.length),
			(n) => n >= built.all.length,
			'B holds the host scene again',
			90000
		);
		await B.page.waitForTimeout(1500);
		await sameObjects(B, 'reload');
	}
	await h.finish(browser);
});
