// 94 SP1 — THE PLAY-ONLY ENTRY (`/play`, src/PlayApp.svelte). A shared play link boots the player,
// not the editor: the viewport, the scene, physics, the flow runtime, the play HUD, input and the
// peer layer — through the SAME runtime modules the editor plays with.
//
// What this suite holds:
//   1. `/play?scene=<url>` boots, renders a first frame, loads the scene and reports each step on
//      `window.tpPlay` (state, timings) and to a framing parent by postMessage.
//   2. NO EDITOR CODE is fetched: no Menu / Inspector / Explorer / node editor / AI window / Settings
//      module (dev server: by source path; a built app: by the build's own manifest).
//   3. The game PLAYS: the same scene, loaded in the editor and in `/play`, arrives with the same
//      objects, flow graphs and HUD screens, and ▶ Play enters play mode in `/play`.
//   4. The corner links: Open in the app and Remix (94-routes A5) carry the scene id; the start card
//      has the account slot (`#play-account-slot`, 94-routes A3).
//
// Counterfactual (base v1.56.0): `/play` does not exist (404 on a build, the editor's 404 page on a
// dev server) — every check in 1-4 is red there.
//
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout's
// games/<slug>/scene.tpscene; served to the page from this origin by a route.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const { check } = h;
const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const sceneOf = (/** @type {string} */ slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, slug, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const SLUG = process.env.PLAY_SLUG || 'sky-run';
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

/** editor-only source modules: none of these may be fetched by /play */
const EDITOR_SOURCES = /src\/components\/(Menu\.svelte|Flow\.svelte|editors\/|menu\/(Inspector|Settings|Sidebar|AiAssistant|Toasts|Connect)\b|inspector\/)/;

/** the built app's EDITOR-ONLY boot chunks: everything the editor page (index.html) loads before it
 * runs that the play page (play.html) does not — from the build beside the served one (null on a dev server) */
function editorFilesOfBuild() {
	const man = path.resolve(__dirname, '../../.svelte-kit/output/client/.vite/manifest.json');
	if (!fs.existsSync(man) || !fs.existsSync(path.resolve(__dirname, '../../build/play.html'))) return null;
	const bs = require('../../scripts/boot-size.cjs');
	const m = bs.loadManifest();
	const editor = bs.measurePage('index.html', m);
	const play = bs.measurePage('play.html', m);
	const files = new Map();
	for (const f of Object.keys(editor.chunks)) {
		const rec = m.byFile.get(f);
		// the debug hook table loads in a test page on purpose (`debugStores`), never for a player
		if (f in play.chunks || /debugHooks/.test(rec?.name ?? rec?.key ?? '')) continue;
		files.set('/' + f, rec?.name ?? rec?.key ?? f);
	}
	return files;
}

/** a page on `/play…` with the scene served from this origin; collects every request */
async function playPage(browser, name, query, opts = {}) {
	const file = sceneOf(SLUG);
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(opts.context ?? {}) });
	await ctx.addInitScript((debug) => {
		try {
			if (debug) localStorage.setItem('debugStores', 'true');
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
		} catch {
			/* about:blank (the framing parent) has no storage */
		}
	}, opts.debug !== false);
	if (file) await ctx.route('**/e2e-scenes/*.tpscene', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(file) }));
	const page = await ctx.newPage();
	/** @type {string[]} */
	const requests = [];
	page.on('request', (r) => requests.push(new globalThis.URL(r.url()).pathname));
	/** @type {string[]} */
	page.__errors = [];
	page.on('pageerror', (e) => {
		page.__errors.push(e.message);
		console.log(`[${name} pageerror] ${e.stack}`);
	});
	page.__externalErrors = [];
	const res = query == null ? null : await page.goto(h.URL + query, { waitUntil: 'domcontentloaded', timeout: 90000 });
	return { ctx, page, requests, status: res?.status() ?? 0 };
}

h.run(async () => {
	const browser = await h.launch();
	const file = sceneOf(SLUG);
	if (!file) {
		console.log(`SKIP: no ${SLUG} scene (SHELL_SCENES_DIR or a sibling scenes checkout)`);
		check(false, `the ${SLUG} scene is available to the suite`);
		return h.finish(browser);
	}
	const sceneUrl = `/e2e-scenes/${SLUG}.tpscene`;

	// --------------------------------------------------------------- 1. boot + the API
	const P = await playPage(browser, 'P', `play?scene=${encodeURIComponent(sceneUrl)}&s=abc123`);
	check(P.status === 200, `/play answers 200 (got ${P.status})`);
	await P.page.waitForFunction(() => !!window.tpPlay, null, { timeout: 90000 });
	const firstFrame = await P.page.evaluate(() => Promise.race([window.tpPlay.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 90000))]));
	check(firstFrame, 'tpPlay.ready resolves (a first frame rendered)');
	const loaded = await P.page.evaluate(() => Promise.race([window.tpPlay.loaded, new Promise((r) => setTimeout(() => r('timeout'), 120000))]));
	check(loaded === true, `tpPlay.loaded resolves true (${loaded})`);
	const api = await P.page.evaluate(() => ({
		v: window.tpPlay.version,
		state: window.tpPlay.state,
		attr: document.documentElement.dataset.tpPlay,
		t: window.tpPlay.timings,
		open: window.tpPlay.openInEditorUrl(),
		remix: window.tpPlay.remixUrl(),
		sceneId: window.tpPlay.sceneId
	}));
	console.log('tpPlay', JSON.stringify(api));
	check(api.v === 1 && api.state === 'ready' && api.attr === 'ready', `tpPlay: version 1, state ready (+ <html data-tp-play>) (${api.state})`);
	check(api.t.firstFrameMs > 0 && api.t.loadedMs >= api.t.firstFrameMs, `tpPlay.timings: first frame ${api.t.firstFrameMs} ms, loaded ${api.t.loadedMs} ms`);
	check(api.sceneId === 'abc123' && api.open.endsWith('/?s=abc123') && api.remix.endsWith('/?s=abc123&remix=1'), `tpPlay: open ${api.open}, remix ${api.remix}`);

	// --------------------------------------------------------------- 2. no editor code
	await P.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, null, { timeout: 60000 });
	const editorByPath = P.requests.filter((p) => EDITOR_SOURCES.test(p));
	const built = editorFilesOfBuild();
	const isBuilt = P.requests.some((p) => p.startsWith('/_app/immutable/'));
	if (isBuilt && built) {
		// RUNTIME chunks a player legitimately loads after boot (shared chunks carry only a name):
		//   addObjects, waterActions — the module SDK's primed refs (src/lib/sdk/refs.js: api.addObject, api.water)
		//   vrSleeve                 — the vrsleeve core module's own runtime (src/modules/vrsleeve)
		//   catalog, hdriPrefs       — the scene environment's HDRI catalog + this device's HDRI prefs
		// Anything else in the editor's boot that /play fetches is an editor surface leaking in.
		const RUNTIME_PRIMES = /^(addObjects|waterActions|vrSleeve|catalog|hdriPrefs)$/;
		// a CLEAN player page: no `debugStores` — the debug hook table imports every module it names
		// at install, which is a test page's choice and not what a shared link loads
		const C = await playPage(browser, 'C', `play?scene=${encodeURIComponent(sceneUrl)}`, { debug: false });
		await C.page.waitForFunction(() => window.tpPlay && window.tpPlay.timings.loadedMs != null, null, { timeout: 120000 }).catch(() => {});
		await C.page.waitForTimeout(4000);
		const all = C.requests.filter((p) => built.has(p)).map((p) => built.get(p));
		await C.ctx.close();
		const fetched = all.filter((n) => !RUNTIME_PRIMES.test(n));
		console.log('editor-boot chunks /play fetched after boot:', JSON.stringify(all));
		check(fetched.length === 0, `a built /play fetches no editor chunk (${fetched.length ? fetched.slice(0, 5).join(', ') : 'none'})`);
		check(built.size > 50, `the build names the editor-only boot chunks to look for (${built.size})`);
	} else {
		check(editorByPath.length === 0, `a dev /play fetches no editor module (${editorByPath.slice(0, 5).join(', ') || 'none'})`);
	}
	const dom = await P.page.evaluate(() => ({
		chrome: !!document.querySelector('#editor-chrome'),
		inspector: !!document.querySelector('#inspector, [data-region="inspector"]'),
		explorer: !!document.querySelector('#explorer-window'),
		flow: !!document.querySelector('#flow-list, .svelte-flow'),
		canvas: !!document.querySelector('.viewport canvas'),
		play: !!document.querySelector('#embed-play'),
		openLink: document.querySelector('#embed-open-link')?.getAttribute('href') ?? null,
		remixLink: document.querySelector('#embed-remix-link')?.getAttribute('href') ?? null,
		account: !!document.querySelector('#play-account-slot')
	}));
	check(!dom.chrome && !dom.inspector && !dom.explorer && !dom.flow, 'no editor DOM: no #editor-chrome, Inspector, Explorer, node editor');
	check(dom.canvas && dom.play, 'the viewport canvas + the ▶ Play start card');
	check(!!dom.openLink?.endsWith('/?s=abc123') && !!dom.remixLink?.endsWith('/?s=abc123&remix=1'), `corner links: open ${dom.openLink}, remix ${dom.remixLink}`);
	check(dom.account, 'the start card carries #play-account-slot (94-routes A3)');

	// --------------------------------------------------------------- 3. same scene as the editor
	const facts = (page) =>
		page.evaluate((r) => {
			const rd = eval(r);
			const s = window.__stores;
			const group = rd(s.objectsGroup);
			let objects = 0;
			group?.traverse((o) => {
				if (o !== group) objects++;
			});
			const graphs = Object.keys(rd(s.flowGraphs) ?? {}).length;
			const hud = rd(s.hudDocs?.hudDocs) ?? {};
			const screens = Object.values(hud).reduce((n, d) => n + (d?.screens?.length ?? 0), 0);
			return { objects, graphs, screens };
		}, read);
	const inPlay = await facts(P.page);
	const E = await h.setupPage(browser, 'E');
	await E.ctx.route('**/e2e-scenes/*.tpscene', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(file) }));
	const editorOk = await E.page.evaluate((url) => window.__stores.sceneTemplates.loadRemoteScene({ sceneUrl: url, title: 'x', slug: 'x' }, { origin: 'play' }), sceneUrl);
	await E.page.waitForTimeout(3000);
	const inEditor = await facts(E.page);
	console.log('play', JSON.stringify(inPlay), 'editor', JSON.stringify(inEditor), 'editor load', editorOk);
	check(editorOk === true, 'the editor loads the same file through the same loadRemoteScene');
	check(inPlay.objects > 0 && inPlay.objects === inEditor.objects, `same objects in /play and the editor (${inPlay.objects} vs ${inEditor.objects})`);
	check(inPlay.graphs === inEditor.graphs && inPlay.screens === inEditor.screens, `same flow graphs (${inPlay.graphs}/${inEditor.graphs}) and HUD screens (${inPlay.screens}/${inEditor.screens})`);
	await E.ctx.close();

	await P.page.click('#embed-play');
	await h.eventually(
		() => P.page.evaluate((r) => eval(r)(window.__stores.isLocked), read),
		(v) => v === true,
		'▶ Play in /play enters play mode (isLocked true)',
		20000
	);
	const playing = await P.page.evaluate(() => ({ state: window.tpPlay.state, t: window.tpPlay.timings.playingMs }));
	check(playing.state === 'playing' && playing.t > 0, `tpPlay.state = playing (${playing.state}, ${playing.t} ms)`);
	check(P.page.__errors.length === 0, `/play: no page errors (${P.page.__errors.slice(0, 2).join(' | ')})`);
	await P.ctx.close();

	// --------------------------------------------------------------- 4. postMessage when framed
	const F = await playPage(browser, 'F', null);
	// the parent is a page OF THE APP'S ORIGIN (a 404 path): an about:blank parent is a public context
	// framing localhost, which Chrome's Local Network Access blocks (the frame lands on chrome-error://)
	await F.page.goto(`${h.URL}__frame-parent`, { waitUntil: 'domcontentloaded' });
	// the listener is in place BEFORE the frame exists: setContent waits for the frame's load, and a
	// fast first frame posts before a listener added afterwards could hear it
	await F.page.setContent(
		`<script>window.__got = []; addEventListener('message', (e) => e.data && e.data.type === 'tp-play' && window.__got.push(e.data.event));</script>` +
			`<iframe id="f" src="${h.URL}play?scene=${encodeURIComponent(sceneUrl)}" style="width:800px;height:500px"></iframe>`,
		{ waitUntil: 'commit' }
	);
	await h.eventually(
		() => F.page.evaluate(() => window.__got),
		(v) => v.includes('first-frame') && v.includes('loaded'),
		'framed: the parent receives tp-play first-frame + loaded',
		120000
	);
	const inner = F.page.frames().find((f) => f !== F.page.mainFrame());
	const innerState = inner ? await inner.evaluate(() => ({ href: location.href, framed: window.parent !== window, tp: window.tpPlay ? { state: window.tpPlay.state, t: window.tpPlay.timings } : null })).catch((e) => String(e)) : 'no frame';
	console.log('framed: inside the frame', JSON.stringify(innerState), 'parent got', JSON.stringify(await F.page.evaluate(() => window.__got)));
	await F.ctx.close();

	// --------------------------------------------------------------- 5. a join-only play link
	// 94-routes Q2 F1: `/play#<HOST>&invite=<token>` (the Invite sheet's Play link, no `?s=`) — the peer
	// layer reads the hash in its constructor, and nothing may read `$peers.peer` before it exists
	const J = await playPage(browser, 'J', null);
	const jres = await J.page.goto(`${h.URL}play#abcde&invite=tok12345`, { waitUntil: 'domcontentloaded', timeout: 90000 });
	check(!!jres && jres.status() === 200, `join-only /play#HOST&invite= answers 200 (${jres?.status()})`);
	await h.eventually(
		() => J.page.evaluate(() => (window.tpPlay ? window.tpPlay.state : null)),
		(v) => v === 'ready' || v === 'error',
		'join-only: tpPlay appears',
		90000
	);
	const jstate = await J.page.evaluate(() => (window.tpPlay ? window.tpPlay.state : null));
	check(jstate === 'ready', `join-only: tpPlay is ready (${jstate})`);
	await J.page.waitForTimeout(2000);
	const jerr = J.page.__errors.filter((e) => /reading 'peer'|null/.test(e));
	check(jerr.length === 0, `join-only: no null-peer page error (${J.page.__errors.slice(0, 2).join(' | ') || 'none'})`);
	await J.ctx.close();

	await h.finish(browser);
});
