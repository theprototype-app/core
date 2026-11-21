// 102b-play — PLAY POLISH: what an author makes in the editor reaches the play app (`/play`).
//
//   1. TOUCH LAYOUT TRAVELS: the author's layout (Settings ▸ Touch controls ▸ Edit layout ▸ For
//      players = scenePhysics play.touch) is in the saved .tpscene and the play app draws from it;
//      a player's own layout still wins, item by item. A scene without one saves no `touch` key.
//   2. INFO POINTS: a note marked "Show to visitors in Play" with a picture and a saved view opens in
//      /play from the embed chrome — by keyboard (Tab/Enter/Escape, focus back to the button), named
//      for a screen reader — and only visitor notes get a pin there. No live session involved: the
//      scene file is served by a route.
//   3. SMALL BROWSER WINS: Screen Wake Lock (stubbed) is asked for while playing and released on
//      leaving play; the colour dropper (EyeDropper stubbed) writes a picked colour into a focused
//      colour field with I, as input + change.
//
// Counterfactual (base v1.70.0): no `play.touch` field (normalize drops it), no #info-points-button,
// every note pinned in /play, no wakeLock request, no dropper — every check below is red there.
const h = require('./helpers.cjs');

const { check } = h;
// bounded: a lost page or a stuck browser close must not hold the e2e slot (SIGKILL skips exit hooks)
const SUITE_LIMIT_MS = Number(process.env.SUITE_LIMIT_MS || 300000);
setTimeout(() => {
	console.error(`SUITE TIMEOUT after ${SUITE_LIMIT_MS / 1000} s`);
	process.kill(process.pid, 'SIGKILL');
}, SUITE_LIMIT_MS).unref();
process.on('exit', (c) => c && process.kill(process.pid, 'SIGKILL'));
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;
const PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
const AUTHOR = { v: 1, items: { stick: { x: 0.31, y: 0.62, size: 150, opacity: 0.5 } } };

h.run(async () => {
	const browser = await h.launch();

	// ------------------------------------------------------------ editor: author the scene
	const E = await h.setupPage(browser, 'E', {
		context: {},
		initScript: undefined
	});
	await E.ctx.addInitScript(() => {
		// 3: the dropper exists only where EyeDropper does — give this page one that answers orange
		window.EyeDropper = class {
			open() {
				return Promise.resolve({ sRGBHex: '#ff8800' });
			}
		};
	});
	// the init script lands on the next navigation; reload once so App's onMount sees EyeDropper
	await E.page.reload({ waitUntil: 'domcontentloaded' });
	await E.page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.annotationsHandler, null, { timeout: 90000 });
	await h.answerRestore(E);

	const plain = await E.page.evaluate(() => {
		const S = window.__tp.test.v1.sessions;
		const p = S.buildSessionPayload('plain', { thumbnail: false });
		return { touch: 'touch' in (p.physics?.play ?? {}), notes: (p.annotations ?? []).length };
	});
	check(!plain.touch, `1: a scene with no author layout saves no play.touch (${JSON.stringify(plain)})`);

	const made = await E.page.evaluate(
		({ AUTHOR, PNG }) => {
			const s = window.__tp.test.v1;
			s.commandsHandler.sceneCommand('/create box');
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const box = g.children[g.children.length - 1];
			const ah = s.annotationsHandler;
			const add = (fields) => {
				ah.addAnnotation(box.uuid, [0, 1, 0]);
				let cur = null;
				ah.activeAnnotation.subscribe((a) => (cur = a))();
				ah.setAnnotation({ ...cur.draft, ...fields });
				ah.activeAnnotation.set(null);
				return cur.draft.id;
			};
			const visitor = add({
				name: 'The engine',
				text: 'Four cylinders.\nTurn the key to start.',
				visitors: true,
				picture: PNG,
				camera: { position: [4, 3, 4], target: [0, 0.5, 0] }
			});
			const review = add({ name: 'Review: fix the wheel', text: 'internal' });
			s.scenePhysics.setScenePhysics({ play: { touch: AUTHOR } });
			return { visitor, review };
		},
		{ AUTHOR, PNG }
	);
	const bytes = await E.page.evaluate(async () => {
		const S = window.__tp.test.v1.sessions;
		const zip = await S.exportSessionZip(S.buildSessionPayload('play polish', { thumbnail: false }));
		const back = await S.importSessionZip(zip.buffer);
		window.__e2eBack = { touch: back.physics?.play?.touch ?? null, notes: back.annotations };
		return Array.from(zip);
	});
	const back = await E.page.evaluate(() => window.__e2eBack);
	// the lane's file, for the compat suite (play-polish-102b-compat) to open in the newest release
	if (process.env.PLAY_POLISH_OUT) require('fs').writeFileSync(process.env.PLAY_POLISH_OUT, Buffer.from(bytes));
	check(
		JSON.stringify(back.touch) === JSON.stringify(AUTHOR),
		`1: the author layout survives the .tpscene round trip (${JSON.stringify(back.touch)})`
	);
	const vNote = back.notes.find((n) => n.id === made.visitor);
	const rNote = back.notes.find((n) => n.id === made.review);
	check(vNote?.visitors === true && vNote?.picture === PNG, '2: the visitor flag and the picture are in the file');
	check(rNote && !('visitors' in rNote) && !('picture' in rNote), '2: an ordinary note carries neither key');

	// 3: the dropper on a colour field (one appended here: the global button serves every field)
	const dropped = await E.page.evaluate(async () => {
		const input = document.createElement('input');
		input.type = 'color';
		input.id = 'e2e-color';
		input.value = '#000000';
		document.body.appendChild(input);
		const seen = [];
		input.addEventListener('input', () => seen.push('input'));
		input.addEventListener('change', () => seen.push('change'));
		input.focus();
		await new Promise((r) => setTimeout(r, 50));
		const btn = document.getElementById('eyedropper-button');
		window.__e2eDrop = { seen, btnShown: !!btn && !btn.hidden, keys: input.getAttribute('aria-keyshortcuts') };
		return window.__e2eDrop;
	});
	check(dropped.btnShown && dropped.keys === 'I', `3: the dropper button shows beside a focused colour field (${JSON.stringify(dropped)})`);
	await E.page.keyboard.press('i');
	await h.eventually(
		() => E.page.evaluate(() => ({ v: document.getElementById('e2e-color').value, seen: window.__e2eDrop.seen })),
		(r) => r.v === '#ff8800' && r.seen.join() === 'input,change',
		'3: I picks a screen colour into the field as input + change'
	);
	await E.ctx.close();

	// ------------------------------------------------------------ /play: the visitor
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
		// 3: a Screen Wake Lock that records what the app asks
		window.__wake = { requests: 0, releases: 0 };
		Object.defineProperty(navigator, 'wakeLock', {
			configurable: true,
			value: {
				request: async () => {
					window.__wake.requests++;
					const s = { released: false, addEventListener() {}, release: async () => ((s.released = true), window.__wake.releases++) };
					return s;
				}
			}
		});
	});
	const buf = Buffer.from(bytes);
	await ctx.route('**/e2e-scenes/*.tpscene', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: buf }));
	const page = await ctx.newPage();
	page.on('pageerror', (e) => console.log('[P pageerror]', e.stack));
	await page.goto(h.URL + 'play?scene=' + encodeURIComponent('/e2e-scenes/polish.tpscene'), { waitUntil: 'domcontentloaded', timeout: 90000 });
	await page.waitForFunction(() => !!window.tpPlay, null, { timeout: 90000 });
	const loaded = await page.evaluate(() => Promise.race([window.tpPlay.loaded, new Promise((r) => setTimeout(() => r('timeout'), 120000))]));
	check(loaded === true, `/play loads the authored scene (${loaded})`);
	await page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.touchActions, null, { timeout: 60000 });

	// 1: the layout the overlay would draw = the author's, until the player saves their own stick
	const layers = await page.evaluate((r) => {
		const s = window.__tp.test.v1;
		const play = eval(r)(s.scenePhysics.scenePlay);
		const T = s.touchActions;
		const spec = T.resolveTouchControls({ declared: [{ owner: '', actions: [], preset: 'shooter', at: 0 }] });
		const authorOnly = T.effectiveTouchLayout(spec, T.savedLayoutFor(eval(r)(T.touchLayouts), 'x'), 800, 600, play.touch ?? null).items.stick;
		T.saveTouchLayout({ v: 1, items: { stick: { x: 0.1, y: 0.9, size: 90, opacity: 1 } } }, 'global', 'x');
		const mine = T.effectiveTouchLayout(spec, T.savedLayoutFor(eval(r)(T.touchLayouts), 'x'), 800, 600, play.touch ?? null).items.stick;
		T.resetTouchLayout('global', 'x');
		return { authorOnly, mine };
	}, read);
	check(layers.authorOnly?.x === 0.31 && layers.authorOnly?.size === 150, `1: /play draws the author's stick (${JSON.stringify(layers.authorOnly)})`);
	check(layers.mine?.x === 0.1 && layers.mine?.size === 90, `1: the player's own layout still wins (${JSON.stringify(layers.mine)})`);

	// 2: pins — only the visitor note is pinned in /play
	const pins = await page.evaluate(() => {
		let scene;
		window.__tp.test.v1.globalScene.subscribe((x) => (scene = x))();
		const root = scene?.getObjectByName('annotation-pins');
		return root ? root.children.filter((c) => c.name?.startsWith('pin-')).map((c) => c.name.slice(4)) : null;
	});
	check(Array.isArray(pins) && pins.length === 1 && pins[0] === made.visitor, `2: /play pins only the visitor note (${JSON.stringify(pins)})`);

	// 2: the button, by keyboard
	const label = await page.getAttribute('#info-points-button', 'aria-label').catch(() => null);
	check(label === 'Info points (1)', `2: a named Info points button with the count (${label})`);
	await page.focus('#info-points-button');
	await page.keyboard.press('Enter');
	await page.waitForSelector('#info-points-list', { timeout: 5000 }).catch(() => {});
	const probe = await page.evaluate(() => ({
		list: !!document.getElementById('info-points-list'),
		expanded: document.getElementById('info-points-button')?.getAttribute('aria-expanded'),
		active: document.activeElement?.outerHTML?.slice(0, 120)
	}));
	console.log('after Enter', JSON.stringify(probe));
	const listFocus = await page.evaluate(() => document.activeElement?.getAttribute('data-info-point'));
	check(listFocus === made.visitor, `2: the list opens with focus on its first point (${listFocus})`);
	await page.keyboard.press('Enter');
	await page.waitForSelector('#info-point-card', { timeout: 5000 }).catch(() => {});
	const card = await page.evaluate(() => {
		const el = document.getElementById('info-point-card');
		return el
			? {
					role: el.getAttribute('role'),
					title: document.getElementById('info-point-title')?.textContent?.trim(),
					text: el.querySelector('.ip-text')?.textContent ?? '',
					img: !!el.querySelector('img.ip-picture')?.getAttribute('src')?.startsWith('data:image/png'),
					view: !!document.getElementById('info-point-view'),
					focused: document.activeElement === el
				}
			: null;
	});
	check(
		card?.role === 'dialog' && card.title === 'The engine' && card.text.includes('Turn the key') && card.img && card.view && card.focused,
		`2: the card shows title, text, picture and Show the view, and takes focus (${JSON.stringify(card)})`
	);
	await page.click('#info-point-view');
	await h.eventually(
		() =>
			page.evaluate((r) => {
				const c = eval(r)(window.__tp.test.v1.globalCamera);
				return c ? c.position.toArray().map((v) => Math.round(v)) : null;
			}, read),
		(p) => p && p[0] === 4 && p[1] === 3 && p[2] === 4,
		'2: Show the view flies the camera to the saved framing'
	);
	await page.focus('#info-point-card');
	await page.keyboard.press('Escape');
	const after = await page.evaluate(() => ({ card: !!document.getElementById('info-point-card'), focus: document.activeElement?.id }));
	check(!after.card && after.focus === 'info-points-button', `2: Escape closes the card, focus back on the button (${JSON.stringify(after)})`);

	// 3: wake lock while playing, released on leaving play
	await page.waitForFunction(() => !!window.__tp.test.v1.wakeLock, null, { timeout: 30000 });
	await page.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	await h.eventually(() => page.evaluate(() => window.__wake.requests), (n) => n >= 1, '3: playing asks for a screen wake lock');
	await page.evaluate(() => window.__tp.test.v1.isLocked.set(false));
	await h.eventually(() => page.evaluate(() => window.__wake.releases), (n) => n >= 1, '3: leaving play releases it');

	await ctx.close();
	await h.finish(browser);
});
