// Shared helpers for the e2e suite. Tests are plain node scripts (no runner
// framework) driving two/three real browser contexts through the public
// PeerJS cloud — see README.md for the recipe and gotchas.

const { chromium } = require('playwright');

const URL = process.env.APP_URL || 'https://theprototype.app:5173/';

// Optional: seed the peer-server Settings for every test context. Needed when
// the app is served from a hostname the peerHandler treats as LOCAL DEV
// (anything not ending .io/.app — e.g. https://localhost:5175 in a worktree
// lane): default mode then targets a local :9001 signaling server that
// usually isn't running. Example:
//   PEER_CONFIG={"mode":"custom","custom":{"host":"peerjs.theprototype.app","port":443,"path":"/peerjs","secure":true}}
const PEER_CONFIG = process.env.PEER_CONFIG || '';

let failures = 0;

/** @param {boolean} ok @param {string} label */
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}

// Headless Chromium renders WebGL through SwiftShader by default, which makes the
// viewport the frame-rate bottleneck (measured: ~4.5 fps at 1280x720 with the AO
// pass on). These flags hand ANGLE the real GPU when there is one — ANGLE falls
// back to SwiftShader on its own where there isn't, so they are safe everywhere.
// Only worth passing when a test actually cares about frame rate (net-stress).
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

// Headless Chromium HAS no audio device, but WebAudio still runs against a null
// sink and an AnalyserNode still sees the samples — measured: a 0.5-amplitude
// 440Hz sine reads peak RMS 0.355 against a theoretical 0.5/sqrt(2) = 0.3536, and
// an OfflineAudioContext render of a unit sine reads 0.7071 against 1/sqrt(2).
// So audio IS measurable here; what is NOT is whether it sounds good.
//
// The autoplay flag is what keeps the context out of 'suspended' without a real
// gesture. Pass these for any suite that asserts on sound.
//
// GPU_ARGS IS PART OF IT, and not optionally. An AnalyserNode only reports the
// instant you read it, so the metrics loop has to sample often — and on a
// SwiftShader page the 3D render starves the main thread badly enough that the
// loop barely runs. MEASURED on the same ping chime: 2 samples per 500ms reading
// peak 0.0051 without the GPU args, 30 samples reading 0.1303 with them. The low
// number is not quieter audio, it is the loop missing the attack and catching only
// the decay tail — so a threshold tuned on one is meaningless on the other. Folded
// in here rather than documented, because this is exactly the mistake a caller
// makes silently. (Same family as the GPU_ARGS rate-assertion rule in the e2e skill.)
const AUDIO_ARGS = ['--autoplay-policy=no-user-gesture-required', ...GPU_ARGS];

/** @param {any=} options e.g. {args: ['--use-fake-device-for-media-stream']} */
function launch(options = {}) {
	// background pages must keep full-rate rAF — synced-clock phase checks
	// (module-sdk wave) read stale frames on a throttled renderer otherwise
	const noThrottle = [
		'--disable-background-timer-throttling',
		'--disable-renderer-backgrounding',
		'--disable-backgrounding-occluded-windows'
	];
	const { args = [], ...rest } = options;
	return chromium.launch({ headless: true, args: [...noThrottle, ...args], ...rest });
}

/**
 * Fresh context + page with debug stores enabled, waits for hydration.
 * `options.context` is spread into newContext (viewport, hasTouch, …);
 * `options.storage` seeds extra localStorage keys BEFORE the app boots, for
 * prefs that must be in place at module-eval time (e.g. `viewMode`).
 * @returns {{ctx: any, page: any, id: string}}
 */
async function setupPage(browser, name, options = {}) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(options.context ?? {}) });
	await ctx.addInitScript((peerConfig) => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		// RW: a fresh profile is a "first visit", which opens the welcome overlay over
		// the whole UI. The whats-new suite clears this flag to test that path.
		// (With it set and no lastSeenVersion, startWhatsNew marks the version seen
		// silently — so no update badge/toast appears either.)
		localStorage.setItem('hasSeenWelcome', 'true');
		if (peerConfig) localStorage.setItem('peerServerConfig', peerConfig);
	}, PEER_CONFIG);
	// options.audio installs the destination TAP before any app code runs, so
	// everything the app plays can be measured. Opt-in on purpose: it inserts a
	// gain node in front of ctx.destination, and `spatial-voice` asserts on the
	// exact shape of its panner chains.
	if (options.audio) await ctx.addInitScript(AUDIO_TAP_SOURCE);
	// caller overrides last, so a test can replace any of the defaults above
	if (options.storage) {
		await ctx.addInitScript((extra) => {
			for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, String(v));
		}, options.storage);
	}
	const page = await ctx.newPage();
	// Page errors were LOGGED and nothing more, so a suite could sail past a
	// component that had crashed on mount: a duplicate each-key threw inside the
	// Animation window, the pane stopped opening for real users, and every check
	// that read a store still passed. They are collected now — `finish` fails the
	// run on anything that looks like a svelte/render crash, and `pageErrors(peer)`
	// lets a suite assert on them directly.
	/** @type {string[]} */
	page.__errors = [];
	page.on('pageerror', (err) => {
		page.__errors.push(err.message ?? String(err));
		console.log(`[${name} pageerror] ` + err.stack);
	});
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForTimeout(4000);
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	const id = await page.evaluate(
		() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))())
	);
	console.log(name + ' id: ' + id);
	return { ctx, page, id };
}

/** Connect `from` to `to` (approve on `to`), then let the mesh settle. */
async function connect(from, to, settleMs = 9000) {
	await step(from, 'fill the peer id', () =>
		from.page.locator('input[placeholder="Enter peer ID to connect"]').fill(to.id)
	);
	await step(from, 'press Connect', () =>
		from.page.getByRole('button', { name: 'Connect', exact: true }).click()
	);
	await step(to, 'approve the request', () =>
		to.page.getByRole('button', { name: 'Approve' }).click({ timeout: 30000 })
	);
	await from.page.waitForTimeout(settleMs);
}

/**
 * Run one connect action and, if it fails, say WHY before rethrowing.
 *
 * A bare `locator.click: Timeout` here is the least informative failure in the
 * suite: every two-peer test funnels through this helper, so a page that crashed
 * on mount (or a dev server serving a stale half-transformed module — the
 * documented long-lived-server trap) surfaces as "prefabs is red" with nothing
 * pointing at the cause. This does NOT swallow anything: the original error is
 * rethrown unchanged, with the page's collected errors and whether the connect
 * chrome rendered at all attached to it.
 */
async function step(peer, what, run) {
	try {
		return await run();
	} catch (error) {
		let chrome = 'unreadable';
		try {
			chrome = JSON.stringify(
				await peer.page.evaluate(() => ({
					input: !!document.querySelector('input[placeholder="Enter peer ID to connect"]'),
					buttons: [...document.querySelectorAll('button')]
						.map((b) => (b.textContent || '').trim())
						.filter(Boolean)
						.slice(0, 20),
					booted: !!window.__stores
				}))
			);
		} catch {}
		const errors = peer.page.__errors?.length ? peer.page.__errors.join(' | ') : 'none';
		error.message = `connect: could not ${what} on ${peer.id}\n  page errors: ${errors}\n  chrome: ${chrome}\n${error.message}`;
		throw error;
	}
}

/** Poll `fn` until `predicate` holds; records a PASS/FAIL check. */
async function eventually(fn, predicate, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) return check(true, label);
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last));
	check(false, label);
}

/** Screen pixel of a world point on that page's camera. @param {number[]} world */
function projectPoint(page, world) {
	return page.evaluate(
		(world) =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					window.__stores.globalCamera.subscribe((camera) => {
						const v = scene.position.clone().set(world[0], world[1], world[2]).project(camera);
						resolve({
							x: (v.x * 0.5 + 0.5) * window.innerWidth,
							y: (-v.y * 0.5 + 0.5) * window.innerHeight
						});
					})();
				})();
			}),
		world
	);
}

/**
 * Reload a page and wait for the debug hook to republish.
 *
 * WHY: the `debugStores` hook reaches singletons via dynamic `import()`. On a dev
 * server churned by HMR, that can bind a SECOND module instance, so a value set
 * through `window.__stores.<mod>` may NOT be the same store a component reads via
 * its static import — the component renders stale (this bit the AI prompt-pill
 * check). A fresh navigation rebuilds one consistent module graph. Store state that
 * persists to localStorage (provider configs, toggles) survives the reload, so seed
 * it first, then `freshReload`, then assert component-rendered UI. Session-only
 * stores must be set AFTER the reload.
 */
async function freshReload(peer) {
	await peer.page.reload({ waitUntil: 'domcontentloaded' });
	await peer.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
}

/** Everything the page threw, for a suite that wants to assert on it.
 * @param {any} peer @returns {string[]} */
function pageErrors(peer) {
	return peer?.page?.__errors ?? [];
}

// ---- reading real composited PIXELS ---------------------------------------
//
// The only way this repo has to observe what the renderer actually PUT ON SCREEN
// (post-processing, outlines, AO) is: screenshot in node -> push the PNG back
// INTO the page -> decode it on a 2D canvas -> read getImageData. The detour
// exists because node here has no PNG decoder and the page has a real one.
//
// The comparison itself runs IN THE PAGE and only the metrics cross the CDP
// bridge: a 1280x720 frame is 3.7M numbers, which is not something to serialise
// once, let alone per assertion.

/** The in-page decoder, injected as source into every pixel evaluate. */
const DECODE_FN = `async (b64) => {
	const img = new Image();
	await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
	const canvas = document.createElement('canvas');
	canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.drawImage(img, 0, 0);
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}`;

/**
 * Screenshot the WebGL canvas, or an explicit sub-rect of the page.
 *
 * With no clip it derives the rect from the RENDERER's own `domElement` rather
 * than a `canvas` locator: `<DungeonMinimap />` renders a hidden canvas BEFORE
 * threlte's in App.svelte, so `locator('canvas').first()` waits 30s on an
 * invisible element (the same trap as never `waitForSelector('canvas')`).
 *
 * Pass a clip for any COLOUR measurement: DOM chrome (Connect bar, HUD, windows)
 * is composited over the canvas and lands in an element screenshot too, so a
 * "how many pixels are not X" metric has to look at a chrome-free region.
 * @param {any} peer @param {any} [clip] {x, y, width, height}
 */
async function grabFrame(peer, clip) {
	const rect =
		clip ??
		(await peer.page.evaluate(
			() =>
				new Promise((resolve) => {
					window.__stores.globalRenderer.subscribe((renderer) => {
						const element = renderer?.domElement;
						if (!element) return resolve(null);
						const box = element.getBoundingClientRect();
						resolve({ x: box.x, y: box.y, width: box.width, height: box.height });
					})();
				})
		));
	return rect ? peer.page.screenshot({ clip: rect }) : peer.page.screenshot();
}

/** A chrome-free square of the viewport centred on a world point, for colour
 * metrics. @param {any} peer @param {number[]} world @param {number} [size] */
async function centeredClip(peer, world, size = 360) {
	const point = await projectPoint(peer.page, world);
	const view = await peer.page.viewportSize();
	const half = size / 2;
	// A point BEHIND the active camera projects to a non-finite value, and NaN survives
	// a Math.min/max clamp — Playwright then rejects the clip as "empty or outside the
	// resulting image", which reads as a broken feature. Fall back to the viewport
	// centre, which is canvas in every layout this helper is used in.
	if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y))
		return { x: Math.round(view.width / 2 - half), y: Math.round(view.height / 2 - half), width: size, height: size };
	return {
		x: Math.max(0, Math.min(view.width - size, Math.round(point.x - half))),
		y: Math.max(0, Math.min(view.height - size, Math.round(point.y - half))),
		width: size,
		height: size
	};
}

/**
 * How much two frames differ.
 *
 * `changed` — the PIXEL COUNT over `threshold` — is the metric to assert on, not
 * `mean`: a mean is blind to a thin edge (a one-pixel outline over a 1280x720
 * frame moves the mean by ~0.1 and is the whole point of the check). Keep `mean`
 * and `max` for the opposite case, a small contact band with a large delta,
 * where the count alone reads as failure.
 *
 * @param {any} page @param {Buffer} before @param {Buffer} after @param {number} [threshold]
 * @returns {Promise<{changed: number, total: number, fraction: number, mean: number, max: number, width: number, height: number, error?: string}>}
 */
async function frameDelta(page, before, after, threshold = 6) {
	return page.evaluate(
		async ({ a, b, threshold, decodeSource }) => {
			const decode = eval(decodeSource);
			const A = await decode(a);
			const B = await decode(b);
			if (A.width !== B.width || A.height !== B.height)
				return { error: 'size mismatch ' + A.width + 'x' + A.height + ' vs ' + B.width + 'x' + B.height };
			let changed = 0;
			let sum = 0;
			let max = 0;
			for (let i = 0; i < A.data.length; i += 4) {
				const delta =
					Math.abs(A.data[i] - B.data[i]) +
					Math.abs(A.data[i + 1] - B.data[i + 1]) +
					Math.abs(A.data[i + 2] - B.data[i + 2]);
				if (delta > threshold) changed++;
				sum += delta;
				if (delta > max) max = delta;
			}
			const total = A.data.length / 4;
			return {
				changed,
				total,
				fraction: changed / total,
				mean: sum / total,
				max,
				width: A.width,
				height: A.height
			};
		},
		{ a: before.toString('base64'), b: after.toString('base64'), threshold, decodeSource: DECODE_FN }
	);
}

/**
 * How many pixels of a frame are NOT within `tolerance` of `rgb`.
 *
 * Written as the negative on purpose: it is how "the outline survived a
 * full-frame effect" is measured. A flat-fill effect makes every scene pixel one
 * colour, so anything left over is what was composited AFTER it — zero means the
 * effect ran last and painted over the outline.
 *
 * @param {any} page @param {Buffer} frame @param {number[]} rgb @param {number} [tolerance]
 * @returns {Promise<{off: number, total: number, fraction: number}>}
 */
async function framePixelsOffColor(page, frame, rgb, tolerance = 24) {
	return page.evaluate(
		async ({ a, rgb, tolerance, decodeSource }) => {
			const decode = eval(decodeSource);
			const image = await decode(a);
			let off = 0;
			for (let i = 0; i < image.data.length; i += 4) {
				if (
					Math.abs(image.data[i] - rgb[0]) > tolerance ||
					Math.abs(image.data[i + 1] - rgb[1]) > tolerance ||
					Math.abs(image.data[i + 2] - rgb[2]) > tolerance
				)
					off++;
			}
			const total = image.data.length / 4;
			return { off, total, fraction: off / total };
		},
		{ a: frame.toString('base64'), rgb, tolerance, decodeSource: DECODE_FN }
	);
}

/** A RENDER crash is never acceptable, whatever the checks said: a component that
 * threw on mount is not there for the user at all. Anything else (a network hiccup,
 * a module's own console noise) still only prints. */
const FATAL_ERROR = /each_key_duplicate|effect_update_depth_exceeded|store\.set is not a function|is not a function.*svelte|Cannot read properties of undefined \(reading 'call'\)|derived_references_self|state_unsafe_mutation/;

/** Close up and exit with the right code. */
async function finish(browser) {
	// collect before the browser goes away
	/** @type {string[]} */
	const fatal = [];
	for (const ctx of browser.contexts?.() ?? []) {
		for (const page of ctx.pages?.() ?? []) {
			for (const message of page.__errors ?? []) {
				if (FATAL_ERROR.test(message)) fatal.push(message);
			}
		}
	}
	await browser.close();
	for (const message of fatal) check(false, 'the page threw a render error: ' + message.split('\n')[0]);
	console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
}

/** Wrap a test body so crashes exit non-zero. */
// 17-A: modules that moved OUT of core (dungeon, piano, car, ...) install from
// the sibling theprototype.app-modules checkout's packed zip. Returns false when
// that checkout has no zips, so a suite can SKIP instead of failing on a fresh
// clone (run "npm run pack -- --all" there to build them).
const MODULES_REPO = require('path').resolve(__dirname, '../../../theprototype.app-modules') + '/';
function moduleZipPath(id) {
	return MODULES_REPO + id + '.zip';
}
async function installModule(peer, id) {
	const fs = require('fs');
	const zip = moduleZipPath(id);
	if (!fs.existsSync(zip)) return false;
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await peer.page.waitForTimeout(400);
	await peer.page.getByRole('tab', { name: /^User/ }).click();
	await peer.page.waitForTimeout(200);
	await peer.page.locator('#install-module-zip').setInputFiles({
		name: id + '.zip',
		mimeType: 'application/zip',
		buffer: fs.readFileSync(zip)
	});
	await eventually(
		() => peer.page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		(ids) => ids.includes(id),
		id + ' module installed for the suite',
		20000
	);
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await peer.page.waitForTimeout(300);
	return true;
}

function run(body) {
	body().catch((error) => {
		console.error('SCRIPT FAILED:', error.message);
		process.exit(1);
	});
}

// R3a: the 7-node collectible CHAIN as a TEST FIXTURE. The recipe that used to build it
// (gameRecipes.makeCollectible) moved to the collectible module, but the chain's
// SEMANTICS — latch/once perRound, visibility whilePlaying, the respawn delay, perPlayer
// pulses — are core primitives these suites still cover, so the builder lives here now:
// the same nodes, the same handle-qualified edge ids, one replicated `flownodes` undo
// entry per batch (a group is one batch). Returns makeCollectible's old shape plus
// `chains: [{uuid, ids: {click, latch, gate, vis, selector, once, count, back?}}]` so a
// suite can read latch state directly (collectibleCountsFor moved out with the recipe).
async function makeCollectibleChains(peer, uuids, opts = {}) {
	return peer.page.evaluate(
		({ uuids, opts }) => {
			const s = window.__stores;
			const variable = String(opts.variable ?? 'gems').trim() || 'gems';
			const respawn = Math.max(0, Number(opts.respawn) || 0);
			const perPlayer = !!opts.perPlayer;
			const graphId = s.SCENE_GRAPH;
			const g = (() => {
				let v;
				s.flowGraphs.subscribe((x) => (v = x))();
				return v[graphId] ?? { nodes: [], edges: [] };
			})();
			const uuid4 = () => crypto.randomUUID();
			const spec = (t) => s.nodeCatalog.findNodeSpec(t);
			const makeNode = (type, x, y, data) => ({
				id: uuid4(),
				type,
				position: { x, y },
				data: { label: spec(type)?.label ?? type, type, ...(spec(type)?.defaults ?? {}), ...(data ?? {}) },
				class: 'w-[150px]'
			});
			const makeEdge = (source, target, handle) => ({
				id: 'e-' + source.id + '-' + target.id + (handle ? '.' + handle : ''),
				source: source.id,
				target: target.id,
				...(handle ? { targetHandle: handle } : {})
			});
			// already driven by a hide/show chain? (the recipe's own skip test)
			const already = (id) => {
				const sel = g.nodes.filter((n) => n.type === 'objectselector' && String(n.data?.selected ?? '') === id).map((n) => n.id);
				if (!sel.length) return false;
				return g.edges.some((e) => sel.includes(e.target) && g.nodes.find((n) => n.id === e.source)?.type === 'visibility');
			};
			let group;
			s.objectsGroup.subscribe((x) => (group = x))();
			let peerConn;
			s.peers.subscribe((x) => (peerConn = x))();
			const COL = 210, BRANCH_Y = 92, RESPAWN_Y = 184;
			const baseY = g.nodes.reduce((m, n) => Math.max(m, Number(n.position?.y) || 0), 0) + (g.nodes.length ? 190 : 40);
			const rowHeight = respawn > 0 ? RESPAWN_Y + 96 : 190;
			const targets = (Array.isArray(uuids) ? uuids : [uuids]).filter(Boolean);
			const batches = targets.map((id) => {
				const object = group?.getObjectByProperty('uuid', id);
				if (!object) return [id];
				if (object.type !== 'Group') return [id];
				const out = [];
				object.traverse((c) => { if (c !== object && c.isMesh) out.push(c.uuid); });
				return out;
			});
			const built = [], skipped = [], chains = [];
			let row = 0, entries = 0;
			for (const batch of batches) {
				const created = [], createdEdges = [];
				for (const id of batch) {
					if (!group?.getObjectByProperty('uuid', id) || already(id)) { skipped.push(id); continue; }
					const y = baseY + row * rowHeight;
					row++;
					const click = makeNode('onclick', 60, y, perPlayer ? { perPlayer: true } : undefined);
					const latch = makeNode('latch', 60 + COL, y, { perRound: true });
					const gate = makeNode('gate', 60 + COL * 2, y, { op: 'not' });
					const vis = makeNode('visibility', 60 + COL * 3, y, { whilePlaying: true });
					const selector = makeNode('objectselector', 60 + COL * 4, y, { selected: id });
					const once = makeNode('once', 60 + COL, y + BRANCH_Y, { perRound: true });
					const count = makeNode('setvariable', 60 + COL * 2, y + BRANCH_Y, {
						name: variable, op: 'add', value: 1, ...(perPlayer ? { scope: 'player' } : {})
					});
					const nodes = [click, latch, gate, vis, selector, once, count];
					const edges = [
						makeEdge(click, latch, 'set'),
						makeEdge(latch, gate, 'a'),
						makeEdge(gate, vis, 'on'),
						makeEdge(vis, selector),
						makeEdge(click, once, 'trigger'),
						makeEdge(once, count, 'trigger')
					];
					const ids = { click: click.id, latch: latch.id, gate: gate.id, vis: vis.id, selector: selector.id, once: once.id, count: count.id };
					if (respawn > 0) {
						const back = makeNode('delay', 60 + COL * 3, y + RESPAWN_Y, { seconds: respawn });
						nodes.push(back);
						edges.push(makeEdge(click, back, 'trigger'), makeEdge(back, latch, 'reset'), makeEdge(back, once, 'rearm'));
						ids.back = back.id;
					}
					created.push(...nodes);
					createdEdges.push(...edges);
					built.push(id);
					chains.push({ uuid: id, ids });
				}
				if (!created.length) continue;
				for (const node of created) {
					s.nodesHandler.createFlowNode(node, graphId);
					if (peerConn) peerConn.send({ type: 'nodecreate', node: s.nodesHandler.serializeNode(node), graphId });
				}
				for (const edge of createdEdges) {
					s.nodesHandler.createFlowEdge(edge, graphId);
					if (peerConn) peerConn.send({ type: 'edgecreate', edge: s.nodesHandler.serializeEdge(edge), graphId });
				}
				s.flowGraphsCtl.recordFlowNodesEntry({
					op: 'create',
					graphId,
					nodes: created.map(s.nodesHandler.serializeNode),
					edges: createdEdges.map(s.nodesHandler.serializeEdge)
				});
				entries++;
			}
			return { built, skipped, variable, respawn, perPlayer, entries, chains };
		},
		{ uuids, opts }
	);
}


// ---- audio verification -------------------------------------------------------
//
// The audio analogue of the pixel four. Same discipline: the samples never cross
// the CDP bridge, only the metrics — a 2s window at 48kHz is 96k floats per read.
//
// WHY A TAP AND NOT A DIRECT READ: today every source in the app connects straight
// to `ctx.destination` (soundRuntime, sceneMusic, pingAudio, voiceChat all do), so
// there is no one node to observe. Patching `AudioNode.prototype.connect` at INIT
// time — before any app code runs — routes anything bound for the destination
// through our own gain + analyser first. It keeps working unchanged once a master
// bus exists, because the master itself connects to the destination.

// An init script given a STRING is evaluated as SOURCE, so a bare function
// expression is created and discarded — it has to be an IIFE to actually run.
const AUDIO_TAP_SOURCE =
	'(' +
	function () {
	const rawConnect = AudioNode.prototype.connect;
	const rawDisconnect = AudioNode.prototype.disconnect;
	/** @type {Map<any, any>} */
	const taps = new Map();
	function tapFor(context) {
		let tap = taps.get(context);
		if (!tap) {
			const analyser = context.createAnalyser();
			analyser.fftSize = 2048;
			analyser.smoothingTimeConstant = 0;
			const bus = context.createGain();
			rawConnect.call(bus, analyser);
			rawConnect.call(analyser, context.destination);
			tap = { analyser, bus, context };
			taps.set(context, tap);
		}
		return tap;
	}
	AudioNode.prototype.connect = function (target, ...rest) {
		// only DIVERT a connection whose target is the raw destination, and never
		// the tap's own two nodes (that would be a feedback loop)
		// NEVER tap an OfflineAudioContext. renderOffline makes one per call, and a
		// rendered analyser LINGERS holding its result — measured: after three offline
		// renders the live read returned 5 contexts and reported the 440Hz render at
		// peak 0.708 instead of the 880Hz tone actually playing. An offline render is
		// measured from its returned buffer; it has no business in the live tap.
		const offline = typeof OfflineAudioContext !== 'undefined' && target?.context instanceof OfflineAudioContext;
		if (target instanceof AudioDestinationNode && target.context && !offline) {
			const tap = tapFor(target.context);
			if (this !== tap.analyser && this !== tap.bus) return rawConnect.call(this, tap.bus, ...rest);
		}
		return rawConnect.call(this, target, ...rest);
	};
	AudioNode.prototype.disconnect = function (target, ...rest) {
		if (target instanceof AudioDestinationNode && target.context) {
			const tap = taps.get(target.context);
			if (tap && this !== tap.analyser && this !== tap.bus)
				return rawDisconnect.call(this, tap.bus, ...rest);
		}
		return rawDisconnect.apply(this, arguments.length ? [target, ...rest] : []);
	};
	window.__audioTap = {
		/** how many AudioContexts have been tapped — see the note on audioMetrics */
		contexts: () => taps.size,
		/** every tapped context's analyser, paired with its context */
		all: () => [...taps.values()].map((t) => ({ analyser: t.analyser, context: t.context })),
		analyser: () => [...taps.values()][0]?.analyser ?? null,
		context: () => [...taps.values()][0]?.context ?? null
	};
}.toString() +
	')();';

/**
 * Sample the destination tap for `ms` and report what was heard.
 *
 * An AnalyserNode reports only the instant you read it, so a one-shot read of a
 * decaying note is a lottery — this samples repeatedly and reports the PEAK as
 * well as the mean. Assert on `peak` for "did this make a sound", on `silent`
 * for "did it stop", and on `centroid` for "did the timbre move" (a filter sweep
 * or a distortion changes the centroid while the RMS may not move at all).
 *
 * `centroid` is the magnitude-weighted mean frequency in Hz, taken at the loudest
 * sample — reading it at a quiet moment measures the noise floor's shape (on this
 * box that reads ~11988Hz, which is the tell that nothing was playing).
 *
 * EVERY tapped AudioContext is sampled and the loudest wins, because a module is
 * free to make its OWN context and most of them do — untangle, sabers,
 * door-keypad, dungeon-realms and piano each call `new AudioContext()` rather than
 * going through the app's shared one. Reading only the first tapped context made a
 * module's audio measure as SILENCE, which is the worst possible failure: a suite
 * asserting "the game makes a sound" fails inexplicably, and one asserting "it is
 * quiet" passes while lying. `contexts` is reported so a suite can assert on how
 * many were in play.
 *
 * @param {any} peer @param {number} [ms] @param {number} [floor] RMS counted as silence
 * @returns {Promise<{peak:number,mean:number,centroid:number,samples:number,contexts:number,silent:boolean,error?:string}>}
 */
async function audioMetrics(peer, ms = 600, floor = 0.001) {
	return peer.page.evaluate(
		async ({ ms, floor }) => {
			const tap = window.__audioTap;
			if (!tap) return { error: 'no audio tap — pass {audio:true} to setupPage', peak: 0, mean: 0, centroid: 0, samples: 0, contexts: 0, silent: true };
			const tapped = tap.all();
			if (!tapped.length)
				return { error: 'nothing has connected to any destination yet', peak: 0, mean: 0, centroid: 0, samples: 0, contexts: 0, silent: true };
			const scratch = tapped.map((t) => ({
				analyser: t.analyser,
				context: t.context,
				time: new Float32Array(t.analyser.fftSize),
				freq: new Float32Array(t.analyser.frequencyBinCount)
			}));
			let peak = 0;
			let sum = 0;
			let count = 0;
			/** the frequency frame of whichever context was loudest, and its bin width */
			let loudest = null;
			let loudestBinHz = 0;
			const deadline = performance.now() + ms;
			while (performance.now() < deadline) {
				await new Promise((r) => setTimeout(r, 16));
				// the LOUDEST context this tick. A module playing into its OWN context must
				// not be averaged away by the app's silent one — and taking a max rather
				// than a sum keeps a single-context reading byte-identical to before.
				let tickPeak = 0;
				let tickWinner = null;
				for (const entry of scratch) {
					entry.analyser.getFloatTimeDomainData(entry.time);
					let square = 0;
					for (let i = 0; i < entry.time.length; i++) square += entry.time[i] * entry.time[i];
					const rms = Math.sqrt(square / entry.time.length);
					if (rms > tickPeak) {
						tickPeak = rms;
						tickWinner = entry;
					}
				}
				sum += tickPeak;
				count++;
				if (tickPeak > peak && tickWinner) {
					peak = tickPeak;
					tickWinner.analyser.getFloatFrequencyData(tickWinner.freq);
					loudest = tickWinner.freq.slice();
					loudestBinHz = tickWinner.context.sampleRate / tickWinner.analyser.fftSize;
				}
			}
			// magnitude-weighted mean frequency at the loudest moment. getFloatFrequencyData
			// is dB, so convert back to linear before weighting or quiet bins dominate.
			let weighted = 0;
			let total = 0;
			if (loudest) {
				for (let i = 0; i < loudest.length; i++) {
					const magnitude = Math.pow(10, loudest[i] / 20);
					weighted += magnitude * i * loudestBinHz;
					total += magnitude;
				}
			}
			return {
				peak,
				mean: count ? sum / count : 0,
				centroid: total ? weighted / total : 0,
				samples: count,
				contexts: tapped.length,
				// a read that sampled NOTHING is a broken harness, never silence — the
				// vacuous-premise trap, caught by this suite passing with no tap installed
				silent: count > 0 && peak < floor
			};
		},
		{ ms, floor }
	);
}

/**
 * Render a graph deterministically in an OfflineAudioContext and report its
 * envelope — the audio twin of a pixel screenshot, and the only way to compare
 * two peers sample-for-sample without depending on when either one was sampled.
 *
 * `build` is stringified and run IN the page with `(ctx) => void`; connect your
 * sources to `ctx.destination`. Returns per-slice RMS so a caller can compare
 * SHAPE (an attack, a loop boundary, a gate) rather than one number.
 *
 * @param {any} peer @param {(ctx:any)=>void} build
 * @param {{seconds?:number, slices?:number, rate?:number}} [opts]
 * @returns {Promise<{rms:number, peak:number, slices:number[], rate:number}>}
 */
async function renderOffline(peer, build, opts = {}) {
	const { seconds = 1, slices = 16, rate = 44100 } = opts;
	return peer.page.evaluate(
		async ({ source, seconds, slices, rate }) => {
			const context = new OfflineAudioContext(1, Math.round(rate * seconds), rate);
			// eslint-disable-next-line no-eval
			(0, eval)('(' + source + ')')(context);
			const rendered = await context.startRendering();
			const data = rendered.getChannelData(0);
			let square = 0;
			let peak = 0;
			for (let i = 0; i < data.length; i++) {
				square += data[i] * data[i];
				const magnitude = Math.abs(data[i]);
				if (magnitude > peak) peak = magnitude;
			}
			const per = Math.floor(data.length / slices);
			const envelope = [];
			for (let s = 0; s < slices; s++) {
				let slice = 0;
				for (let i = s * per; i < (s + 1) * per; i++) slice += data[i] * data[i];
				envelope.push(Math.sqrt(slice / per));
			}
			return { rms: Math.sqrt(square / data.length), peak, slices: envelope, rate };
		},
		{ source: build.toString(), seconds, slices, rate }
	);
}

/**
 * How far apart two envelopes are — the audio twin of `frameDelta`.
 *
 * Two peers running the same deterministic pattern must agree; `maxDelta` is the
 * number to assert on, because a mean hides one slice being wrong (the same
 * reason `frameDelta` counts changed pixels instead of averaging them).
 *
 * @param {number[]} a @param {number[]} b
 * @returns {{maxDelta:number, meanDelta:number, worstSlice:number}}
 */
function envelopeDelta(a, b) {
	let maxDelta = 0;
	let sum = 0;
	let worstSlice = -1;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const delta = Math.abs(a[i] - b[i]);
		sum += delta;
		if (delta > maxDelta) {
			maxDelta = delta;
			worstSlice = i;
		}
	}
	return { maxDelta, meanDelta: n ? sum / n : 0, worstSlice };
}

module.exports = { URL, GPU_ARGS, check, launch, setupPage, connect, eventually, projectPoint, freshReload, finish, run, installModule, moduleZipPath, makeCollectibleChains, pageErrors, grabFrame, centeredClip, frameDelta, framePixelsOffColor, AUDIO_ARGS, audioMetrics, renderOffline, envelopeDelta };
