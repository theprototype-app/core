// 21-D5 — HUD visibility, and HUDs attached to cameras.
//
// Two questions the user asked, answered by two separate switches on purpose:
//
//   * "why do I immediately see the HUD in the viewport while building it?" — you do not
//     any more: while the HUD editor is open you author on the ARTBOARD and the viewport
//     stays clean, with an eye toggle to show it anyway. That is the AUTHORING session.
//   * `viewportOverrides.hud` is the separate, persistent LOCAL kill switch every authored
//     layer gets. This is `renderLayer()`'s first real consumer — it had zero callers.
//
// And camera attachment, which needed no new concept at all: `hudDocs` was already keyed
// `'scene' | objectUuid`, so a document keyed by a camera marker's uuid renders only while
// that camera is being looked through.
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-visibility
const h = require('./helpers.cjs');

const layerUp = (page) => page.evaluate(() => !!document.querySelector('#hud-layer'));
const shown = (page) =>
	page.evaluate(() => [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent?.trim()));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.viewportOverrides, { timeout: 30000 });

	// ---- 1. the `hud` override key exists, and defaults to ON ---------------
	const key = await page.evaluate(() => {
		const V = window.__stores.viewportOverrides;
		return {
			declared: V.OVERRIDES.map((o) => o.key),
			hudEntry: V.OVERRIDES.find((o) => o.key === 'hud') ?? null,
			// absent means ON — the module's own polarity rule, so a layer nobody switched
			// off is never accidentally hidden
			on: V.renderLayer('hud')
		};
	});
	h.check(key.declared.includes('hud'), `viewportOverrides declares a 'hud' key (${key.declared.join(', ')})`);
	h.check(!!key.hudEntry?.label && !!key.hudEntry?.hint, 'with a label and a hint, so it renders in the Inspector list');
	h.check(key.on === true, 'and defaults to ON — nobody opts in to seeing the scene');

	// ---- 2. with the editor CLOSED the HUD renders -------------------------
	await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		window.__stores.hudEditorClose.set(true);
		H.clearHudDocs();
		H.setHudDocFor('scene', {
			screens: [{ id: 'main', name: 'Main', elements: [{ id: 'score', kind: 'text', label: 'SCENE HUD', anchor: 'top-left', x: 20, y: 20 }] }],
			active: 'main'
		});
	});
	await page.waitForTimeout(900);
	h.check(await layerUp(page), 'with the editor closed the HUD renders in the viewport');
	h.check((await shown(page)).includes('SCENE HUD'), 'with its elements');

	// ---- 3. THE ANSWER: opening the editor clears the viewport --------------
	const authoring = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudPreviewInViewport ?? null;
		s.hudDocs.hudPreviewInViewport.set(false);
		s.hudEditorClose.set(false);
		s.bottomDock.activateDock('hud');
		await new Promise((r) => setTimeout(r, 1200));
		return {
			viewport: !!document.querySelector('#hud-layer'),
			// but the ARTBOARD still shows it — that is where you author
			board: document.querySelectorAll('#hud-board [data-hud-item]').length
		};
	});
	h.check(
		!authoring.viewport,
		'OPENING THE HUD EDITOR clears the viewport — you author on the artboard, not over the scene'
	);
	h.check(authoring.board > 0, `and the artboard still shows the element (${authoring.board})`);

	// the eye toggle brings it back, for a final look
	const eye = await page.evaluate(async () => {
		document.querySelector('#hud-preview-toggle')?.click();
		await new Promise((r) => setTimeout(r, 700));
		const on = !!document.querySelector('#hud-layer');
		const pressed = document.querySelector('#hud-preview-toggle')?.getAttribute('aria-pressed');
		document.querySelector('#hud-preview-toggle')?.click();
		await new Promise((r) => setTimeout(r, 700));
		return { on, pressed, offAgain: !document.querySelector('#hud-layer') };
	});
	h.check(eye.on, 'the eye toggle shows it in the viewport anyway');
	h.check(eye.pressed === 'true', 'and reports itself pressed');
	h.check(eye.offAgain, 'and toggles back off');

	// the preference PERSISTS (it is a local pref, like every other view pref)
	const persisted = await page.evaluate(() => localStorage.getItem('hudPreviewInViewport'));
	h.check(persisted === 'false', `the choice persists locally (${persisted})`);

	// ---- 4. renderLayer('hud') is the persistent kill switch ---------------
	// Proven with the editor CLOSED, so the authoring rule cannot be what hides it.
	const killed = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 800));
		const before = !!document.querySelector('#hud-layer');
		s.viewportOverrides.setRenderLayer('hud', false);
		await new Promise((r) => setTimeout(r, 800));
		const after = !!document.querySelector('#hud-layer');
		s.viewportOverrides.setRenderLayer('hud', true);
		await new Promise((r) => setTimeout(r, 800));
		return { before, after, restored: !!document.querySelector('#hud-layer') };
	});
	h.check(killed.before, 'premise: the HUD is up with the editor closed');
	h.check(!killed.after, 'switching the `hud` override OFF hides it — renderLayer()`s first real consumer');
	h.check(killed.restored, 'and switching it back on restores it');

	// ---- 5. CAMERA-ATTACHED HUDs ------------------------------------------
	// The document keyed by a camera's uuid renders ONLY while that camera is looked
	// through. No new field: hudDocs was already keyed 'scene' | objectUuid.
	const cam = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 1800));
		const list = s.cameraObjects.listCameraObjects();
		if (!list.length) return null;
		const uuid = list[0].uuid;
		// author a HUD ON that camera
		s.hudDocs.setHudDocFor(uuid, {
			screens: [{ id: 'main', name: 'Main', elements: [{ id: 'cam-only', kind: 'text', label: 'CAMERA HUD', anchor: 'center' }] }],
			active: 'main'
		});
		await new Promise((r) => setTimeout(r, 800));
		return { uuid, name: list[0].name };
	});
	h.check(!!cam, `premise: a camera object exists (${cam?.name})`);

	const beforeLook = await shown(page);
	h.check(
		beforeLook.includes('SCENE HUD') && !beforeLook.includes('CAMERA HUD'),
		`a camera HUD does NOT show in the free editor view (${JSON.stringify(beforeLook)})`
	);

	const looking = await page.evaluate(async (uuid) => {
		window.__stores.cameraPreview.startCameraPreview(uuid);
		await new Promise((r) => setTimeout(r, 1400));
		return [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent?.trim());
	}, cam.uuid);
	h.check(
		looking.includes('CAMERA HUD'),
		`looking THROUGH that camera shows its HUD (${JSON.stringify(looking)})`
	);
	h.check(
		looking.includes('SCENE HUD'),
		'and the scene HUD is still there — the layer COMPOSES both, it does not replace one'
	);

	const stopped = await page.evaluate(async () => {
		window.__stores.cameraPreview.stopCameraPreview();
		await new Promise((r) => setTimeout(r, 1200));
		return [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent?.trim());
	});
	h.check(
		!stopped.includes('CAMERA HUD') && stopped.includes('SCENE HUD'),
		`leaving the camera takes its HUD with it (${JSON.stringify(stopped)})`
	);

	// a camera with NO document of its own must change nothing
	const noDoc = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor(s.cameraObjects.listCameraObjects()[0].uuid, null);
		await new Promise((r) => setTimeout(r, 500));
		s.cameraPreview.startCameraPreview(s.cameraObjects.listCameraObjects()[0].uuid);
		await new Promise((r) => setTimeout(r, 1200));
		const list = [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent?.trim());
		s.cameraPreview.stopCameraPreview();
		return list;
	});
	h.check(
		noDoc.includes('SCENE HUD') && noDoc.length === 1,
		`a camera with no HUD of its own shows just the scene one (${JSON.stringify(noDoc)})`
	);

	// ---- 6. the editor can AUTHOR a camera document -----------------------
	const authored = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(false);
		s.bottomDock.activateDock('hud');
		await new Promise((r) => setTimeout(r, 1200));
		const select = document.querySelector('#hud-doc-key');
		const options = [...(select?.options ?? [])].map((o) => o.textContent?.trim());
		const camUuid = s.cameraObjects.listCameraObjects()[0].uuid;
		select.value = camUuid;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 900));
		// the artboard is now empty (that camera's doc was deleted above), and adding an
		// element must land on the CAMERA's document, not the scene's
		document.querySelector('#hud-palette [data-hud-kind="text"]')?.click();
		await new Promise((r) => setTimeout(r, 800));
		return {
			options,
			camDoc: !!s.hudDocs.hudDocOf(camUuid),
			camElements: s.hudDocs.hudDocOf(camUuid)?.screens[0].elements.length ?? 0,
			sceneElements: s.hudDocs.hudDocOf('scene')?.screens[0].elements.length ?? 0
		};
	});
	h.check(
		authored.options.length >= 2 && authored.options[0] === 'Scene HUD',
		`the editor offers the scene HUD and every camera (${JSON.stringify(authored.options)})`
	);
	h.check(authored.camDoc && authored.camElements === 1, `adding an element lands on the CAMERA's document (${authored.camElements})`);
	h.check(authored.sceneElements === 1, `and leaves the scene document alone (${authored.sceneElements})`);

	await h.finish(browser);
});
