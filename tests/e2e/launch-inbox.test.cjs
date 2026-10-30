// 60 Q4 — SHARE INTO THE APP, OPEN FILES FROM THE OS.
//
// The OS halves cannot be driven headlessly (Android's share sheet, a desktop double-click),
// so this drives exactly what they hand the browser:
//   1. Chromium's own verdicts over CDP: the manifest parses with no errors and carries
//      share_target / file_handlers / launch_handler, and the page is INSTALLABLE (which needs
//      the service worker with its fetch handler).
//   2. SHARE = the POST navigation a share sheet makes: a real multipart form submitted to
//      /share-target with the files in `files`. The service worker (static/sw.js — registered
//      by the app on a PROD build, by this suite on a dev server) parks them and 303s to
//      /?shared=<n>; the app collects them once. An image → the Explorer Library; a .glb → an
//      object in the scene; ?shared= leaves the address bar; the inbox cache is gone.
//   3. THE RESTORE RULE: a share that boots onto a "Restore previous session?" prompt WAITS —
//      nothing is imported while the question is open, and after Restore both the restored
//      scene and the shared model are there (imported first, the restore would wipe it).
//   4. FILE HANDLERS = launchQueue: best effort through CDP `PWA.install` +
//      `PWA.launchFilesInApp` (reported, not gating — headless support varies), then through
//      the app's own launchQueue consumer: a .tpscene OPENS (current scene = its name), and a
//      second launch into the same window (focus-existing) imports a .glb INTO it.
//
//   LANE_DEV_CMD=… e2e-slot --dev . 5453 -- env APP_URL=https://localhost:5453/ node tests/e2e/launch-inbox.test.cjs
//   (a built app: LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT')
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DOOR = path.join(ROOT, 'tests/e2e/fixtures/test-door.glb');
const SCENE = path.join(ROOT, 'tests/fixtures/scenes-1.22/fluid-tank-toy.tpscene');
// a 2×2 PNG (a VALID one: the reference-image check decodes it)
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DA0PCfAUIBACFyBP1TVaZ3AAAAAElFTkSuQmCC',
	'base64'
);

/** the scene's top-level object names @param {any} page */
const objectNames = (page) =>
	page.evaluate(() => {
		let names = [];
		window.__stores.objectsGroup.subscribe(
			(g) => (names = g ? g.children.map((c) => c.name) : [])
		)();
		return names;
	});
/** @param {any} page */
const lastLaunch = (page) =>
	page.evaluate(async () => (await window.__stores.launchInbox)?.lastLaunch?.value ?? null);
/** @param {any} page */
const libraryNames = (page) =>
	page.evaluate(async () => {
		const m = await window.__stores.explorer;
		let names = [];
		m.explorerItems.subscribe((v) => (names = v.map((i) => i.name)))();
		return names;
	});

/** make sure a service worker controls the page (a dev server never registers one) @param {any} page */
async function ensureWorker(page) {
	return page.evaluate(async () => {
		if (!('serviceWorker' in navigator)) return 'none';
		if (navigator.serviceWorker.controller) return 'app';
		await navigator.serviceWorker.register('/sw.js');
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise((r) => {
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
				setTimeout(r, 5000);
			});
		return navigator.serviceWorker.controller ? 'suite' : 'none';
	});
}

/**
 * Share files the way a share sheet does: a multipart POST navigation to /share-target.
 * @param {any} page @param {{name: string, mimeType: string, buffer: Buffer}[]} files
 */
async function share(page, files) {
	await page.evaluate(() => {
		document.getElementById('tp-share-form')?.remove();
		const form = Object.assign(document.createElement('form'), {
			id: 'tp-share-form',
			method: 'post',
			action: '/share-target',
			enctype: 'multipart/form-data'
		});
		form.innerHTML =
			'<input type="text" name="title" value="shared"><input type="file" name="files" multiple>';
		form.style.cssText = 'position:fixed;left:-9999px';
		document.body.append(form);
	});
	await page.locator('#tp-share-form input[type=file]').setInputFiles(files);
	await Promise.all([
		page.waitForURL(/[?&]shared=\d+/, { timeout: 30000, waitUntil: 'domcontentloaded' }),
		page.evaluate(() =>
			/** @type {HTMLFormElement} */ (document.getElementById('tp-share-form')).submit()
		)
	]);
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, null, {
		timeout: 90000
	});
}

/** wait until `fn` answers truthy (no assertion — the check after it says what failed)
 * @param {() => Promise<any>} fn @param {number} timeout */
async function until(fn, timeout) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await fn().catch(() => false)) return true;
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

/** @param {any} page */
const inboxCacheExists = (page) => page.evaluate(() => caches.has('tp-share-inbox'));

h.run(async () => {
	// the dev server's certificate is self-signed: pages load past it, but a service worker
	// script fetch is refused unless the browser itself ignores certificate errors
	const browser = await h.launch({ args: ['--ignore-certificate-errors'] });
	const peer = await h.setupPage(browser, 'A');
	const { page } = peer;

	// ---- 1. Chromium's verdicts ---------------------------------------------------------------
	const worker = await ensureWorker(page);
	h.check(worker === 'app' || worker === 'suite', `a service worker controls the page (${worker})`);
	const cdp = await page.context().newCDPSession(page);
	const man = await cdp
		.send('Page.getAppManifest')
		.catch((e) => ({ errors: [{ message: String(e) }] }));
	h.check(
		Array.isArray(man.errors) && man.errors.length === 0,
		'the manifest parses with no errors' +
			(man.errors?.length ? ': ' + JSON.stringify(man.errors) : '')
	);
	const raw = man.data ? JSON.parse(man.data) : {};
	h.check(
		raw.share_target?.action === '/share-target' &&
			raw.file_handlers?.length === 1 &&
			raw.launch_handler?.client_mode?.[0] === 'focus-existing',
		'served manifest carries share_target, file_handlers, launch_handler'
	);
	const inst = await cdp
		.send('Page.getInstallabilityErrors')
		.catch((e) => ({ installabilityErrors: [{ errorId: String(e) }] }));
	h.check(
		(inst.installabilityErrors ?? []).length === 0,
		'Chromium says the app is installable' +
			(inst.installabilityErrors?.length ? ': ' + JSON.stringify(inst.installabilityErrors) : '')
	);
	const appId = await cdp.send('Page.getAppId').catch(() => ({}));
	console.log(
		`  (manifest id: ${appId.appId ?? '?'}; native launchQueue in a tab: ${await page.evaluate(() => 'launchQueue' in window)})`
	);

	// ---- 2. share an image, then a model ------------------------------------------------------
	await share(page, [{ name: 'shared-photo.png', mimeType: 'image/png', buffer: PNG }]);
	await h.answerRestore(peer);
	await until(() => lastLaunch(page), 60000);
	const img = await lastLaunch(page);
	h.check(
		img?.source === 'share' && img?.images === 1,
		'a shared image was received once: ' +
			JSON.stringify(img) +
			' stage ' +
			(await page.evaluate(async () => (await window.__stores.launchInbox)?.lastLaunch?.stage))
	);
	const lib = await libraryNames(page);
	h.check(
		lib.includes('shared-photo.png'),
		'it is in the Explorer Library: ' + JSON.stringify(lib)
	);
	h.check(!/[?&]shared=/.test(page.url()), '?shared= left the address bar: ' + page.url());
	h.check(!(await inboxCacheExists(page)), 'the share inbox cache is gone');
	h.check(
		await page
			.getByText(/shared-photo\.png is in your Library/)
			.first()
			.isVisible()
			.catch(() => false),
		'a toast says where it went (with Show in Library)'
	);
	// 60 Q5: the same toast makes the shared image a reference underlay
	const refBtn = page.getByRole('button', { name: 'Use as reference' }).first();
	const refShown = await refBtn.isVisible().catch(() => false);
	h.check(refShown, 'the toast offers Use as reference');
	// a DOM click: an overlay toast (auto quality) can sit on the button and eat a real one
	if (refShown) await refBtn.dispatchEvent('click').catch((e) => console.log('  (click: ' + e.message + ')'));
	const refs = async () =>
		page.evaluate(async () => (await window.__stores.underlays).underlaysDebug().mine.map((u) => u.name));
	await until(async () => (await refs()).length > 0, 15000);
	h.check(
		(await refs()).length === 1,
		'Use as reference makes it one reference image: ' +
			JSON.stringify(await refs()) +
			' (' +
			(await page.evaluate(async () => (await window.__stores.launchInbox)?.lastLaunch?.reference)) +
			') toasts ' +
			JSON.stringify(await page.locator('.tp-toast').allInnerTexts().catch(() => []))
	);

	await share(page, [
		{ name: 'shared-door.glb', mimeType: 'model/gltf-binary', buffer: fs.readFileSync(DOOR) }
	]);
	await h.answerRestore(peer, 'dismiss');
	await until(async () => (await objectNames(page)).some((n) => /shared-door/.test(n)), 30000);
	const door = await objectNames(page);
	h.check(
		door.some((n) => /shared-door/.test(n)),
		'a shared .glb is imported into the scene: ' + JSON.stringify(door)
	);

	// ---- 3. the restore rule ------------------------------------------------------------------
	await page.evaluate(async () => (await window.__stores.autosave).saveNow());
	await share(page, [
		{ name: 'second-door.glb', mimeType: 'model/gltf-binary', buffer: fs.readFileSync(DOOR) }
	]);
	const offered = await page
		.waitForFunction(
			async () => {
				const m = await window.__stores.autosave;
				let v = null;
				m.restoreAvailable.subscribe((x) => (v = x))();
				return !!v;
			},
			null,
			{ timeout: 20000 }
		)
		.then(() => true)
		.catch(() => false);
	h.check(offered, 'the reload after the share offers "Restore previous session?"');
	await page.waitForTimeout(3000);
	const held = { names: await objectNames(page), launch: await lastLaunch(page) };
	h.check(
		held.names.length === 0 && held.launch === null,
		'while the question is open NOTHING is imported',
		held
	);
	await h.answerRestore(peer, 'restore', 20000);
	await until(async () => {
		const n = await objectNames(page);
		return n.some((x) => /second-door/.test(x)) && n.some((x) => /shared-door/.test(x));
	}, 30000);
	const after = await objectNames(page);
	h.check(
		after.some((n) => /shared-door/.test(n)) && after.some((n) => /second-door/.test(n)),
		'after Restore: the restored door AND the newly shared one: ' + JSON.stringify(after)
	);
	await until(async () => !!(await lastLaunch(page)), 5000);
	h.check((await lastLaunch(page))?.models === 1, 'the share was routed after the answer');

	// ---- 4. file handlers ---------------------------------------------------------------------
	// 4a. best effort: a real install + launch through CDP (Chromium's PWA domain)
	try {
		const bcdp = await browser.newBrowserCDPSession();
		const manifestId = appId.appId || appId.recommendedId;
		await bcdp.send('PWA.install', { manifestId, installUrlOrBundleUrl: h.URL });
		const r = await bcdp.send('PWA.launchFilesInApp', { manifestId, files: [SCENE] });
		console.log(
			`  (CDP PWA.install + launchFilesInApp: ok, targets ${JSON.stringify(r.targetIds ?? r)})`
		);
	} catch (e) {
		console.log(
			`  (CDP PWA.install / launchFilesInApp not available here: ${String(e?.message ?? e).split('\n')[0]} — using the app's launchQueue consumer)`
		);
	}

	// 4b. the app's launchQueue consumer, as Chromium calls it for an installed app window
	const lq = await h.setupPage(browser, 'B', {
		init: () => {
			/** @type {any} */ (window).__lqConsumers = [];
			Object.defineProperty(window, 'launchQueue', {
				configurable: true,
				value: {
					setConsumer: (/** @type {any} */ fn) => /** @type {any} */ (window).__lqConsumers.push(fn)
				}
			});
		}
	});
	await h.answerRestore(lq);
	await lq.page
		.waitForFunction(() => window.__lqConsumers?.length === 1, null, { timeout: 30000 })
		.catch(() => {});
	h.check(
		await lq.page.evaluate(() => window.__lqConsumers?.length === 1),
		'the app set ONE launchQueue consumer'
	);
	/** @param {string} name @param {Buffer} buf */
	const launch = (name, buf) =>
		lq.page.evaluate(
			([n, b64]) => {
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const handle = { kind: 'file', name: n, getFile: async () => new File([bytes], n) };
				window.__lqConsumers[0]({ targetURL: location.href, files: [handle] });
			},
			[name, buf.toString('base64')]
		);
	await launch('fluid-tank-toy.tpscene', fs.readFileSync(SCENE));
	// software GL loads fluid-tank-toy slowly: 30 s / 10 s were red on every local slot (60-union probe)
	await until(async () => (await lastLaunch(lq.page))?.scene === 'fluid-tank-toy.tpscene', 180000);
	await until(
		() =>
			lq.page.evaluate(async () => {
				let v = null;
				(await window.__stores.levels).currentLevel.subscribe((x) => (v = x))();
				return v?.name;
			}),
		60000
	);
	const level = await lq.page.evaluate(async () => {
		const m = await window.__stores.levels;
		let v = null;
		m.currentLevel.subscribe((x) => (v = x))();
		return v;
	});
	const sceneObjects = await objectNames(lq.page);
	h.check(
		!!level?.name && level.unsaved === true && sceneObjects.length > 0,
		`a launched .tpscene OPENS as the current scene ("${level?.name}", unsaved, ${sceneObjects.length} objects)`
	);
	await launch('launched-door.glb', fs.readFileSync(DOOR));
	await until(async () => (await objectNames(lq.page)).some((n) => /launched-door/.test(n)), 30000);
	const into = await objectNames(lq.page);
	h.check(
		into.some((n) => /launched-door/.test(n)) && into.length === sceneObjects.length + 1,
		'a second launch into the same window imports the .glb INTO that scene'
	);
	const levelAfter = await lq.page.evaluate(async () => {
		const m = await window.__stores.levels;
		let v = null;
		m.currentLevel.subscribe((x) => (v = x))();
		return v?.name;
	});
	h.check(levelAfter === level?.name, 'and the scene stayed the current one');
	await launch('notes.txt', Buffer.from('hello'));
	await until(async () => (await lastLaunch(lq.page))?.skipped?.[0] === 'notes.txt', 10000);
	h.check(
		(await objectNames(lq.page)).length === into.length,
		'an unsupported file changes nothing'
	);

	h.check(h.pageErrors(peer).length === 0 && h.pageErrors(lq).length === 0, 'no page errors');
	await h.finish(browser);
});
