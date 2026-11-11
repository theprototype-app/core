// 53 (A6) — THE PLAYER'S ACCESSIBILITY MENU. The user (2026-10-21): the people who PLAY games made
// here get an Accessibility menu in Play and in exported games — captions for game audio, a
// colour-blind filter, HUD text size and control remapping — saved per player per game, local.
//
//  1 the pause menu lists Accessibility; its page shows the four rows + the game's controls
//  2 Captions on: a Game Sound node's default caption + a Sound-node-less authored caption show
//    in #game-captions; captions OFF draws nothing (the bus still knows)
//  3 remap: pick the Key Press's row, press ↑ — ↑ now fires it (a caption appears), R does not;
//    the walker's W moved to I moves the player, W does not
//  4 per game, local: game B inherits captions (the last choice) but not the remap; A keeps both;
//    the values live in tp:game:<id>:access and nothing is sent to peers
//  5 colour filter: html[data-player-filter] + the canvas CSS filter while playing, gone after
//  6 HUD text size 150 %: a text element's box and type grow 1.5x (an image does not)
//  7 caption size Large: 24 px lines
//  8 the VR board draws the Accessibility page (shell:acc:* hits) and a press steps a row; the
//    head-locked caption strip carries the live lines
//  9 a Timeline audio clip's caption shows when the clip starts
// 10 the start card (embed / export) opens the Accessibility page on its own; Back closes it
const h = require('./helpers.cjs');

const GAME = {
	active: '',
	screens: [
		{
			id: 'hud',
			name: 'HUD',
			showWhile: 'playing',
			elements: [
				{ id: 'score', kind: 'text', anchor: 'top-left', x: 24, y: 24, w: 240, h: 40, label: 'Score: 0', style: { size: 20 } },
				{ id: 'pic', kind: 'image', anchor: 'top-right', x: 24, y: 24, w: 64, h: 64 }
			]
		}
	]
};

const rd = `(st) => { let v; st.subscribe((x) => (v = x))(); return v; }`;
const dbg = (page) => page.evaluate(() => ({ access: window.__tp.test.v1.gameKit.playerAccess.accessDebug(), captions: window.__tp.test.v1.gameKit.captions.captionsDebug() }));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.setViewportSize({ width: 1280, height: 800 });

	await page.evaluate(
		({ doc }) => {
			const s = window.__tp?.test.v1;
			s.gameKit.gameSettings.forceGameId('access-a');
			s.hudDocs.setHudDocFor('scene', doc);
			s.gameState.setGameState('playing');
			s.updateGraph(s.SCENE_GRAPH, () => ({
				nodes: [
					{ id: 'kR', type: 'keypress', position: { x: 0, y: 0 }, data: { type: 'keypress', label: 'Key Press', code: 'KeyR', pulse: 0.3, action: 'Collect' } },
					{ id: 'gs', type: 'gamesound', position: { x: 300, y: 0 }, data: { type: 'gamesound', label: 'Game Sound', sound: 'coin' } },
					{ id: 'kT', type: 'keypress', position: { x: 0, y: 160 }, data: { type: 'keypress', label: 'Key Press', code: 'KeyT', pulse: 0.3 } },
					{ id: 'gt', type: 'gamesound', position: { x: 300, y: 160 }, data: { type: 'gamesound', label: 'Game Sound', sound: 'step', caption: 'Footsteps on gravel' } }
				],
				edges: [
					{ id: 'e1', source: 'kR', target: 'gs', targetHandle: 'trigger' },
					{ id: 'e2', source: 'kT', target: 'gt', targetHandle: 'trigger' }
				]
			}));
			s.gameKit.gameShell.markShellGame(true);
		},
		{ doc: GAME }
	);
	await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(500);

	console.log('\n=== 1. the pause menu lists Accessibility; its page ===');
	await page.evaluate(() => window.__tp.test.v1.playMode.requestPlay());
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__tp.test.v1.gameKit.gameShell.openShellMenu('main'));
	await page.waitForTimeout(300);
	const items = await page.$$eval('[data-shell-item]', (els) => els.map((e) => e.getAttribute('data-shell-item')));
	h.check(items.includes('access'), '1.1 the pause menu has an Accessibility row (' + items + ')');
	await page.click('[data-shell-item="access"]');
	await page.waitForTimeout(300);
	h.check(await page.locator('#game-access-page').isVisible(), '1.2 the Accessibility page opens');
	const rows = await page.$$eval('[data-access-setting]', (els) => els.map((e) => e.getAttribute('data-access-setting')));
	h.check(JSON.stringify(rows) === JSON.stringify(['captions', 'captionSize', 'colorFilter', 'hudText']), '1.3 captions · caption size · colour filter · HUD text size (' + rows + ')');
	const remapRows = await page.$$eval('[data-remap]', (els) => els.map((e) => e.getAttribute('data-remap') + '=' + e.textContent.replace(/\s+/g, ' ').trim()));
	h.check(remapRows.some((r) => r.startsWith('keys:KeyW=Move forward')) && remapRows.some((r) => r.startsWith('keys:KeyR=Collect')), '1.4 the controls list: the walker keys + the Key Press by its action name (' + remapRows.slice(0, 7).join(' | ') + ')');
	if (process.env.EVIDENCE_DIR) await page.screenshot({ path: require('path').join(process.env.EVIDENCE_DIR, '01-access-page-desktop.png') });

	console.log('\n=== 2. captions ===');
	await page.keyboard.press('Escape'); // back to the main page? (in Play Esc closes the menu)
	await page.evaluate(() => window.__tp.test.v1.gameKit.gameShell.closeShellMenu());
	await page.waitForTimeout(200);
	await page.keyboard.press('KeyR');
	await page.waitForTimeout(500);
	let d = await dbg(page);
	h.check(d.captions.last.includes('[coin]'), '2.1 premise: the bus heard the Game Sound default caption with captions off (' + d.captions.last + ')');
	h.check(!(await page.locator('#game-captions').isVisible().catch(() => false)), '2.2 captions OFF: nothing is drawn');
	await page.evaluate(() => window.__tp.test.v1.gameKit.gameShell.openShellMenu('access'));
	await page.waitForTimeout(200);
	await page.click('[data-access-setting="captions"] input[type="checkbox"]');
	await page.evaluate(() => window.__tp.test.v1.gameKit.gameShell.closeShellMenu());
	await page.waitForTimeout(200);
	await page.keyboard.press('KeyT');
	await page.waitForTimeout(400);
	const lines = await page.$$eval('#game-captions .caption-line', (els) => els.map((e) => e.textContent));
	h.check(lines.includes('Footsteps on gravel'), '2.3 captions ON: an authored caption shows on screen (' + lines + ')');
	await page.keyboard.press('KeyR');
	await page.waitForTimeout(400);
	const lines2 = await page.$$eval('#game-captions .caption-line', (els) => els.map((e) => e.textContent));
	h.check(lines2.includes('[coin]'), '2.4 a Game Sound with no caption text shows its default "[coin]" (' + lines2 + ')');

	console.log('\n=== 3. remap ===');
	await page.evaluate(() => window.__tp.test.v1.gameKit.gameShell.openShellMenu('access'));
	await page.waitForTimeout(200);
	await page.click('[data-remap="keys:KeyR"] button');
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(200);
	d = await dbg(page);
	h.check(d.access.remap.keys.KeyR === 'ArrowUp', '3.1 pressing ↑ while the row waits binds Collect to ↑ (' + JSON.stringify(d.access.remap) + ')');
	h.check((await page.textContent('[data-remap="keys:KeyR"] button')).trim() === '↑', '3.2 the row shows ↑');
	await page.evaluate(() => window.__tp.test.v1.gameKit.gameShell.closeShellMenu());
	await page.evaluate(() => window.__tp.test.v1.gameKit.captions.clearCaptions());
	await page.waitForTimeout(3200); // let the coin's merge window pass
	const before = (await dbg(page)).captions.pushed;
	await page.keyboard.press('KeyR');
	await page.waitForTimeout(500);
	const afterR = (await dbg(page)).captions.pushed;
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(500);
	const afterUp = (await dbg(page)).captions.pushed;
	h.check(afterR === before, '3.3 R (remapped away) no longer fires the Key Press (' + before + ' → ' + afterR + ')');
	h.check(afterUp === afterR + 1, '3.4 ↑ fires it — the Game Sound downstream captions (' + afterR + ' → ' + afterUp + ')');
	// the walker: W → I
	const walk = await page.evaluate(async (rdSrc) => {
		const s = window.__tp?.test.v1;
		s.gameKit.playerAccess.remapControl('keys', 'KeyW', 'KeyI', ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyR']);
		const cam = eval(rdSrc)(s.playerCam);
		return cam ? cam.getWorldPosition(new s.THREE.Vector3()).toArray() : null;
	}, rd);
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(500);
	await page.keyboard.up('KeyW');
	const camAt = (rdSrc) => {
		const cam = eval(rdSrc)(window.__tp.test.v1.playerCam);
		return cam ? cam.getWorldPosition(new window.__tp.test.v1.THREE.Vector3()).toArray() : null;
	};
	const afterW = await page.evaluate(camAt, rd);
	await page.keyboard.down('KeyI');
	await page.waitForTimeout(500);
	await page.keyboard.up('KeyI');
	const afterI = await page.evaluate(camAt, rd);
	const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : -1);
	h.check(walk && dist(walk, afterW) < 0.02, '3.5 the walker: W (moved to I) does not move the player (' + dist(walk, afterW).toFixed(3) + ' m)');
	h.check(dist(afterW, afterI) > 0.1, '3.6 the walker: I moves the player forward (' + dist(afterW, afterI).toFixed(3) + ' m)');

	console.log('\n=== 4. per game, local ===');
	const perGame = await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		const pa = s.gameKit.playerAccess;
		const storedA = JSON.parse(localStorage.getItem('tp:game:access-a:access') || 'null');
		s.gameKit.gameSettings.forceGameId('access-b');
		const b = pa.accessDebug();
		s.gameKit.gameSettings.forceGameId('access-a');
		const a = pa.accessDebug();
		return { storedA, b, a };
	});
	h.check(perGame.storedA?.captions === true && perGame.storedA?.remap?.keys?.KeyR === 'ArrowUp', '4.1 game A stored in tp:game:access-a:access (' + JSON.stringify(perGame.storedA) + ')');
	h.check(perGame.b.values.captions === true && !Object.keys(perGame.b.remap.keys).length, '4.2 game B inherits the last choices (captions on) but not the remap');
	h.check(perGame.a.remap.keys.KeyR === 'ArrowUp' && perGame.a.remap.keys.KeyW === 'KeyI', '4.3 back in game A its remap is there again');
	const wire = await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		let sent = 0;
		const peers = (() => {
			let v;
			s.peers.subscribe((x) => (v = x))();
			return v;
		})();
		const orig = peers?.send?.bind(peers);
		if (peers && orig) peers.send = (...args) => (sent++, orig(...args));
		s.gameKit.playerAccess.setAccess('captionSize', 'huge');
		s.gameKit.playerAccess.remapControl('keys', 'KeyS', 'KeyK', []);
		s.gameKit.playerAccess.resetRemap();
		s.gameKit.playerAccess.remapControl('keys', 'KeyR', 'ArrowUp', []);
		if (peers && orig) peers.send = orig;
		return sent;
	});
	h.check(wire === 0, '4.4 changing accessibility settings sends nothing to peers (' + wire + ' sends)');

	console.log('\n=== 5. colour filter ===');
	await page.evaluate(() => window.__tp.test.v1.gameKit.playerAccess.setAccess('colorFilter', 'deutan'));
	await page.waitForTimeout(200);
	const filt = await page.evaluate(() => ({
		attr: document.documentElement.getAttribute('data-player-filter'),
		canvas: getComputedStyle(document.querySelector('.viewport canvas')).filter,
		hud: document.querySelector('#hud-layer') ? getComputedStyle(document.querySelector('#hud-layer')).filter : null,
		matrix: document.querySelector('#tp-player-cb-filter feColorMatrix')?.getAttribute('values') ?? ''
	}));
	h.check(filt.attr === 'deutan' && /url\(/.test(filt.canvas) && /url\(/.test(filt.hud ?? ''), '5.1 deutan: the canvas + the game HUD wear the filter (' + filt.canvas + ')');
	h.check(filt.matrix.split(' ').length === 20, '5.2 one feColorMatrix (20 values)');
	if (process.env.EVIDENCE_DIR) await page.screenshot({ path: require('path').join(process.env.EVIDENCE_DIR, '05-filter-deutan.png') });

	console.log('\n=== 6. HUD text size ===');
	const hud = await page.evaluate(async () => {
		const s = window.__tp?.test.v1;
		const read = () => {
			const el = document.querySelector('[data-hud-id="score"]');
			const pic = document.querySelector('[data-hud-id="pic"]');
			const text = el?.querySelector('.hud-text');
			return { w: el?.getBoundingClientRect().width ?? 0, font: text ? parseFloat(getComputedStyle(text).fontSize) : 0, pic: pic?.getBoundingClientRect().width ?? 0 };
		};
		const a = read();
		s.gameKit.playerAccess.setAccess('hudText', '150');
		await new Promise((r) => setTimeout(r, 200));
		const b = read();
		return { a, b };
	});
	h.check(Math.abs(hud.b.w / hud.a.w - 1.5) < 0.02 && Math.abs(hud.b.font / hud.a.font - 1.5) < 0.02, '6.1 150 %: the text box and its type grow 1.5x (' + JSON.stringify(hud) + ')');
	h.check(hud.a.pic > 0 && Math.abs(hud.b.pic - hud.a.pic) < 0.5, '6.2 an image does not grow');
	if (process.env.EVIDENCE_DIR) await page.screenshot({ path: require('path').join(process.env.EVIDENCE_DIR, '06-hud-text-150.png') });

	console.log('\n=== 7. caption size ===');
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.gameKit.playerAccess.setAccess('captionSize', 'large');
		s.gameKit.captions.showCaption({ text: 'A door creaks open', source: 'test' });
	});
	await page.waitForTimeout(200);
	const px = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#game-captions .caption-line')).fontSize));
	h.check(px === 24, '7.1 Large captions are 24 px (' + px + ')');
	if (process.env.EVIDENCE_DIR) await page.screenshot({ path: require('path').join(process.env.EVIDENCE_DIR, '07-captions-large.png') });

	console.log('\n=== 8. the VR board ===');
	const vr = await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		const THREE = s.THREE;
		const head = { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() };
		s.gameKit.gameShell.openShellMenu('access');
		const frame = s.gameKit.vrGamePanel.vrGamePanelFrame({ head, hands: [null, null], force: true });
		const surf = s.gameKit.vrGamePanel.vrGameSurface('vr-game-panel');
		const hits = (surf?.hits ?? []).map((/** @type {any} */ r) => r.id);
		const before = s.gameKit.playerAccess.accessDebug().values.colorFilter;
		const pressed = s.gameKit.gameShell.pressShellHit('shell:acc:colorFilter:next');
		const after = s.gameKit.playerAccess.accessDebug().values.colorFilter;
		const url = surf?.canvas.toDataURL('image/png') ?? '';
		s.gameKit.gameShell.closeShellMenu();
		return { hits, before, after, pressed, captions: frame.captions, url };
	});
	h.check(vr.hits.includes('shell:acc:captions:next') && vr.hits.includes('shell:acc:hudText:prev'), '8.1 the VR board draws the Accessibility rows (' + vr.hits.filter((x) => x.includes('acc')).length + ' hits)');
	h.check(vr.pressed && vr.before === 'deutan' && vr.after === 'tritan', '8.2 a board press steps a row (' + vr.before + ' → ' + vr.after + ')');
	h.check(vr.captions.includes('A door creaks open'), '8.3 the head-locked caption strip carries the live lines (' + vr.captions + ')');
	if (process.env.EVIDENCE_DIR && vr.url) require('fs').writeFileSync(require('path').join(process.env.EVIDENCE_DIR, '08-vr-board-access.png'), Buffer.from(vr.url.split(',')[1], 'base64'));

	console.log('\n=== 9. a Timeline audio clip caption ===');
	const tl = await page.evaluate(async () => {
		const s = window.__tp?.test.v1;
		const id = s.sequences.createSequence('Captioned');
		const track = s.sequences.addTrack(id, 'audio');
		s.sequences.addItem(id, track, { t: 0, dur: 2, sound: '', caption: 'Thunder rumbles' });
		const doc = s.sequences.sequenceOf(id);
		s.sequencePlayer.playSequence(id);
		await new Promise((r) => setTimeout(r, 600));
		return { kept: doc.tracks[0].items[0].caption, last: s.gameKit.captions.captionsDebug().last };
	});
	h.check(tl.kept === 'Thunder rumbles', '9.1 the audio item keeps its caption through normalize');
	h.check(tl.last.includes('Thunder rumbles'), '9.2 the clip caption shows when the clip starts (' + tl.last.slice(-3) + ')');

	console.log('\n=== 5b. leaving play drops the filter ===');
	await page.evaluate(() => window.__tp.test.v1.playMode.exitPlay());
	await page.waitForTimeout(400);
	h.check((await page.evaluate(() => document.documentElement.getAttribute('data-player-filter'))) === null, '5.3 out of play: no filter');

	await A.ctx.close();

	console.log('\n=== 10. the start card (embed / export) ===');
	const E = await h.setupPage(browser, 'E', { hash: '?embed=1' });
	await E.page.setViewportSize({ width: 1280, height: 800 });
	await E.page.waitForSelector('#embed-access', { timeout: 20000 }).catch(() => {});
	h.check(await E.page.locator('#embed-access').isVisible(), '10.1 the start card has an Accessibility button');
	await E.page.click('#embed-access');
	await E.page.waitForTimeout(300);
	h.check(await E.page.locator('#game-access-page').isVisible(), '10.2 it opens the Accessibility page on its own (no game menu around it)');
	if (process.env.EVIDENCE_DIR) await E.page.screenshot({ path: require('path').join(process.env.EVIDENCE_DIR, '10-start-card-access.png') });
	await E.page.click('#game-shell-menu .gs-back');
	await E.page.waitForTimeout(300);
	h.check(!(await E.page.locator('#game-shell-menu').isVisible().catch(() => false)), '10.3 Back closes it (back to the start card)');

	await h.finish(browser);
});
