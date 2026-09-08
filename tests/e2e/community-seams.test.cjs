// Roadmap #28-A — cloudApi v3: the publish · play · remix seams. Single page, no
// signaling. Two halves, both against the REAL example plugin (static/cloud-plugin-
// example.js), which installs a LOCAL community provider over the bundled template index
// and a "Publish (example)" row under Save:
//   · every seam is INERT without a plugin (the OSS build is byte-identical), and
//   · with the plugin: the sidebar slot sits directly under the Save format segment and
//     the row look reaches it; buildSceneBundle yields a real zip (its central directory
//     is read HERE, in node, from the blob's bytes) with the meta the spec's table defines;
//     loadRemoteScene puts a served .tpscene's objects in the viewport; camera pose /
//     bookmarks / recall; startPlay / stopPlay; setCommunityProvider swaps the Community
//     tab live and null makes it fetch gallery.json again (the OSS path is proven, not
//     assumed); and a `?s=` deep link stands the welcome overlay down.
// Counterfactuals: the provider's `load` is asserted by SWAPPING in one that records the
// click and loads nothing; the deep-link guard is paired with a bare boot that DOES greet.
const h = require('./helpers.cjs');
const { unzipSync, strFromU8 } = require('fflate');
const fs = require('fs');
const path = require('path');

const { check } = h;

/** the bundled fixture scene, as the spec says: session.json + assets/index.json */
function fixture(slug) {
	const bytes = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'templates', slug, 'scene.tpscene'));
	const zip = unzipSync(new Uint8Array(bytes));
	const session = JSON.parse(strFromU8(zip['session.json']));
	return { count: session.count, names: session.objects.map((o) => o.object?.name).filter(Boolean) };
}

/** a 1.0 s 8 kHz 16-bit mono WAV, so `duration` has a number to read — as base64 */
function wavBase64() {
	const rate = 8000;
	const samples = rate; // one second
	const buf = Buffer.alloc(44 + samples * 2);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + samples * 2, 4);
	buf.write('WAVE', 8);
	buf.write('fmt ', 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(rate, 24);
	buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(samples * 2, 40);
	for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2);
	return buf.toString('base64');
}

/** Fresh context with debug stores but a VIRGIN first-run state (the whats-new idiom),
 * opened at `url`. Deliberately not h.setupPage, which pre-sets hasSeenWelcome. */
async function firstVisit(browser, url) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
	});
	const page = await ctx.newPage();
	page.on('pageerror', (err) => console.log('[pageerror] ' + err.stack));
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForFunction(() => window.__stores && !!window.__stores.whatsNew, { timeout: 30000 });
	await page.waitForTimeout(600);
	return { ctx, page };
}

const readStore = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// A hermetic GitHub gallery, installed BEFORE the plugin phase (routes survive reloads).
	// Counted, so "null makes it fetch gallery.json again" is measured, not inferred.
	let galleryFetches = 0;
	await A.page.route('**/raw.githubusercontent.com/theprototype-app/community-gallery/**', (route) => {
		galleryFetches++;
		return route.fulfill({
			json: {
				entries: [
					{
						slug: 'mock-community',
						title: 'Mock Community Scene',
						description: 'From the PR-gated gallery',
						scene: 'scenes/mock-community/scene.tpscene',
						thumb: 'scenes/mock-community/thumb.webp',
						author: 'someone',
						license: 'CC0-1.0'
					}
				]
			}
		});
	});

	// ---------------------------------------------------------------- 1. inert defaults
	const def = await A.page.evaluate((readSrc) => {
		const read = eval(readSrc);
		const c = window.__stores.cloudHooks;
		return {
			version: c.CLOUD_HOOKS_VERSION,
			sidebar: read(c.sidebarSlot),
			provider: read(c.communityProvider),
			notice: read(window.__stores.sceneTemplates.communityNotice),
			deepLink: window.__stores.whatsNew.hasDeepLink()
		};
	}, readStore);
	check(def.version === 3, 'CLOUD_HOOKS_VERSION is 3 (' + def.version + ')');
	check(def.sidebar === null && def.provider === null && def.notice === null, 'A5/A6: sidebar slot, community provider and notice are null without a plugin');
	check(def.deepLink === false, 'A7: a bare open is not a deep link');
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(350);
	check(await A.page.locator('#format-row').isVisible(), 'premise: the logo menu is open and shows the Save format row');
	check((await A.page.locator('#sidebar-cloud-slot').count()) === 0, 'A5: no sidebar slot renders without a plugin');
	await A.page.evaluate(() => window.__stores.closeMenu.set(true));

	// ---------------------------------------------------------- 2. the example plugin
	await A.page.evaluate(() => localStorage.setItem('cloudPluginUrl', '/cloud-plugin-example.js'));
	await h.freshReload(A);
	await A.page.waitForFunction(() => !!window.__cloudApi, { timeout: 20000 });
	const surface = await A.page.evaluate(() => {
		const a = window.__cloudApi;
		const fns = ['buildSceneBundle', 'loadRemoteScene', 'startPlay', 'stopPlay', 'mountSidebar', 'setCommunityProvider'];
		const cam = ['pose', 'setPose', 'bookmarks', 'recall'];
		return {
			version: a.version,
			missing: fns.filter((k) => typeof a[k] !== 'function'),
			camMissing: cam.filter((k) => typeof a.camera?.[k] !== 'function')
		};
	});
	check(surface.version === 3, 'api.version is the hooks version (3)');
	check(surface.missing.length === 0, 'v3 functions present: ' + (surface.missing.length ? 'MISSING ' + surface.missing.join(',') : 'all six'));
	check(surface.camMissing.length === 0, 'camera.* present: ' + (surface.camMissing.length ? 'MISSING ' + surface.camMissing.join(',') : 'pose/setPose/bookmarks/recall'));

	// ---------------------------------------------------- 3. the sidebar slot under Save
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(350);
	const slot = await A.page.evaluate(() => {
		const slot = document.querySelector('#sidebar-cloud-slot');
		const row = document.querySelector('#cloud-publish-row');
		if (!slot || !row) return { slot: !!slot, row: !!row };
		const formatRow = document.querySelector('#format-row');
		const optional = document.querySelector('#format-row-optional');
		const native = document.querySelector('#open-templates');
		const cs = getComputedStyle(row);
		const ncs = getComputedStyle(native);
		return {
			slot: true,
			row: true,
			afterFormat: slot.previousElementSibling === (optional ?? formatRow),
			beforeDivider: !!slot.nextElementSibling?.classList.contains('side-div'),
			display: cs.display,
			padding: cs.padding,
			fontSize: cs.fontSize,
			nativePadding: ncs.padding,
			nativeFontSize: ncs.fontSize,
			width: row.getBoundingClientRect().width,
			nativeWidth: native.getBoundingClientRect().width,
			icoWidth: getComputedStyle(row.querySelector('.side-ico')).width,
			nativeIcoWidth: getComputedStyle(native.querySelector('.side-ico')).width
		};
	});
	check(slot.slot && slot.row, 'A5: the plugin row mounts in #sidebar-cloud-slot');
	check(slot.afterFormat, 'A5: the slot sits DIRECTLY under the Save format segment');
	check(slot.beforeDivider, 'A5: ...and above the section divider');
	check(
		slot.display === 'flex' && slot.padding === slot.nativePadding && slot.fontSize === slot.nativeFontSize,
		`A5: the .side-row look reaches the plugin button — computed, not the class string (${slot.display} ${slot.padding} ${slot.fontSize} vs native ${slot.nativePadding} ${slot.nativeFontSize})`
	);
	check(Math.abs(slot.width - slot.nativeWidth) < 1.5, `A5: the plugin row spans the menu like a native row (${slot.width} vs ${slot.nativeWidth})`);
	check(slot.icoWidth === slot.nativeIcoWidth, 'A5: the .side-ico column matches the native rows (' + slot.icoWidth + ')');
	await A.page.evaluate(() => window.__stores.closeMenu.set(true));

	// ------------------------------------------- 4. buildSceneBundle on a 3-object scene
	await A.page.evaluate(() => {
		for (let i = 0; i < 3; i++) window.__stores.commandsHandler.sceneCommand('/create box');
	});
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children?.length ?? 0))())),
		(n) => n === 3,
		'premise: three objects in the scene'
	);
	// an ASSET the scene references: a music track from the Explorer (sceneAssets lists it)
	const music = await A.page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const item = await window.__stores.explorer.addItemFromBytes(bytes, 'tone.wav', null);
		window.__stores.sceneMusic.setMusicTrack(item.hash, 'tone.wav');
		return { hash: item.hash, name: item.name };
	}, wavBase64());
	check(!!music.hash, 'premise: a wav is in the Explorer and set as the scene music (' + String(music.hash).slice(0, 8) + ')');

	const before = await A.page.evaluate((readSrc) => {
		const read = eval(readSrc);
		return {
			level: read(window.__stores.levels.currentLevel),
			sessions: (read(window.__stores.sessions.sessions) ?? []).length,
			items: (read(window.__stores.explorer.explorerItems) ?? []).length
		};
	}, readStore);

	const bundle = await A.page.evaluate(async () => {
		const { blob, meta } = await window.__cloudApi.buildSceneBundle({});
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let bin = '';
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return { type: blob.type, size: blob.size, b64: btoa(bin), meta };
	});
	const zipBytes = Buffer.from(bundle.b64, 'base64');
	const zip = unzipSync(new Uint8Array(zipBytes));
	const names = Object.keys(zip).sort();
	check(bundle.type === 'application/zip', 'A1: the blob is application/zip');
	check(!!zip['session.json'], `A1: the zip's central directory lists session.json (${names.join(', ')})`);
	check(!!zip['assets/index.json'], 'A1: ...and assets/index.json');
	const assetEntry = names.find((n) => n.startsWith('assets/' + music.hash));
	check(!!assetEntry, 'A1: ...and the referenced asset by content hash (' + assetEntry + ')');
	const session = zip['session.json'] ? JSON.parse(strFromU8(zip['session.json'])) : {};
	check(session.count === 3 && (session.objects ?? []).length === 3, 'A1: session.json carries the three objects');
	check(session.music?.hash === music.hash, 'A1: session.json carries the music reference');
	const m = bundle.meta;
	check(m.objectCount === 3, 'A1 meta.objectCount = 3 (' + m.objectCount + ')');
	check(m.hasFlow === false, 'A1 meta.hasFlow is FALSE for the empty graphs.scene every scene carries');
	check(m.hasAudio === true, 'A1 meta.hasAudio is true (music track)');
	check(m.hasGame === false, 'A1 meta.hasGame is false (no game shell)');
	check(Array.isArray(m.modules) && m.modules.length === 0, 'A1 meta.modules = [] (nothing needed)');
	check(/^\d+\.\d+\.\d+/.test(String(m.appVersion)), 'A1 meta.appVersion is the app version (' + m.appVersion + ')');
	check(m.bytes === bundle.size && m.bytes === zipBytes.length, `A1 meta.bytes is blob.size (${m.bytes} = ${zipBytes.length})`);
	check(Array.isArray(m.camera?.position) && m.camera.position.length === 3 && Array.isArray(m.camera?.target), 'A1 meta.camera = {position, target}');
	check(typeof m.duration === 'number' && Math.abs(m.duration - 1.0) < 0.1, 'A1 meta.duration reads the track length (' + m.duration + ' s of a 1.0 s wav)');
	check(Array.isArray(m.files) && m.files[0]?.own === true && m.files[0]?.objects === 3, 'A1 meta.files is sessionFileList (own scene row first)');

	const after = await A.page.evaluate((readSrc) => {
		const read = eval(readSrc);
		return {
			level: read(window.__stores.levels.currentLevel),
			sessions: (read(window.__stores.sessions.sessions) ?? []).length,
			items: (read(window.__stores.explorer.explorerItems) ?? []).length
		};
	}, readStore);
	check(
		after.level === before.level && after.sessions === before.sessions && after.items === before.items,
		'A1: buildSceneBundle SAVES NOTHING — currentLevel, sessions and the library are untouched'
	);

	// hasFlow flips on the first real NODE; `flow: false` strips it from bundle AND meta
	await A.page.evaluate(() => {
		window.__stores.flowNodes.set([{ id: 'seam-n1', type: 'number', position: { x: 0, y: 0 }, data: { value: 1 } }]);
	});
	await A.page.waitForTimeout(200);
	const flowMeta = await A.page.evaluate(async () => {
		const withFlow = await window.__cloudApi.buildSceneBundle({});
		const without = await window.__cloudApi.buildSceneBundle({ flow: false });
		return { withFlow: withFlow.meta.hasFlow, without: without.meta.hasFlow };
	});
	check(flowMeta.withFlow === true, 'A1 meta.hasFlow is true once a graph has a node');
	check(flowMeta.without === false, 'A1 meta.hasFlow is false for a bundle built with flow:false');
	await A.page.evaluate(() => window.__stores.flowNodes.set([]));

	// ------------------------------------------------ 5. loadRemoteScene, a served file
	const blockout = fixture('level-blockout');
	const loaded = await A.page.evaluate(() =>
		window.__cloudApi.loadRemoteScene({ sceneUrl: '/templates/level-blockout/scene.tpscene', title: 'Level blockout', slug: 'level-blockout' })
	);
	check(loaded === true, 'A2: loadRemoteScene resolves true');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))())),
		(list) => list.length === blockout.count && blockout.names.every((n) => list.includes(n)),
		`A2: the served .tpscene's ${blockout.count} objects are in the viewport (${blockout.names.slice(0, 3).join(', ')}…)`
	);
	check(
		(await A.page.evaluate(() => window.__cloudApi.loadRemoteScene({ title: 'nothing' }))) === false,
		'A2: no sceneUrl -> false'
	);

	// ------------------------------------------------------------------ 6. the camera
	const cam = await A.page.evaluate(async () => {
		const c = window.__cloudApi.camera;
		const p0 = c.pose();
		const ok = c.setPose({ position: [5, 4, 6], target: [0, 1, 0] });
		const p1 = c.pose();
		await new Promise((r) => setTimeout(r, 350)); // two frames: OrbitControls must not revert it
		const p2 = c.pose();
		const bm = window.__stores.cameraBookmarks.saveBookmark('Hero shot');
		const list = c.bookmarks();
		c.setPose({ position: [-3, 2, -3], target: [0, 0, 0] });
		const recalled = c.recall(bm.id);
		const p3 = c.pose();
		window.__stores.cameraBookmarks.deleteBookmark(bm.id);
		const gone = c.recall(bm.id);
		const bad = c.setPose({ position: [1, 2], target: null });
		return { p0, ok, p1, p2, bm: { id: bm.id, name: bm.name }, list, recalled, p3, gone, bad };
	});
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	check(Array.isArray(cam.p0?.position) && cam.p0.position.length === 3 && Array.isArray(cam.p0?.target), 'A3 camera.pose() -> {position, target}');
	check(cam.ok === true && dist(cam.p1.position, [5, 4, 6]) < 0.01 && dist(cam.p1.target, [0, 1, 0]) < 0.01, 'A3 camera.setPose moves both ends');
	check(dist(cam.p2.position, cam.p1.position) < 0.01, 'A3 the pose HOLDS across frames (OrbitControls did not revert it)');
	check(cam.list.some((b) => b.id === cam.bm.id && b.name === 'Hero shot') && Object.keys(cam.list[0]).sort().join() === 'id,name', 'A3 camera.bookmarks() lists {id, name} only');
	check(cam.recalled === true && dist(cam.p3.position, [5, 4, 6]) < 0.01, 'A3 camera.recall(id) jumps to the saved view');
	check(cam.gone === false, 'A3 camera.recall returns FALSE for a deleted bookmark');
	check(cam.bad === false, 'A3 camera.setPose refuses a malformed pose');

	// ------------------------------------------------------------- 7. play mode seams
	const started = await A.page.evaluate(() => window.__cloudApi.startPlay());
	check(started === true, 'A4 startPlay() returns true');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))())),
		(v) => v === true,
		'A4 startPlay enters play mode (isLocked === true, no pointer lock needed)'
	);
	const stopped = await A.page.evaluate(() => window.__cloudApi.stopPlay());
	check(stopped === true, 'A4 stopPlay() returns true when we were playing');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))())),
		(v) => v !== true,
		'A4 stopPlay leaves play mode'
	);
	await A.page.waitForTimeout(300);
	check((await A.page.evaluate(() => window.__cloudApi.stopPlay())) === false, 'A4 stopPlay() returns false when not playing');

	// ---------------------------------------------------- 8. the community provider
	await A.page.evaluate(() => window.__stores.templatesModalOpen.set(true));
	await A.page.waitForTimeout(400);
	await A.page.locator('#templates-tab-community').click();
	await h.eventually(
		() => A.page.locator('#templates-modal [data-scene-slug]').count(),
		(n) => n === 3,
		'A6: the Community tab lists the provider rows (3 bundled templates)'
	);
	const provided = await A.page.evaluate(() => {
		const modal = document.querySelector('#templates-modal');
		const submit = document.querySelector('#community-submit');
		return {
			notice: document.querySelector('#community-notice')?.textContent?.trim() ?? '',
			submitTag: submit?.tagName,
			submitText: submit?.textContent?.trim(),
			prCopy: /pull request/i.test(modal?.textContent ?? ''),
			likes: modal.querySelectorAll('.tpl-likes').length,
			remix: modal.querySelectorAll('.tpl-remix').length,
			slugs: [...modal.querySelectorAll('[data-scene-slug]')].map((el) => el.getAttribute('data-scene-slug'))
		};
	});
	check(provided.notice.includes('Community (example)'), 'A6: the provider\'s notice row renders above the grid');
	check(provided.submitTag === 'BUTTON' && provided.submitText === 'Publish from the app (example)', 'A6: "Submit yours on GitHub" is swapped for the provider\'s submit action');
	check(provided.prCopy === false, 'A6: the pull-request copy stands down while a provider is installed');
	check(provided.likes === 3 && provided.remix === 1, `A6: cards render likeCount/remixOf only when present (${provided.likes} likes badges, ${provided.remix} remix)`);
	check(provided.slugs.includes('level-blockout') && provided.slugs.includes('physics-playground'), 'A6: the rows are the bundled index entries');
	galleryFetches = 0;

	// swap the provider LIVE while the tab shows: the list follows, and a click reaches
	// the PROVIDER's load (it records the slug and loads nothing — the scene must not move)
	await A.page.evaluate(() => {
		window.__providerLoaded = null;
		window.__cloudApi.setCommunityProvider({
			list: async () => [
				{ slug: 'prov-a', title: 'Provider A', scene: '/templates/level-blockout/scene.tpscene', author: 'x', license: 'MIT' },
				{ slug: 'prov-b', title: 'Provider B', sceneUrl: 'https://example.com/b.tpscene', likeCount: 0 }
			],
			load: async (entry) => {
				window.__providerLoaded = entry.slug;
				return true;
			}
		});
	});
	await h.eventually(
		() => A.page.evaluate(() => [...document.querySelectorAll('#templates-modal [data-scene-slug]')].map((el) => el.getAttribute('data-scene-slug'))),
		(slugs) => slugs.length === 2 && slugs.includes('prov-a') && slugs.includes('prov-b'),
		'A6: setCommunityProvider swaps the tab\'s list LIVE (2 provider rows)'
	);
	const swapped = await A.page.evaluate(() => ({
		notice: document.querySelector('#community-notice'),
		submit: document.querySelector('#community-submit')?.textContent?.trim(),
		likes: document.querySelectorAll('#templates-modal .tpl-likes').length
	}));
	check(swapped.notice === null, 'A6: a provider with no notice() renders no notice row');
	check(swapped.submit === 'Submit yours on GitHub', 'A6: a provider with no submit keeps the GitHub link');
	check(swapped.likes === 1, 'A6: likeCount 0 still renders (present), absent does not');
	const namesBefore = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))()));
	await A.page.locator('#templates-modal [data-scene-slug="prov-a"]').click();
	await h.eventually(
		() => A.page.evaluate(() => window.__providerLoaded),
		(v) => v === 'prov-a',
		'A6: a card click goes to the PROVIDER\'s load(entry)'
	);
	await A.page.waitForTimeout(600);
	const namesAfter = await A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))()));
	check(JSON.stringify(namesAfter) === JSON.stringify(namesBefore), 'A6: ...and core did NOT fall through to its own loader (scene unchanged)');
	check(galleryFetches === 0, 'A6: no gallery.json fetch while a provider is installed');

	// null RESTORES the GitHub source: the tab fetches gallery.json again and shows it
	await A.page.evaluate(() => window.__stores.templatesModalOpen.set(true));
	await A.page.waitForTimeout(300);
	await A.page.locator('#templates-tab-community').click();
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => window.__cloudApi.setCommunityProvider(null));
	await h.eventually(
		() => A.page.evaluate(() => [...document.querySelectorAll('#templates-modal [data-scene-slug]')].map((el) => el.getAttribute('data-scene-slug'))),
		(slugs) => slugs.length === 1 && slugs[0] === 'mock-community',
		'A6: setCommunityProvider(null) makes the tab show gallery.json\'s rows again'
	);
	check(galleryFetches >= 1, 'A6: ...by FETCHING gallery.json (' + galleryFetches + ' request)');
	const restored = await A.page.evaluate(() => {
		const submit = document.querySelector('#community-submit');
		return {
			provider: (() => { let v; window.__stores.cloudHooks.communityProvider.subscribe((x) => (v = x))(); return v; })(),
			submitTag: submit?.tagName,
			href: submit?.getAttribute('href'),
			prCopy: /pull request/i.test(document.querySelector('#templates-modal')?.textContent ?? ''),
			notice: document.querySelector('#community-notice')
		};
	});
	check(restored.provider === null, 'A6: the provider store reads null');
	check(restored.submitTag === 'A' && restored.href === 'https://github.com/theprototype-app/community-gallery', 'A6: the GitHub submit link is back');
	check(restored.prCopy === true && restored.notice === null, 'A6: the pull-request copy is back and no notice row remains');
	await A.page.evaluate(() => window.__stores.templatesModalOpen.set(false));

	// --------------------------------------------------------- 9. unload -> inert again
	await A.page.evaluate(() => localStorage.removeItem('cloudPluginUrl'));
	await h.freshReload(A);
	await A.page.waitForTimeout(400);
	const inert = await A.page.evaluate((readSrc) => {
		const read = eval(readSrc);
		window.__stores.closeMenu.set(false);
		return {
			api: typeof window.__cloudApi,
			sidebar: read(window.__stores.cloudHooks.sidebarSlot),
			provider: read(window.__stores.cloudHooks.communityProvider)
		};
	}, readStore);
	await A.page.waitForTimeout(350);
	check(inert.api === 'undefined' && inert.sidebar === null && inert.provider === null, 'unloading the plugin restores inert defaults');
	check((await A.page.locator('#sidebar-cloud-slot').count()) === 0, 'A5: no slot in the menu once the plugin is gone');
	await A.ctx.close();

	// ------------------------------------------- 10. a scene deep link and What's New
	// the bare boot FIRST, so the absence below cannot pass vacuously
	const bare = await firstVisit(browser, h.URL);
	check(await bare.page.locator('#welcome-overlay').isVisible(), 'A7 premise: a bare first visit shows the welcome overlay');
	check((await bare.page.evaluate(() => window.__stores.whatsNew.hasDeepLink())) === false, 'A7: hasDeepLink() is false on a bare open');
	await bare.ctx.close();
	const linked = await firstVisit(browser, h.URL + '?s=x');
	check((await linked.page.evaluate(() => window.__stores.whatsNew.hasDeepLink())) === true, 'A7: hasDeepLink() is true for /?s=x');
	check(!(await linked.page.locator('#welcome-overlay').isVisible()), 'A7: /?s=x suppresses the first-visit welcome overlay');
	check(
		(await linked.page.evaluate(() => localStorage.getItem('hasSeenWelcome'))) === null,
		'A7: ...and only DEFERS it — the next bare visit still greets (hasSeenWelcome unset)'
	);
	await linked.ctx.close();

	await h.finish(browser);
});
