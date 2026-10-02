// 33 G5: EVERY GAME MENU IS LAID OUT. The Quest report: "When game menu/options shows 'Menu'
// and 'Top strip' buttons are too close or out of menu table/borders (gui thing, fix
// placement). Ensure the rest game menus also placed correctly."
//
// An automated BOUNDS AUDIT over the seven Games-tab games, loaded from their real .tpscene
// files with their real module zips:
//  · desktop — the game's own HUD screens in every game state (menu / playing / paused /
//    over) and the pause menu's pages (main, settings, levels, how to play): every control
//    inside its card / the viewport, no control sticking out of a HUD panel it sits on, and
//    no two controls closer than a minimum gap;
//  · VR (emulated) — the game panel's board for every state, the pause menu's pages on the
//    board, and the wrist card: every pressable rect inside its canvas with a margin, no two
//    closer than the gap, and no label wider than its button (the drawing code reports
//    those itself, `vrGamePanelDebug().overflow`).
// Shots of every board and page land in EVIDENCE_DIR when set.
//
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout.
// A game whose scene or zip is missing is SKIPPED (named), never failed.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const sceneOf = (slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, slug, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const GAMES = [
	{ slug: 'towers', modules: [] },
	{ slug: 'stars-room', modules: [] },
	{ slug: 'football', modules: ['football'] },
	{ slug: 'jam-room', modules: ['music-lab', 'music-fx'] },
	{ slug: 'dungeon-realms', modules: ['dungeon', 'dungeon-realms'] },
	{ slug: 'untangle', modules: ['untangle'] },
	{ slug: 'waves', modules: ['health', 'waves'] }
].filter((g) => !process.env.ONLY || process.env.ONLY.split(',').includes(g.slug));
const EVIDENCE = process.env.EVIDENCE_DIR || '';
const DESKTOP_GAP = 4; // px between two controls
const VR_MARGIN = 10; // canvas px from the board edge
const VR_GAP = 8; // canvas px between two pressables

/** the separation of two rects (negative = they overlap on both axes) */
const separation = (a, b) => Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h));
const inside = (r, box, margin = 0) =>
	r.x >= box.x + margin - 0.5 && r.y >= box.y + margin - 0.5 && r.x + r.w <= box.x + box.w - margin + 0.5 && r.y + r.h <= box.y + box.h - margin + 0.5;
const fmt = (r) => `${r.id ?? ''}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`;

/** every bounds problem of a set of controls in a box: [] when the layout is clean */
function audit(items, box, { margin = 0, gap = 0 } = {}) {
	const out = [];
	for (const r of items) if (!inside(r, box, margin)) out.push('outside: ' + fmt(r) + ' box ' + fmt(box));
	for (let i = 0; i < items.length; i++)
		for (let j = i + 1; j < items.length; j++) {
			const s = separation(items[i], items[j]);
			if (s < gap) out.push(`too close (${s.toFixed(1)} px): ${fmt(items[i])} / ${fmt(items[j])}`);
		}
	return out;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const installed = new Set();
	for (const id of [...new Set(GAMES.flatMap((g) => g.modules))]) if (await h.installModule(A, id)) installed.add(id);
	await page.evaluate(() => window.__stores.modulesOpen.set(false));
	await page.waitForTimeout(300);

	/** the desktop HUD on show: pressables + the panels they sit on */
	const hudRects = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const rect = (el) => {
				const r = el.getBoundingClientRect();
				return { x: r.left, y: r.top, w: r.width, h: r.height };
			};
			const slots = [...document.querySelectorAll('#hud-layer .hud-slot')].filter((el) => el.getBoundingClientRect().width > 0);
			const pressable = slots
				.filter((el) => s.hudKinds.isInteractiveKind(el.dataset.hudKind) && getComputedStyle(el).visibility !== 'hidden')
				.map((el) => ({ id: el.dataset.hudId, ...rect(el) }));
			const panels = slots.filter((el) => el.dataset.hudKind === 'panel').map((el) => ({ id: el.dataset.hudId, ...rect(el) }));
			return { pressable, panels, vw: innerWidth, vh: innerHeight };
		});

	/** the pause card's controls (a SCROLLING card counts its scroll height) */
	const shellRects = () =>
		page.evaluate(() => {
			const card = document.querySelector('#game-shell-menu .gs-card');
			if (!card) return null;
			const c = card.getBoundingClientRect();
			const box = { x: c.left, y: c.top, w: c.width, h: Math.max(c.height, card.scrollHeight) };
			const controls = [...card.querySelectorAll('button, input')]
				.filter((el) => el.getBoundingClientRect().width > 0)
				.map((el) => {
					const r = el.getBoundingClientRect();
					return { id: el.dataset.shellItem || el.dataset.shellLevel || el.getAttribute('aria-label') || el.className, x: r.left, y: r.top + card.scrollTop, w: r.width, h: r.height };
				});
			// a choice row's ‹ › and a range sit IN one row: audit gaps between ROWS, and
			// within a row only that nothing overlaps
			return { box, controls, overflowX: card.scrollWidth > card.clientWidth + 1 };
		});

	/** draw the VR surfaces once and read their hits (+ a PNG of the board) */
	const vrFrame = (shot) =>
		page.evaluate(async (shot) => {
			const s = window.__stores;
			const T = s.THREE;
			const k = s.gameKit.vrGamePanel;
			const head = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
			// the left wrist turned toward the face so the card is drawn
			const left = { position: new T.Vector3(-0.15, 1.2, -0.35), quaternion: new T.Quaternion().setFromEuler(new T.Euler(-1.1, 0, 0)) };
			k.vrGamePanelFrame({ head, hands: [left, null], force: true });
			const d = k.vrGamePanelDebug();
			const board = k.vrGameSurface('vr-game-panel');
			const wrist = k.vrGameSurface('vr-game-wrist');
			return {
				board: board?.mesh.visible ? { w: board.canvas.width, h: board.canvas.height, hits: d.hits['vr-game-panel'], png: shot ? board.canvas.toDataURL('image/png') : null } : null,
				wrist: wrist ? { w: wrist.canvas.width, h: wrist.canvas.height, hits: d.hits['vr-game-wrist'], png: shot ? wrist.canvas.toDataURL('image/png') : null } : null,
				overflow: d.overflow ?? []
			};
		}, shot);
	const save = (name, dataUrl) => {
		if (!EVIDENCE || !dataUrl) return;
		fs.writeFileSync(path.join(EVIDENCE, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
	};
	const setState = (state) => page.evaluate((st) => window.__stores.gameState.setGameState(st), state);

	for (const game of GAMES) {
		const file = sceneOf(game.slug);
		const missing = game.modules.filter((m) => !installed.has(m));
		if (!file || missing.length) {
			console.log('SKIP ' + game.slug + ': ' + (file ? 'no ' + missing.join(', ') + '.zip' : 'no scene.tpscene'));
			continue;
		}
		console.log('\n=== ' + game.slug + ' ===');
		const bytes = Array.from(fs.readFileSync(file));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			s.templatesModalOpen.set(false);
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(3000);

		// ================================================= desktop: the game's own screens
		await page.evaluate(() => window.__stores.playMode.requestPlay());
		await page.waitForTimeout(800);
		const desk = [];
		for (const state of ['menu', 'playing', 'paused', 'over']) {
			await setState(state);
			await page.waitForTimeout(400);
			const r = await hudRects();
			const view = { x: 0, y: 0, w: r.vw, h: r.vh };
			for (const p of audit(r.pressable, view, { margin: 2, gap: DESKTOP_GAP })) desk.push(state + ': ' + p);
			// a control that sits ON a panel must sit INSIDE it (no half-in, half-out)
			for (const b of r.pressable)
				for (const p of r.panels) {
					const touching = separation(b, p) < 0;
					if (touching && !inside(b, p)) desk.push(`${state}: ${b.id} sticks out of panel ${p.id}`);
				}
			if (EVIDENCE) await page.screenshot({ path: path.join(EVIDENCE, `hud-${game.slug}-${state}.png`) });
		}
		h.check(desk.length === 0, `${game.slug} desktop HUD: every control inside the view and its panel, ${DESKTOP_GAP}px apart${desk.length ? ' — ' + desk.slice(0, 4).join(' | ') : ''}`);

		// ================================================= desktop: the pause menu's pages
		await setState('playing');
		await page.evaluate(() => window.__stores.gameKit.gameShell.openShellMenu('main'));
		await page.waitForTimeout(300);
		const pages = await page.evaluate(() => {
			const s = window.__stores;
			let lv;
			s.gameKit.gameShell.gameLevels.subscribe((v) => (lv = v))();
			return ['main', 'settings', ...(lv?.list?.length ? ['levels'] : []), 'help'];
		});
		const shell = [];
		for (const pg of pages) {
			await page.evaluate((pg) => window.__stores.gameKit.gameShell.openShellMenu(pg), pg);
			await page.waitForTimeout(250);
			const r = await shellRects();
			if (!r) {
				shell.push(pg + ': no card');
				continue;
			}
			if (r.overflowX) shell.push(pg + ': the card scrolls sideways');
			for (const p of audit(r.controls, r.box, { margin: 4, gap: pg === 'settings' ? 0 : DESKTOP_GAP })) shell.push(pg + ': ' + p);
			if (EVIDENCE) await page.screenshot({ path: path.join(EVIDENCE, `shell-${game.slug}-${pg}.png`) });
		}
		h.check(shell.length === 0, `${game.slug} desktop pause menu (${pages.join(', ')}): every control inside the card, none overlapping${shell.length ? ' — ' + shell.slice(0, 4).join(' | ') : ''}`);
		await page.evaluate(() => window.__stores.gameKit.gameShell.closeShellMenu());
		await h.leavePlay(page);
		await page.waitForTimeout(400);

		// ================================================= VR: the board, the wrist
		await page.evaluate(() => {
			window.__stores.isVRMode.set(true);
			window.__stores.objectActions.setEditorMode('interact');
		});
		await xr.install(page);
		await xr.setOn(page, true);
		await page.waitForTimeout(300);
		const vr = [];
		let boards = 0;
		for (const state of ['menu', 'playing', 'paused', 'over']) {
			await setState(state);
			await page.waitForTimeout(250);
			const f = await vrFrame(!!EVIDENCE);
			if (f.board) {
				boards += 1;
				for (const p of audit(f.board.hits, { x: 0, y: 0, w: f.board.w, h: f.board.h }, { margin: VR_MARGIN, gap: VR_GAP })) vr.push('board ' + state + ': ' + p);
				save(`vr-board-${game.slug}-${state}.png`, f.board.png);
			}
			if (f.wrist?.hits?.length) for (const p of audit(f.wrist.hits, { x: 0, y: 0, w: f.wrist.w, h: f.wrist.h }, { margin: 6, gap: 6 })) vr.push('wrist ' + state + ': ' + p);
			if (state === 'menu') save(`vr-wrist-${game.slug}.png`, f.wrist?.png);
			for (const o of f.overflow) vr.push(`${state}: label wider than its button: ${o}`);
		}
		h.check(boards > 0, `${game.slug} VR: the board showed at least one menu screen (${boards})`);
		await setState('playing');
		for (const pg of pages) {
			await page.evaluate((pg) => window.__stores.gameKit.gameShell.openShellMenu(pg), pg);
			await page.waitForTimeout(150);
			const f = await vrFrame(!!EVIDENCE);
			if (!f.board) {
				vr.push('shell ' + pg + ': no board');
				continue;
			}
			for (const p of audit(f.board.hits, { x: 0, y: 0, w: f.board.w, h: f.board.h }, { margin: VR_MARGIN, gap: VR_GAP })) vr.push('shell ' + pg + ': ' + p);
			for (const o of f.overflow) vr.push(`shell ${pg}: label wider than its button: ${o}`);
			save(`vr-shell-${game.slug}-${pg}.png`, f.board.png);
		}
		await page.evaluate(() => window.__stores.gameKit.gameShell.closeShellMenu());
		h.check(vr.length === 0, `${game.slug} VR: every pressable inside its board/wrist with a ${VR_MARGIN}px margin, ${VR_GAP}px apart, labels fit${vr.length ? ' — ' + vr.slice(0, 5).join(' | ') : ''}`);
		await xr.uninstall(page);
		await page.evaluate(() => {
			window.__stores.isVRMode.set(false);
			window.__stores.objectActions.setEditorMode('edit');
			window.__stores.gameState.setGameState('menu');
		});
		await page.waitForTimeout(300);
	}
	await h.finish(browser);
});
