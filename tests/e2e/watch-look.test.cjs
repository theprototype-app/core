// P2 — WATCH ADOPTS THE WATCHED PEER'S LOOK.
//
// Watching a peer adopts their camera; this makes it adopt their LOOK STATE too: the
// camera they look through (and its own look), their view mode, their local post
// switch and their Set Look overrides. Presence, the `campreview` shape — never data,
// never saved, dropped on disconnect, and scoped to the watch: nothing of theirs is
// ever written into the watcher's own settings.
//
// The compiled chain (`__postDebug().kinds`) is the thing measured, because it is
// what the composer will draw; `adoptedFrom` says WHOSE state it came from.

const h = require('./helpers.cjs');

/** register two visible test effects through the public registry seam */
async function registerFills(page) {
	return page.evaluate(() => {
		const { Effect, BlendFunction } = window.__stores.postprocessing;
		const fill = (name, rgb) =>
			new Effect(
				name,
				'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(' +
					rgb +
					', 1.0); }',
				{ blendFunction: BlendFunction.SET }
			);
		window.__stores.scenePost.registerPostEffect('fill-red', {
			label: 'Fill red',
			group: 'test',
			make: () => fill('FillRed', '1.0, 0.0, 0.0')
		});
		window.__stores.scenePost.registerPostEffect('fill-blue', {
			label: 'Fill blue',
			group: 'test',
			make: () => fill('FillBlue', '0.0, 0.0, 1.0')
		});
		return window.__stores.scenePost.postEffectKinds().map((d) => d.kind);
	});
}

const chainOf = (page) => page.evaluate(() => window.__postDebug().kinds.join(','));
const adoptedFrom = (page) => page.evaluate(() => window.__postDebug().adoptedFrom);
const rowsOn = (page) =>
	page.evaluate(() => {
		let map = null;
		window.__stores.lookPresence.peerLooks.subscribe((m) => (map = m))();
		return map;
	});
const bannerNote = (page) =>
	page.evaluate(() => document.querySelector('.spectator-note')?.textContent?.trim() ?? '');
const watching = (page) =>
	page.evaluate(() => {
		let v = null;
		window.__stores.specatorMode.subscribe((x) => (v = x))();
		return v;
	});
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Press the real Watch button for the ONE remote peer in the popover.
 *
 * `.peer-watch` is worn by TWO buttons: the Watch button, and the join-a-peer's-camera
 * button beside it (`.peer-watch.peer-preview`), which only renders while that peer is
 * previewing a camera — which is exactly the fixture this suite builds. A bare
 * `.peer-watch` selector therefore picked the JOIN button and B previewed A's camera
 * instead of watching A: every reading came out "fill-blue" (the right answer for the
 * wrong reason) and nothing followed A afterwards. Select by exclusion, and assert the
 * count so a third button in that row can never quietly take the click.
 */
async function pressWatch(peer) {
	await peer.page.evaluate(() => document.querySelector('#peers-trigger').click());
	await settle(400);
	return peer.page.evaluate(() => {
		const box = document.querySelector('#peers-popover');
		const all = box ? [...box.querySelectorAll('.peer-watch')] : [];
		const watch = all.filter((b) => !b.classList.contains('peer-preview') && !b.disabled);
		if (watch.length !== 1) return { ok: false, buttons: all.map((b) => b.className) };
		watch[0].click();
		return { ok: true, buttons: all.map((b) => b.className) };
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await registerFills(A.page);
	await registerFills(B.page);

	// ---------------------------------------------------------------- section 0
	console.log('\n=== 0. the fixture: a scene look, a camera with a replace look ===');
	const camUuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		window.__stores.commandsHandler.sceneCommand('/create camera');
		await new Promise((r) => setTimeout(r, 1200));
		return window.__stores.cameraObjects.listCameraObjects()[0]?.uuid ?? '';
	});
	h.check(!!camUuid, '0.1 premise: a camera object exists');
	await A.page.evaluate(async (cam) => {
		const post = window.__stores.scenePost;
		post.postStacks.set({});
		post.addPostEffect('fill-red');
		post.addPostEffect('fill-blue', undefined, cam);
		post.setCameraLookMode(cam, 'replace');
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
	}, camUuid);
	await B.page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
	});
	await settle(1200);
	h.check((await chainOf(A.page)) === 'fill-red', '0.2 premise: A renders the scene look (' + (await chainOf(A.page)) + ')');

	await h.connect(B, A);
	await h.eventually(
		() => chainOf(B.page),
		(c) => c === 'fill-red',
		'0.3 the scene look reaches B over the handshake and B renders it',
		25000
	);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the row: handshake reply and live change ===');
	await h.eventually(
		() => rowsOn(B.page),
		(m) => !!m[A.id],
		'1.1 B holds a look-state row for A after the handshake (rides getmodulestate)',
		15000
	);
	const rowA = (await rowsOn(B.page))[A.id];
	h.check(
		rowA.mode === 'shaded' && rowA.camera === null && rowA.overrides.post === true,
		'1.2 ...carrying A\'s view mode, no camera, post on: ' + JSON.stringify(rowA)
	);
	h.check(!!(await rowsOn(A.page))[B.id], '1.3 ...and A holds one for B (both directions)');

	await A.page.evaluate((cam) => window.__stores.cameraPreview.startCameraPreview(cam), camUuid);
	await h.eventually(
		() => chainOf(A.page),
		(c) => c === 'fill-blue',
		'1.4 premise: A looks through the camera and renders its replace look',
		8000
	);
	await h.eventually(
		() => rowsOn(B.page),
		(m) => m[A.id]?.camera === camUuid,
		'1.5 the camera change reaches B\'s row (sent on change, no timer)',
		8000
	);
	h.check((await chainOf(B.page)) === 'fill-red', '1.6 ...and B, not watching, still renders ITS OWN chain');
	h.check((await adoptedFrom(B.page)) === '', '1.7 ...adopted from nobody');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. B watches A: the chain follows A\'s state ===');
	// the REAL opener: the peers popover's Watch button
	const pressed = await pressWatch(B);
	h.check(
		pressed.ok,
		'2.1 premise: exactly one Watch button (not the join-camera one) was there and clicked: ' +
			JSON.stringify(pressed.buttons)
	);
	await h.eventually(
		() => watching(B.page),
		(v) => v === A.id,
		'2.2 B is watching A (not previewing its camera)',
		5000
	);
	await h.eventually(
		() => chainOf(B.page),
		(c) => c === 'fill-blue',
		'2.3 B renders A\'s camera look (the camera A looks through, replace mode)',
		8000
	);
	h.check((await adoptedFrom(B.page)) === A.id, '2.4 ...and the chain says it came from A');
	h.check((await bannerNote(B.page)) === '', '2.5 the banner has nothing to warn about');

	// a Set Look override on A (the setlook node's write) is A's runtime state, not ours
	await A.page.evaluate((cam) => window.__stores.scenePost.setLookOverride(cam, false), camUuid);
	await h.eventually(() => chainOf(A.page), (c) => c === '', '2.6 premise: A switched its camera look off', 5000);
	await h.eventually(() => chainOf(B.page), (c) => c === '', '2.7 B follows A\'s Set Look override', 8000);
	const bOwn = await B.page.evaluate(() => {
		let over = null;
		window.__stores.scenePost.lookOverride.subscribe((m) => (over = m))();
		return Object.keys(over).length;
	});
	h.check(bOwn === 0, '2.8 ...without writing anything into B\'s own override map');
	await A.page.evaluate((cam) => window.__stores.scenePost.clearLookOverride(cam), camUuid);
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-blue', '2.9 ...and back when A clears it', 8000);

	// A's LOCAL post switch
	await A.page.evaluate(() => window.__stores.viewportOverrides.setRenderLayer('post', false));
	await h.eventually(() => chainOf(B.page), (c) => c === '', '2.10 B follows A\'s local "scene look off"', 8000);
	h.check(
		/switched off/.test(await bannerNote(B.page)),
		'2.11 ...and the banner SAYS so ("' + (await bannerNote(B.page)) + '")'
	);
	const bLayer = await B.page.evaluate(() => window.__stores.viewportOverrides.renderLayer('post'));
	h.check(bLayer === true, '2.12 ...B\'s own post switch untouched');
	await A.page.evaluate(() => window.__stores.viewportOverrides.setRenderLayer('post', true));
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-blue', '2.13 ...and back', 8000);

	// A's VIEW MODE (wireframe skips post for them, so for us while watching)
	await A.page.evaluate(() => window.__stores.viewMode.set('wireframe'));
	await h.eventually(() => chainOf(B.page), (c) => c === '', '2.14 B follows A\'s wireframe (no post)', 8000);
	const bMode = await B.page.evaluate(() => {
		let v = null;
		window.__stores.viewMode.subscribe((x) => (v = x))();
		return v;
	});
	h.check(bMode === 'shaded', '2.15 ...B\'s own view mode untouched (' + bMode + ')');
	await A.page.evaluate(() => window.__stores.viewMode.set('shaded'));
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-blue', '2.16 ...and back', 8000);

	// A leaves the camera: the scene look again
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-red', '2.17 A stops previewing: B follows to the scene look', 8000);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. B stops watching: its own state again ===');
	// B's own comfort setting differs from A's — while watching, A's wins
	await B.page.evaluate(() => window.__stores.viewportOverrides.setRenderLayer('post', false));
	await settle(800);
	h.check((await chainOf(B.page)) === 'fill-red', '3.1 while watching, B\'s own post switch does not apply (A\'s state wins)');
	// the WATCH banner's Exit — `.spectator-exit` is also the camera-preview banner's, and
	// that one is `.spectator-banner.preview-banner` (the same trap as `.peer-watch` above)
	const exited = await B.page.evaluate(() => {
		const btn = document.querySelector('.spectator-banner:not(.preview-banner) .spectator-exit');
		if (!btn) return false;
		btn.click();
		return true;
	});
	h.check(exited, '3.2 premise: the WATCH banner\'s Exit was there and clicked');
	await h.eventually(() => watching(B.page), (v) => !v, '3.3 B stopped watching', 5000);
	await h.eventually(() => chainOf(B.page), (c) => c === '', '3.4 B reverts to its OWN state (post off)', 8000);
	h.check((await adoptedFrom(B.page)) === '', '3.5 ...adopted from nobody');
	await B.page.evaluate(() => window.__stores.viewportOverrides.setRenderLayer('post', true));
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-red', '3.6 ...and its own look is back', 8000);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. an absent row (an older build) falls back to our own ===');
	await A.page.evaluate((cam) => window.__stores.cameraPreview.startCameraPreview(cam), camUuid);
	await h.eventually(() => rowsOn(B.page), (m) => m[A.id]?.camera === camUuid, '4.1 premise: A is on the camera again', 8000);
	const pressed2 = await pressWatch(B);
	h.check(pressed2.ok, '4.2a premise: the Watch button was there again');
	await h.eventually(
		() => watching(B.page),
		(v) => v === A.id,
		'4.2b premise: B is watching A again',
		5000
	);
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-blue', '4.2 premise: B adopts fill-blue', 8000);
	// simulate a peer that never sent a row: drop it locally
	await B.page.evaluate((id) => window.__stores.lookPresence.dropPeerLook(id), A.id);
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-red', '4.3 no row: B renders its OWN chain', 8000);
	h.check((await adoptedFrom(B.page)) === '', '4.4 ...adopted from nobody');
	h.check(
		/your own look/.test(await bannerNote(B.page)),
		'4.5 ...and the banner says so ("' + (await bannerNote(B.page)) + '")'
	);
	await A.page.evaluate(() => window.__stores.lookPresence.publishLookState(true));
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-blue', '4.6 the row returning re-adopts', 8000);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. A disconnects mid-watch: nothing stranded ===');
	await A.page.evaluate(() => {
		let p = null;
		window.__stores.peers.subscribe((v) => (p = v))();
		p.leaveSession();
	});
	await h.eventually(() => rowsOn(B.page), (m) => !m[A.id], '5.1 B drops A\'s row on disconnect', 20000);
	await h.eventually(() => chainOf(B.page), (c) => c === 'fill-red', '5.2 ...and renders its own chain again', 8000);
	h.check((await adoptedFrom(B.page)) === '', '5.3 ...adopted from nobody (no stranded state)');
	h.check(h.pageErrors(B).length === 0, '5.4 no page errors on B (' + h.pageErrors(B).length + ')');

	await h.finish(browser);
});
