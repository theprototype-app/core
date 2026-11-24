// @ts-nocheck — bench runner (browser). Lane 99-scrub: the loop-cut SCRUB step and the face-grab COMMIT on a 67k mesh,
// through the app's own entry points (the 99-int Deck row's two numbers: scrub 249-375 ms per step, commit 178-549 ms).
//   SCRUB: a loop-cut adjust on a quad ring of a 67k sphere (makeMesh('sphere', '67k')), then STEPS position steps
//   0.30 -> 0.70 the way the options pane drives them (DragRow onscrubstart -> onchange per step -> onscrubend): the
//   tree's `beginAdjustScrub` when it has one (this lane), else plain `reapplyOpAdjust` per step (every base). Per step:
//   the call ms, and the call + the next frame (rAF after the call) = what the hand feels. Then the release (settle) ms.
//   A cuts scrub 1 -> 6 -> 1 follows (the ring count re-uses the ring).
//   GRAB: RUNS face grabs of one quad near the equator, 60 moves each (one per frame), then `commitFaceGrab` timed: the
//   call ms and the call + the next frame.
//   PROFILE=1 adds a CDP CPU profile of the commits and prints the top self-time functions (where the time goes).
// Not an e2e suite (not in battery.json): a measurement. Same script on the base tree and the lane tree.
//   APP_URL=https://theprototype.app:7230/ e2e-slot --local --dev <tree> 7230 -- node tests/bench/meshScrubGrabBrowser.cjs
// BENCH_OUT=<file> appends the JSON row; BENCH_RUNS (grabs, default 20); BENCH_STEPS (scrub steps, default 40);
// BENCH_HEADED=1 launches a headed GPU browser (--disable-gpu-vsync --disable-frame-rate-limit, the Deck row's flags).
const fs = require('fs');
const path = require('path');
const { launch, setupPage } = require('../e2e/helpers.cjs');

(async () => {
	const headed = process.env.BENCH_HEADED === '1';
	const browser = await launch({
		args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'].concat(
			headed ? ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--ignore-gpu-blocklist'] : []
		),
		...(headed ? { headless: false } : {})
	});
	let rc = 0;
	try {
		const { page } = await setupPage(browser, 'bench');
		const adapter = await page.evaluate(() =>
			fetch('/src/lib/meshKernel/three.js').then((r) => r.text())
		);
		const threeUrl = adapter.match(/from "(\/node_modules\/\.vite\/deps\/three\.js[^"]*)"/)?.[1];
		if (!threeUrl) throw new Error("could not find the app's three URL in the vite-served adapter");
		const source = fs
			.readFileSync(path.join(__dirname, 'meshKernelBench.js'), 'utf8')
			.replace(/from 'three'/g, `from '${threeUrl}'`)
			.replace(/from '\$lib\//g, "from '/src/lib/");
		await page.route('**/tests/bench/meshKernelBench.js', (route) =>
			route.fulfill({ status: 200, contentType: 'text/javascript', body: source })
		);
		const runs = Number(process.env.BENCH_RUNS ?? 20);
		const steps = Number(process.env.BENCH_STEPS ?? 40);
		const profile = process.env.PROFILE === '1';
		const size = process.env.BENCH_SIZE ?? '67k';
		// set up the mesh + session once
		const setup = await page.evaluate(
			async ({ size }) => {
				const s = window.__tp.test.v1;
				const fe = s.faceEdit;
				const bench = await import('/tests/bench/meshKernelBench.js');
				const raf = () => new Promise((r) => requestAnimationFrame(r));
				fe.vrFaceCap?.set?.(2_000_000);
				s.commandsHandler.sceneCommand('/create Box 1 1 1');
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				const object = g.children[g.children.length - 1];
				const geometry = bench.makeMesh('sphere', size);
				fe.applyMeshGeo(object.uuid, Array.from(geometry.attributes.position.array));
				const entered = fe.enterFaceEdit(object.uuid);
				fe.setFaceSubmode('faces');
				fe.setFaceGranularity('quad');
				for (let i = 0; i < 5; i++) await raf();
				// the kernel (the adjust engine's op mesh) builds off-thread: wait until a loop cut can begin
				// the face holding the triangle nearest (1, 0, 0): a quad on the equator, a whole latitude ring through it
				const pick = () => {
					const V3 = object.position.constructor;
					const P = object.geometry.attributes.position.array;
					let tri = -1;
					let bd = Infinity;
					for (let t = 0; t < P.length / 9; t++) {
						let x = 0,
							y = 0,
							z = 0;
						for (let c = 0; c < 3; c++) {
							x += P[t * 9 + c * 3] / 3;
							y += P[t * 9 + c * 3 + 1] / 3;
							z += P[t * 9 + c * 3 + 2] / 3;
						}
						const d = (x - 1) ** 2 + y * y + z * z;
						if (d < bd) ((bd = d), (tri = t));
					}
					return { s, fe, V3, tri };
				};
				window.__bench = { object, uuid: object.uuid, pick };
				let renderer = null;
				try {
					const gl = document.createElement('canvas').getContext('webgl2');
					const ext = gl?.getExtension('WEBGL_debug_renderer_info');
					renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
				} catch {}
				return {
					renderer,
					entered,
					tris: object.geometry.attributes.position.count / 3,
					scrubBracket: typeof fe.beginAdjustScrub === 'function'
				};
			},
			{ size }
		);
		const scrub = await page.evaluate(
			async ({ steps }) => {
				const { s, fe, tri } = window.__bench.pick();
				if (tri < 0) return { error: 'no equator triangle' };
				const raf = () => new Promise((r) => requestAnimationFrame(r));
				const now = () => performance.now();
				const sorted = (a) => [...a].sort((x, y) => x - y);
				const q = (a, p) =>
					a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))] : null;
				fe.pickFaceUnit(tri); // quad granularity: the quad under that triangle
				const pickedTris = fe.currentTargetFace()?.triIndices?.length ?? null;
				// idle frames: what a frame costs with nothing changing (the step numbers include one)
				const idle = [];
				for (let i = 0; i < 20; i++) {
					const a = now();
					await raf();
					idle.push(now() - a);
				}
				let began = false;
				const t0 = now();
				for (let i = 0; i < 400 && !began; i++) {
					began = fe.beginOpAdjust('loopcut', { cuts: 1, position: 0.5 }) !== false;
					if (!began) await new Promise((r) => setTimeout(r, 50));
				}
				if (!began) return { error: 'loop cut never began' };
				const beginMs = now() - t0;
				for (let i = 0; i < 3; i++) await raf();
				const bracket = typeof fe.beginAdjustScrub === 'function';
				const drive = async (values, key) => {
					const call = [];
					const step = [];
					if (bracket) fe.beginAdjustScrub();
					for (const v of values) {
						const a = now();
						fe.reapplyOpAdjust({ [key]: v });
						const b = now();
						await raf();
						call.push(b - a);
						step.push(now() - a);
					}
					const r0 = now();
					fe.settleOpAdjust();
					const release = now() - r0;
					await raf();
					return {
						call: { median: q(call, 0.5), p95: q(call, 0.95), max: q(call, 1) },
						step: { median: q(step, 0.5), p75: q(step, 0.75), p95: q(step, 0.95) },
						releaseMs: release
					};
				};
				const positions = Array.from(
					{ length: steps },
					(_, i) => 0.3 + (0.4 * i) / Math.max(1, steps - 1)
				);
				const pos = await drive(positions, 'position');
				const cutsVals = [2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
				const cuts = await drive(cutsVals, 'cuts');
				const tris = window.__bench.object.geometry.attributes.position.count / 3;
				fe.endOpAdjust();
				s.history.undo();
				for (let i = 0; i < 3; i++) await raf();
				return {
					beginMs,
					bracket,
					pickedTris,
					idleFrame: { median: q(idle, 0.5), p95: q(idle, 0.95) },
					position: pos,
					cuts,
					trisAfterCut: tris
				};
			},
			{ steps }
		);
		let client = null;
		if (profile) {
			client = await page.context().newCDPSession(page);
			await client.send('Profiler.enable');
			await client.send('Profiler.setSamplingInterval', { interval: 100 });
		}
		const grabMoves = () =>
			page.evaluate(async () => {
				const { fe, V3, tri } = window.__bench.pick();
				if (tri < 0) return { error: 'no equator triangle' };
				const raf = () => new Promise((r) => requestAnimationFrame(r));
				const now = () => performance.now();
				fe.pickFaceUnit(tri);
				const target = fe.currentTargetFace();
				if (!target || !fe.beginFaceGrab(target)) return { error: 'grab did not begin' };
				const moves = [];
				for (let i = 1; i <= 60; i++) {
					const a = now();
					fe.applyFaceGrab({ dPos: new V3(0.0004 * i, 0.0002 * i, 0) });
					moves.push(now() - a);
					await raf();
				}
				moves.sort((x, y) => x - y);
				return { moveMedian: moves[30], grabbedTris: target.triIndices.length };
			});
		const grabCommit = () =>
			page.evaluate(async () => {
				const fe = window.__tp.test.v1.faceEdit;
				const raf = () => new Promise((r) => requestAnimationFrame(r));
				const a = performance.now();
				fe.commitFaceGrab();
				const call = performance.now() - a;
				await raf();
				return { call, frame: performance.now() - a };
			});
		const grabs = [];
		const profiles = [];
		for (let r = 0; r < runs; r++) {
			const m = await grabMoves();
			if (m.error) {
				grabs.push(m);
				continue;
			}
			if (client) await client.send('Profiler.start');
			const c = await grabCommit();
			if (client) profiles.push((await client.send('Profiler.stop')).profile);
			grabs.push({ ...m, ...c });
			await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
		}
		const ok = grabs.filter((g) => !g.error);
		const q = (a, p) => {
			const s = [...a].sort((x, y) => x - y);
			return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
		};
		const grab = {
			runs: ok.length,
			errors: grabs.length - ok.length,
			commitCall: {
				median: q(
					ok.map((g) => g.call),
					0.5
				),
				p95: q(
					ok.map((g) => g.call),
					0.95
				),
				max: q(
					ok.map((g) => g.call),
					1
				)
			},
			commitFrame: {
				median: q(
					ok.map((g) => g.frame),
					0.5
				),
				p95: q(
					ok.map((g) => g.frame),
					0.95
				),
				max: q(
					ok.map((g) => g.frame),
					1
				)
			},
			moveMedian: q(
				ok.map((g) => g.moveMedian),
				0.5
			),
			all: ok.map((g) => Math.round(g.call))
		};
		let top = null;
		if (profiles.length) {
			// self time by function name + url:line, summed over every profile (the commits dominate the samples
			// outside the moves; the moves' own functions show up too and are named)
			const self = new Map();
			for (const p of profiles) {
				const byId = new Map(p.nodes.map((n) => [n.id, n]));
				const dt = p.timeDeltas;
				for (let i = 0; i < p.samples.length; i++) {
					const n = byId.get(p.samples[i]);
					const cf = n.callFrame;
					const k =
						(cf.functionName || '(anon)') +
						' ' +
						cf.url.replace(/^.*\/(src|node_modules)\//, '$1/') +
						':' +
						(cf.lineNumber + 1);
					self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
				}
			}
			top = [...self.entries()]
				.filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k) || /garbage/.test(k))
				.sort((a, b) => b[1] - a[1])
				.slice(0, 30)
				.map(([k, ms]) => [k, Math.round(ms / profiles.length)]);
		}
		const row = {
			tag: process.env.BENCH_TAG ?? '',
			when: new Date().toISOString(),
			url: process.env.APP_URL,
			headed,
			...setup,
			scrub,
			grab,
			top
		};
		console.log(JSON.stringify(row, null, 1));
		if (process.env.BENCH_OUT) fs.appendFileSync(process.env.BENCH_OUT, JSON.stringify(row) + '\n');
		if (scrub.error || grab.errors) rc = 1;
	} catch (e) {
		console.error('SCRIPT FAILED', e);
		rc = 1;
	} finally {
		await browser.close();
	}
	process.exit(rc);
})();
