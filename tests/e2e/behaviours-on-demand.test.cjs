// 102-boot-diet (phase 1) — CODE BEHAVIOURS LOAD WITH THE SCENE THAT USES THEM. A BUILT app only:
// a dev server serves modules unwrapped, so there are no chunks to count.
//
// behaviours/app.js (the behaviour runtime, its sandbox guest and the analyzer, acorn) rode both
// boots until 1.75 because peerHandler imported it statically. It now loads on the first behaviour
// node, `bhv` message or AI layer (src/lib/behaviours/load.js). What this suite holds:
//   1. neither the behaviours chunk nor acorn is in the boot closure of play.html or index.html;
//   2. a page whose scene has NO behaviour fetches neither (/play with a scene, the editor empty);
//   3. /play with a scene that HAS one (sky-run's "Sky Run rules") fetches both, and asks for the
//      behaviours chunk before the scene has finished loading (the graph restore is the trigger);
//   4. that behaviour is RUNNING by the time the scene reports loaded (or within a short window),
//      and still running when Play enters play mode, with no page errors. (A debug page: its hook
//      table starts behaviours itself, behaviours/debugHook.js, so 3 is the page that proves the
//      scene is the trigger, by the sandbox guest's engine being fetched.)
//
// Counterfactual (v1.75.0, the base): 1 fails (both files are boot chunks) and 2 fails (the editor
// and /play fetch them for an empty scene); 3 and 4 hold there too, which is the point: no change
// for a scene that uses behaviours.
//
// Run (after `npm run build`):
//   LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' e2e-slot --local --dev <tree> 7164 -- \
//     bash -c 'APP_URL=https://localhost:7164/ node tests/e2e/behaviours-on-demand.test.cjs'
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const { check } = h;
const ROOT = path.resolve(__dirname, '../..');
const SCENES_REPO = [
	path.resolve(ROOT, '../theprototype.app-scenes'),
	path.resolve(ROOT, '../scenes')
].find((p) => fs.existsSync(p));
const sceneOf = (/** @type {string} */ slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir
		? path.join(dir, slug, 'scene.tpscene')
		: SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const WITH = process.env.BHV_SLUG || 'sky-run'; // has a behaviour node ("Sky Run rules", id `rules`)
const WITHOUT = process.env.NOBHV_SLUG || 'untangle'; // has none
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

/** the built files of the behaviours chunk and acorn's, from the build's own manifest */
function behaviourFiles() {
	const manFile = path.join(ROOT, '.svelte-kit/output/client/.vite/manifest.json');
	if (!fs.existsSync(manFile) || !fs.existsSync(path.join(ROOT, 'build/play.html'))) return null;
	const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
	const app = man['src/lib/behaviours/app.js']?.file ?? null;
	// acorn is a shared chunk named after its module (no source key of its own)
	const acorn =
		Object.entries(man).find(
			([k, v]) => /acorn/.test(k) || /** @type {any} */ (v).name === 'acorn'
		)?.[1]?.file ?? null;
	return { app, acorn };
}

/** 103-int-1: the code of the start probe (section 5) */
const PROBE_CODE = `export default behaviour({
	name: 'Start probe',
	state: { starts: 0, mark: 0, ticks: 0 },
	on: {
		start() {
			this.state.starts += 1;
			this.state.mark = 7;
			this.log('start ' + this.state.starts);
			this.after(0.05, 'tick');
		}
	},
	tick() {
		this.state.ticks += 1;
		if (this.state.ticks === 1) this.log('tick1 mark=' + this.state.mark);
		if (this.state.ticks < 20) this.after(0.05, 'tick');
		else this.log('ticks ' + this.state.ticks + ' starts ' + this.state.starts);
	}
});
`;

/** the scene with one more behaviour node, the start probe (in the graph and the flat mirror) @param {string} file */
function probeScene(file) {
	const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');
	const files = unzipSync(fs.readFileSync(file));
	const s = JSON.parse(strFromU8(files['session.json']));
	const node = {
		id: 'startProbe',
		type: 'behaviour',
		position: { x: 300, y: 600 },
		data: { label: 'Behaviour', type: 'behaviour', name: 'Start probe', code: PROBE_CODE }
	};
	if (s.graphs?.scene?.nodes) s.graphs.scene.nodes.push(node);
	if (Array.isArray(s.nodes) && s.nodes !== s.graphs?.scene?.nodes) s.nodes.push(structuredClone(node));
	files['session.json'] = strToU8(JSON.stringify(s));
	return Buffer.from(zipSync(files));
}

async function page(browser, name, query, { debug = false, scene = null, sceneBytes = null, delayFile = null, delay = 0 } = {}) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript((dbg) => {
		try {
			if (dbg) localStorage.setItem('debugStores', 'true');
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
		} catch {
			/* no storage */
		}
	}, debug);
	if (scene || sceneBytes)
		await ctx.route('**/e2e-scenes/*.tpscene', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/octet-stream',
				body: sceneBytes ?? fs.readFileSync(/** @type {string} */ (scene))
			})
		);
	// 103-int-1 counterfactual: hold the behaviours chunk (one request; nothing else waits on this route)
	if (delayFile)
		await ctx.route('**/' + delayFile, async (route) => {
			const res = await route.fetch();
			await new Promise((r) => setTimeout(r, delay));
			await route.fulfill({ response: res });
		});
	const p = await ctx.newPage();
	/** @type {string[]} */
	const requests = [];
	p.on('request', (r) => requests.push(new globalThis.URL(r.url()).pathname.replace(/^\//, '')));
	/** @type {string[]} */
	const errors = [];
	p.on('pageerror', (e) => {
		errors.push(e.message);
		console.log(`[${name} pageerror] ${e.stack}`);
	});
	await p.goto(h.URL + query, { waitUntil: 'domcontentloaded', timeout: 120000 });
	return { ctx, page: p, requests, errors };
}

/** /play: wait for the scene to report loaded @param {any} p */
const playLoaded = (p) =>
	p
		.waitForFunction(
			() =>
				/** @type {any} */ (window).tpPlay &&
				/** @type {any} */ (window).tpPlay.timings.loadedMs != null,
			null,
			{ timeout: 180000 }
		)
		.then(
			() => true,
			() => false
		);

h.run(async () => {
	const files = behaviourFiles();
	if (!files) {
		check(false, 'a built app (build/play.html + the vite manifest) is beside the suite');
		process.exit(1);
	}
	check(
		!!files.app && !!files.acorn,
		`the build names the behaviours chunk (${files.app}) and acorn's (${files.acorn})`
	);
	const withScene = sceneOf(WITH);
	const withoutScene = sceneOf(WITHOUT);
	check(!!withScene && !!withoutScene, `the ${WITH} and ${WITHOUT} scenes are available`);
	if (!withScene || !withoutScene || !files.app || !files.acorn) process.exit(1);

	// ---------------------------------------------------------------- 1. not in either boot
	const bs = require(path.join(ROOT, 'scripts/boot-size.cjs'));
	process.chdir(ROOT);
	const man = bs.loadManifest();
	for (const [name, html] of [
		['play', 'play.html'],
		['editor', 'index.html']
	]) {
		const boot = Object.keys(bs.measurePage(html, man).chunks);
		check(
			!boot.includes(files.app) && !boot.includes(files.acorn),
			`${name} boot carries neither the behaviours chunk nor acorn (${boot.length} boot chunks)`
		);
	}

	const browser = await h.launch();
	try {
		// ------------------------------------------------------------ 2. a scene with none fetches neither
		const A = await page(
			browser,
			'A',
			`play?scene=${encodeURIComponent('/e2e-scenes/' + WITHOUT + '.tpscene')}`,
			{ scene: withoutScene }
		);
		const aLoaded = await playLoaded(A.page);
		await A.page.waitForTimeout(4000);
		check(aLoaded, `/play loads ${WITHOUT} (no behaviour node)`);
		check(
			!A.requests.includes(files.app) && !A.requests.includes(files.acorn),
			`/play with ${WITHOUT}: neither chunk fetched (app ${A.requests.includes(files.app)}, acorn ${A.requests.includes(files.acorn)})`
		);
		check(
			A.errors.length === 0,
			`/play ${WITHOUT}: no page errors (${A.errors.slice(0, 2).join(' | ')})`
		);
		await A.ctx.close();

		const E = await page(browser, 'E', '');
		await E.page.waitForSelector('canvas', { timeout: 120000 }).catch(() => {});
		await E.page.waitForTimeout(8000);
		check(
			!E.requests.includes(files.app) && !E.requests.includes(files.acorn),
			`the editor with an empty scene: neither chunk fetched (app ${E.requests.includes(files.app)}, acorn ${E.requests.includes(files.acorn)})`
		);
		check(E.errors.length === 0, `editor: no page errors (${E.errors.slice(0, 2).join(' | ')})`);
		await E.ctx.close();

		// ------------------------------------------------------------ 3. a scene with one fetches both, early
		const C = await page(
			browser,
			'C',
			`play?scene=${encodeURIComponent('/e2e-scenes/' + WITH + '.tpscene')}`,
			{ scene: withScene }
		);
		const cLoaded = await playLoaded(C.page);
		check(cLoaded, `/play loads ${WITH}`);
		await C.page.waitForTimeout(2000);
		const when = await C.page.evaluate((f) => {
			const at = (/** @type {string} */ file) =>
				performance.getEntriesByType('resource').find((e) => e.name.endsWith('/' + file));
			const app = at(f.app);
			return {
				appStart: app ? Math.round(app.startTime) : null,
				appEnd: app ? Math.round(/** @type {any} */ (app).responseEnd) : null,
				acorn: !!at(f.acorn),
				t: /** @type {any} */ (window).tpPlay.timings
			};
		}, files);
		console.log(
			`${WITH}: behaviours chunk requested at ${when.appStart} ms, in at ${when.appEnd} ms; first frame ${when.t.firstFrameMs}, loaded ${when.t.loadedMs}`
		);
		check(
			when.appStart != null && when.acorn,
			`/play with ${WITH}: the behaviours chunk and acorn are fetched`
		);
		check(
			when.appStart != null && when.appStart <= when.t.loadedMs,
			`the behaviours chunk is asked for while the scene loads (${when.appStart} <= loaded ${when.t.loadedMs} ms)`
		);
		// started, not only fetched: a behaviour compiles in the sandbox guest, whose engine is a QuickJS .wasm
		// fetched on the first compile (no debug hook on this page: the hook table would start them itself)
		const guest = await C.page.evaluate(() =>
			performance.getEntriesByType('resource').some((e) => /quickjs|\.wasm(\?|$)/.test(e.name))
		);
		check(
			guest,
			`/play with ${WITH}: the behaviour reached the sandbox guest (its QuickJS engine was fetched)`
		);
		check(
			C.errors.length === 0,
			`/play ${WITH}: no page errors (${C.errors.slice(0, 2).join(' | ')})`
		);
		await C.ctx.close();

		// ------------------------------------------------------------ 4. it runs: at load, and in Play
		const D = await page(
			browser,
			'D',
			`play?scene=${encodeURIComponent('/e2e-scenes/' + WITH + '.tpscene')}`,
			{ scene: withScene, debug: true }
		);
		// sample the behaviour's status every frame from the start, so "running at load" is measured, not polled late
		await D.page.waitForFunction(
			() => !!(/** @type {any} */ (window).__tp?.test.v1?.behaviours),
			null,
			{ timeout: 120000 }
		);
		await D.page.evaluate(() => {
			const w = /** @type {any} */ (window);
			w.__bhvRunAt = null;
			const tick = () => {
				const st = w.__tp.test.v1.behaviours.behavioursDebug().status;
				if (
					w.__bhvRunAt == null &&
					Object.values(st).some((s) => /** @type {any} */ (s)?.status === 'running')
				)
					w.__bhvRunAt = Math.round(performance.now());
				if (w.__bhvRunAt == null) requestAnimationFrame(tick);
			};
			tick();
		});
		const dLoaded = await playLoaded(D.page);
		check(dLoaded, `/play (debug) loads ${WITH}`);
		/** @type {{at: number | null, loaded: number | null} | null} */
		let run = null;
		for (const t0 = Date.now(); Date.now() - t0 < 30000; await D.page.waitForTimeout(300)) {
			run = await D.page.evaluate(() => ({
				at: /** @type {any} */ (window).__bhvRunAt,
				loaded: /** @type {any} */ (window).tpPlay.timings.loadedMs
			}));
			if (run.at != null) break;
		}
		check(run?.at != null, `the scene behaviour reaches running (${JSON.stringify(run)})`);
		const lag = run && run.at != null && run.loaded != null ? run.at - run.loaded : null;
		console.log(
			`${WITH}: behaviour running at ${run?.at} ms, scene loaded at ${run?.loaded} ms (lag ${lag} ms)`
		);
		check(
			lag != null && lag <= 1500,
			`the behaviour is running by the scene's load (+1.5 s at most on a slow box): ${lag} ms after loaded`
		);
		await D.page.click('#embed-play');
		await h.eventually(
			() =>
				D.page.evaluate((r) => eval(r)(/** @type {any} */ (window).__tp.test.v1.isLocked), read),
			(v) => v === true,
			'▶ Play enters play mode',
			20000
		);
		const inPlay = await D.page.evaluate(() =>
			Object.values(
				/** @type {any} */ (window).__tp.test.v1.behaviours.behavioursDebug().status
			).map((s) => /** @type {any} */ (s).status)
		);
		check(
			inPlay.length > 0 && inPlay.every((s) => s === 'running'),
			`in play mode the behaviours run (${inPlay.join(', ')})`
		);
		check(
			D.errors.length === 0,
			`/play (debug) ${WITH}: no page errors (${D.errors.slice(0, 2).join(' | ')})`
		);
		await D.ctx.close();

		// ------------------------------------------------------------ 5. the first tick is not missed
		// 103-int-1 (the GAME RULE for 102-boot-diet): a game's behaviour now starts only after its
		// runtime arrives, so prove that `start` fires EXACTLY once and that the state it sets is there
		// on the behaviour's first timer tick — on a plain /play page (no debug hook table, which would
		// load the runtime at boot and hide the on-demand path). The probe is a second behaviour added
		// to the scene; `this.log` is console.log on the page. BHV_DELAY_MS (the counterfactual) holds
		// the behaviours chunk's response that long, as a slow network would.
		const probe = probeScene(withScene);
		const delay = Number(process.env.BHV_DELAY_MS || 0);
		const P = await page(
			browser,
			'P',
			`play?scene=${encodeURIComponent('/e2e-scenes/' + WITH + '-probe.tpscene')}`,
			{ sceneBytes: probe, delayFile: delay ? files.app : null, delay }
		);
		/** @type {string[]} */
		const lines = [];
		P.page.on('console', (m) => {
			const t = m.text();
			if (t.includes('[behaviour Start probe]')) lines.push(t.replace(/^.*\[behaviour Start probe\]\s*/, ''));
		});
		const pLoaded = await playLoaded(P.page);
		check(pLoaded, `/play loads ${WITH} with the start probe${delay ? ` (behaviours chunk held ${delay} ms)` : ''}`);
		const done = () => lines.some((l) => l.startsWith('ticks 20'));
		for (const t0 = Date.now(); Date.now() - t0 < 30000 && !done(); ) await P.page.waitForTimeout(250);
		console.log(`probe lines before Play: ${JSON.stringify(lines)}`);
		const starts = () => lines.filter((l) => l.startsWith('start ')).length;
		check(starts() === 1, `On start fires exactly once at load (${starts()})`);
		check(
			lines.includes('tick1 mark=7'),
			`the state On start set is there on the first tick (frame-1 value: ${lines.find((l) => l.startsWith('tick1')) ?? 'no tick'})`
		);
		check(done() && lines.includes('ticks 20 starts 1'), 'the probe counted 20 ticks with one start');
		await P.page.click('#embed-play').catch(() => {});
		await P.page.waitForTimeout(5000);
		check(starts() === 1, `entering Play does not start it again (${starts()} start lines after Play)`);
		check(
			P.errors.length === 0,
			`/play probe: no page errors (${P.errors.slice(0, 2).join(' | ')})`
		);
		await P.ctx.close();
	} finally {
		await h.finish(browser);
	}
});
