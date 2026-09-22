// 30 P1/P2 — GAMES START ON START: the editor stops masquerading as the running game.
//
// Before: loading a Games-tab game painted its MENU over the editor ("TOWERS / Start
// round" on top of the scene being built) with LIVE buttons — a Start press in the editor
// started the round for every peer with nobody in Play — and leaving Play left the round
// `playing` with its in-game HUD on the editor.
//
// After: a GAME's screens are not drawn outside Play (the rule, and why it is the rule:
// hudDocs `isGameHud` — a scene is a game when one of its HUD screens is bound to a game
// state with `showWhile`), the HUD editor's preview eye still shows them for authoring
// with every button INERT, and a small chip stands in for them: "Game · <state>" plus
// ▶ Test play.
//
// Loaded from the REAL Towers .tpscene with the REAL collectible zip, skip-never-fail when
// either is missing (authored content must never turn a bare checkout red).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [
	path.resolve(__dirname, '../../../theprototype.app-scenes'),
	path.resolve(__dirname, '../../../scenes')
].find((p) => fs.existsSync(p));
const TPSCENE =
	process.env.TOWERS_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/towers/scene.tpscene'));

/** @param {any} page */
async function loadTowers(page) {
	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2000);
}

/** @param {any} page */
const snap = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		/** @param {any} st */
		const g = (st) => {
			let v;
			st.subscribe((/** @type {any} */ x) => (v = x))();
			return v;
		};
		const layer = document.querySelector('#hud-layer');
		const chip = document.querySelector('#game-chip');
		return {
			state: g(s.gameState.gameState)?.state ?? null,
			locked: g(s.isLocked),
			isGame: g(s.hudDocs.hudIsGame),
			screen: s.hudDocs.visibleScreen('scene')?.id ?? null,
			layer: !!layer,
			layerText: layer?.textContent ?? '',
			buttons: layer ? layer.querySelectorAll('button').length : 0,
			chip: !!chip,
			chipText: chip?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
			preview: g(s.hudDocs.hudPreviewInViewport)
		};
	});

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no sibling scenes checkout with games/towers/scene.tpscene (or TOWERS_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 720 } },
		storage: { hudPreviewInViewport: 'false' }
	});
	const page = A.page;
	if (!(await h.installModule(A, 'collectible'))) {
		console.log('SKIP: no collectible.zip in the sibling modules checkout (npm run pack -- collectible)');
		await h.finish(browser);
		return;
	}
	await loadTowers(page);

	// =====================================================================
	// 1. EDIT MODE SHOWS THE CHIP, NOT THE MENU
	// =====================================================================
	let st = await snap(page);
	h.check(st.state === 'menu' && st.screen === 'menu', `premise: the game sits on its menu (${st.state}/${st.screen})`);
	h.check(st.locked !== true, 'premise: we are in the editor, not in Play');
	h.check(st.isGame === true, 'Towers reads as a GAME (a showWhile-bound screen)');
	h.check(st.buttons === 0, `no HUD button exists in the editor (${st.buttons})`);
	h.check(!/TOWERS/.test(st.layerText), 'and the menu title is not painted over the editor');
	h.check(st.chip, 'the game chip stands in for it');
	h.check(/Game\s*·\s*menu/.test(st.chipText), `reading "Game · menu" (${st.chipText})`);

	// A REAL click where the Start button used to be changes nothing. The spot is computed
	// from the element's own anchored rect, the rule HudLayer places it by.
	const start = await page.evaluate(() => {
		const s = window.__stores;
		const doc = s.hudDocs.hudDocOf('scene');
		const menu = doc.screens.find((sc) => sc.id === 'menu');
		const el = menu.elements.find((e) => e.kind === 'button' && /start/i.test(String(e.label ?? e.text ?? '')));
		if (!el) return null;
		const r = s.hudDocs.rectInFrame(el, window.innerWidth, window.innerHeight);
		return { x: r.left + r.w / 2, y: r.top + r.h / 2, id: el.id };
	});
	h.check(!!start, `premise: the Start button is in the document (${start?.id})`);
	if (start) {
		const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, start);
		h.check(under !== 'BUTTON', `nothing button-shaped is under that spot in the editor (${under})`);
		await page.mouse.click(start.x, start.y);
		await page.waitForTimeout(900);
		st = await snap(page);
		h.check(st.state === 'menu', `clicking where Start used to be leaves the game on its menu (${st.state})`);
	}

	// =====================================================================
	// 2. THE PREVIEW EYE: the author can still SEE the screens — inert
	// =====================================================================
	await page.locator('#game-chip-preview').click();
	await h.eventually(() => snap(page), (v) => v.buttons > 0 && /TOWERS/.test(v.layerText), 'the preview eye paints the menu over the editor', 5000);
	st = await snap(page);
	h.check(st.preview === true, 'the eye IS the HUD editor\'s preview store (one switch, two surfaces)');
	const inert = await page.evaluate(() => {
		const b = [...document.querySelectorAll('#hud-layer button')].find((x) => /start/i.test(x.textContent ?? ''));
		if (!b) return null;
		const r = b.getBoundingClientRect();
		const x = r.left + r.width / 2;
		const y = r.top + r.height / 2;
		const under = document.elementFromPoint(x, y);
		return { tab: b.tabIndex, x, y, clickThrough: !b.contains(under), under: under?.tagName ?? null };
	});
	h.check(!!inert && inert.tab === -1, `the previewed Start is out of the tab order (${JSON.stringify(inert)})`);
	h.check(!!inert && inert.clickThrough, `and the preview is a PICTURE of the menu: a click there reaches the viewport (${inert?.under})`);
	// a real press on the previewed button's own pixel
	if (inert) await page.mouse.click(inert.x, inert.y);
	await page.waitForTimeout(900);
	st = await snap(page);
	h.check(st.state === 'menu', `pressing the PREVIEWED Start does nothing — buttons are inert outside Play (${st.state})`);
	await page.locator('#game-chip-preview').click();
	await h.eventually(() => snap(page), (v) => v.buttons === 0, 'the eye off hides the screens again', 5000);

	await h.finish(browser);
});
