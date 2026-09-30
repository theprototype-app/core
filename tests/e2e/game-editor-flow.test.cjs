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

	// =====================================================================
	// 3. ▶ TEST PLAY (solo): back to the menu, into Play, the Start screen
	// =====================================================================
	// leave the round somewhere Test play must undo: mid-game, with a local screen override
	await page.evaluate(() => {
		const s = window.__stores;
		s.gameState.setGameState('playing');
		s.hudDocs.showHudScreen('scene', 'pause');
	});
	await h.eventually(() => snap(page), (v) => v.state === 'playing', 'premise: the round is running before Test play', 4000);
	await page.locator('#game-chip-test').click();
	await h.eventually(() => snap(page), (v) => v.locked === true, 'Test play enters Play', 6000);
	st = await snap(page);
	h.check(st.state === 'menu', `...with the game reset to its menu (${st.state})`);
	h.check(st.screen === 'menu', `...and the MENU screen showing, not the stale pause override (${st.screen})`);
	await h.eventually(() => snap(page), (v) => /Start round/.test(v.layerText) && v.buttons > 0, 'the Start screen is in front of the player', 6000);
	h.check(!st.chip, 'the chip is editor chrome — gone in Play');
	await page.locator('#hud-layer button', { hasText: 'Start round' }).click();
	await h.eventually(() => snap(page), (v) => v.state === 'playing' && v.screen === 'hud', 'Start (in Play) starts the round', 8000);
	await page.keyboard.press('Escape');
	await h.eventually(() => snap(page), (v) => v.locked !== true, 'Escape returns to the editor', 6000);
	await h.eventually(() => snap(page), (v) => v.state === 'menu', 'ALONE, leaving play resets the round to its menu at once', 3000);
	st = await snap(page);
	h.check(st.buttons === 0 && !/Stack on the glowing pad/.test(st.layerText), `and no in-game HUD is left on the editor (${st.buttons} buttons)`);
	h.check(/Game\s*·\s*menu/.test(st.chipText), `the chip reads the menu again (${st.chipText})`);

	// the play button's right-click menu carries the same row
	await page.locator('#play-button').click({ button: 'right' });
	const row = page.locator('[role=menuitem]', { hasText: 'Test play (start from the menu)' });
	await h.eventually(() => row.count(), (n) => n === 1, 'the play button right-click menu offers "Test play (start from the menu)"', 4000);
	await row.first().click();
	await h.eventually(() => snap(page), (v) => v.locked === true && v.state === 'menu', 'and the row enters Play on the menu', 6000);
	await page.keyboard.press('Escape');
	await h.eventually(() => snap(page), (v) => v.locked !== true, 'back to the editor', 6000);

	// =====================================================================
	// 4. TWO PEERS: the round ends when the LAST player leaves
	// =====================================================================
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	if (!(await h.installModule(B, 'collectible'))) {
		console.log('SKIP (section 4): no collectible.zip for the second peer');
		await h.finish(browser);
		return;
	}
	await h.connect(B, A);
	await h.eventually(() => snap(B.page), (v) => v.isGame === true, 'B received the game (its HUD document)', 20000);
	const both = async () => ({ a: await snap(page), b: await snap(B.page) });
	// A (the host) Test-plays and starts; B joins play
	await page.locator('#game-chip-test').click();
	await h.eventually(() => snap(page), (v) => v.locked === true, 'A enters Play through Test play', 6000);
	await page.locator('#hud-layer button', { hasText: 'Start round' }).click();
	await h.eventually(() => both(), (v) => v.a.state === 'playing' && v.b.state === 'playing', 'Start in A\'s Play starts the round for both', 8000);
	await B.page.evaluate(() => window.__stores.playMode.requestPlay());
	await h.eventually(
		() => page.evaluate(() => window.__stores.gamePresence.gamePresenceDebug().peers),
		(m) => Object.values(m).includes('playing'),
		'A sees B in play',
		8000
	);
	// A leaves while B plays: the round stays
	await page.keyboard.press('Escape');
	await h.eventually(() => snap(page), (v) => v.locked !== true, 'A back in the editor', 6000);
	await page.waitForTimeout(12000); // past the ten-second window: B is still playing
	let v2 = await both();
	h.check(v2.a.state === 'playing' && v2.b.state === 'playing', `A left while B plays: the round is still on for both (${v2.a.state}/${v2.b.state})`);
	// B leaves too: nobody is in play, so the host commits the menu after the window
	await B.page.keyboard.press('Escape');
	await h.eventually(() => snap(B.page), (v) => v.locked !== true, 'B back in the editor', 6000);
	await h.eventually(() => both(), (v) => v.a.state === 'menu' && v.b.state === 'menu', 'the LAST player leaving resets the round to menu on BOTH (the host writes it)', 20000);
	const writes = await Promise.all([page, B.page].map((p) => p.evaluate(() => window.__stores.gamePresence.gamePresenceDebug().abandonWrites)));
	h.check(writes[0] >= 1 && writes[1] === 0, `written by the host alone (A=${writes[0]}, B=${writes[1]})`);

	await h.finish(browser);
});
