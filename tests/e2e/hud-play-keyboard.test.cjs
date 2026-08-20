// A2 — the HUD keyboard under a pointer lock, and THE CANNOT-SHIP RISK.
//
// The risk the plan flagged: if claiming `keys` (or our own capture handler) swallows
// Escape or the pointer-lock release, a player is STUCK inside a HUD screen with no way
// back to the editor. Verified in the source first, then asserted here both ways:
//
//   * `claimInput('keys')` only sets a flag. Its two consumers gate a per-frame MOVEMENT
//     task (PointerLockControls' useTask) and editorNavigation — NOT PointerLockControls'
//     onKeyDown, which is what owns Escape -> exitPointerLock. So the claim alone cannot
//     strand anyone.
//   * The real hazard is OUR handler: a window-CAPTURE stopImmediatePropagation would kill
//     that document-level onKeyDown. So Escape is never consumed by the HUD, and this
//     suite asserts that a real Escape still leaves play mode with a HUD screen up.
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-play-keyboard
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// a menu screen with three buttons, each wired to its own Counter through a hudbutton
	// node — so a press is observable as a replicated pulse, not just a DOM event
	await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'menu',
					name: 'Menu',
					elements: [
						{ id: 'b-start', kind: 'button', label: 'Start', anchor: 'center', x: 0, y: -60, w: 160, h: 36 },
						{ id: 'b-options', kind: 'button', label: 'Options', anchor: 'center', x: 0, y: 0, w: 160, h: 36 },
						{ id: 'b-quit', kind: 'button', label: 'Quit', anchor: 'center', x: 0, y: 60, w: 160, h: 36 },
						{ id: 't-title', kind: 'text', label: 'MY GAME', anchor: 'top-center', x: 0, y: 40 }
					]
				}
			],
			active: 'menu'
		});
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'hb-start', type: 'hudbutton', position: { x: 0, y: 0 }, data: { type: 'hudbutton', element: 'b-start' } },
			{ id: 'hb-quit', type: 'hudbutton', position: { x: 0, y: 120 }, data: { type: 'hudbutton', element: 'b-quit' } },
			{ id: 'c-start', type: 'counter', position: { x: 260, y: 0 }, data: { type: 'counter', step: 1, op: 'up' } },
			{ id: 'c-quit', type: 'counter', position: { x: 260, y: 120 }, data: { type: 'counter', step: 1, op: 'up' } }
		]);
		s.flowEdges.set([
			{ id: 'e-start', source: 'hb-start', target: 'c-start', targetHandle: 'pulse' },
			{ id: 'e-quit', source: 'hb-quit', target: 'c-quit', targetHandle: 'pulse' }
		]);
	});
	await page.waitForTimeout(900);

	// 21-E1.5: PLAY MODE, up front. The HUD keyboard is scoped to `$isLocked === true`
	// now — outside play, Tab/arrows/Space belong to the editor and its panels (the ring
	// handler is window-CAPTURE and preventDefaults, so it took them from everyone). This
	// suite always MEANT play mode; section 5 used to be the first place it said so.
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(800);
	const inPlay = await page.evaluate(() => {
		let v;
		window.__stores.isLocked.subscribe((x) => (v = x))();
		return v;
	});
	h.check(inPlay === true, `premise: play mode is engaged, so the HUD owns its keys (${inPlay})`);

	const counts = () =>
		page.evaluate(() => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			return { start: t?.['c-start']?.count ?? 0, quit: t?.['c-quit']?.count ?? 0 };
		});

	// ---- 1. the claim: taken while a screen with buttons is up ---------------
	const claimed = await page.evaluate(() => ({
		claims: window.__stores.inputRuntime.isClaimed('keys'),
		focusRing: document.querySelectorAll('#hud-layer .hud-focused').length
	}));
	h.check(claimed.claims, 'a HUD screen with buttons CLAIMS the keys, so editor fly and play WASD stand down');
	h.check(claimed.focusRing === 1, `and exactly one button carries the focus ring (${claimed.focusRing})`);

	// ---- 2. the arrows walk the focusables, Enter activates ------------------
	const focusedLabel = () =>
		page.evaluate(() => document.querySelector('#hud-layer .hud-focused .hud-el')?.textContent ?? null);

	const first = await focusedLabel();
	h.check(first === 'Start', `the ring starts on the first button (${first})`);
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(200);
	const second = await focusedLabel();
	h.check(second === 'Options', `ArrowDown walks forward (${second})`);
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(200);
	const back = await focusedLabel();
	h.check(back === 'Start', `ArrowUp walks back (${back})`);
	// it WRAPS, so a player cannot get lost off the end of a list
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(200);
	const wrapped = await focusedLabel();
	h.check(wrapped === 'Quit', `and it wraps rather than sticking (${wrapped})`);

	const before = await counts();
	await page.keyboard.press('Enter');
	await page.waitForTimeout(700);
	const afterEnter = await counts();
	h.check(
		afterEnter.quit === before.quit + 1,
		`Enter fires the FOCUSED button through the replicated nodetrigger path (quit ${before.quit} -> ${afterEnter.quit})`
	);
	h.check(
		afterEnter.start === before.start,
		`and only that one (start stayed ${afterEnter.start})`
	);

	// 21-E3: Tab drives the ring ONLY UNDER A HELD LOCK - pointer-free (the menu substate)
	// native DOM tabbing over the opted-in controls takes over, and a game binding
	// "hold Tab for the map" needs the key to reach keypress. Headless never holds a lock,
	// so both halves are pinned: bare Tab does NOT cycle; with pointerLockElement stubbed
	// to the renderer canvas it does.
	await page.keyboard.press('Tab');
	await page.waitForTimeout(200);
	const tabUnlocked = await focusedLabel();
	h.check(tabUnlocked === 'Quit', `without a held lock Tab leaves the ring alone (${tabUnlocked})`);
	await page.evaluate(() => {
		const canvases = [...document.querySelectorAll('canvas')];
		const target = canvases[canvases.length - 1]; // threlte's, not DungeonMinimap's hidden one
		Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => target });
	});
	await page.keyboard.press('Tab');
	await page.waitForTimeout(200);
	const afterTab = await focusedLabel();
	await page.evaluate(() => {
		Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null });
	});
	h.check(afterTab === 'Start', `under a held lock Tab cycles (${afterTab})`);
	await page.keyboard.press('Space');
	await page.waitForTimeout(700);
	const afterSpace = await counts();
	h.check(
		afterSpace.start === afterEnter.start + 1,
		`Space activates as well (start ${afterEnter.start} -> ${afterSpace.start})`
	);

	// ---- 3. the MOUSE still works whenever the pointer is free --------------
	const mouse = await page.evaluate(() => {
		const btn = [...document.querySelectorAll('#hud-layer button')].find(
			(b) => b.textContent === 'Options'
		);
		const r = btn.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	const hit = await page.evaluate(
		(pt) => document.elementFromPoint(pt.x, pt.y)?.textContent,
		mouse
	);
	h.check(hit === 'Options', `premise: a real click lands on the button (elementFromPoint = ${hit})`);
	await page.mouse.click(mouse.x, mouse.y);
	await page.waitForTimeout(400);
	// Options has no hudbutton node, so nothing should pulse — proving a press only fires
	// the node BOUND to that element id
	const afterMouse = await counts();
	h.check(
		afterMouse.start === afterSpace.start && afterMouse.quit === afterSpace.quit,
		`a button with no bound node pulses nothing (${JSON.stringify(afterMouse)})`
	);

	// ---- 4. the HUD does not steal keys from TEXT ENTRY ---------------------
	const typing = await page.evaluate(async () => {
		const input = document.createElement('input');
		input.id = 'hud-typing-probe';
		input.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999';
		document.body.append(input);
		input.focus();
		return document.activeElement?.id;
	});
	h.check(typing === 'hud-typing-probe', 'premise: a text field has focus');
	const ringBefore = await focusedLabel();
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(250);
	const ringAfter = await focusedLabel();
	h.check(
		ringBefore === ringAfter,
		`an arrow inside a text field does NOT move the HUD ring (${ringBefore} -> ${ringAfter})`
	);
	await page.evaluate(() => document.querySelector('#hud-typing-probe')?.remove());

	// ---- 5. THE CANNOT-SHIP RISK: Escape still leaves play mode -------------
	const escape = await page.evaluate(async () => {
		const s = window.__stores;
		// already in play mode from the top of the suite; kept so this section still
		// stands alone if it is ever run on its own
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 700));
		return {
			locked: (() => {
				let v;
				s.isLocked.subscribe((x) => (v = x))();
				return v;
			})(),
			hudUp: !!document.querySelector('#hud-layer .hud-focused'),
			claims: s.inputRuntime.isClaimed('keys')
		};
	});
	h.check(escape.locked, 'premise: play mode is engaged');
	h.check(escape.hudUp, 'premise: the HUD screen is up, with the ring live');
	h.check(escape.claims, 'premise: the HUD holds the keys claim');

	// the HUD must NOT consume Escape. Watched at WINDOW level in the BUBBLE phase, which
	// is where PointerLockControls' own document listener sits — if the HUD's capture
	// handler called stopImmediatePropagation on it, nothing would arrive here.
	await page.evaluate(() => {
		window.__escSeen = [];
		window.addEventListener('keydown', (e) => {
			if (e.code === 'Escape') window.__escSeen.push({ prevented: e.defaultPrevented });
		});
	});
	await page.keyboard.press('Escape');
	await page.waitForTimeout(900);
	const afterEsc = await page.evaluate(() => {
		const s = window.__stores;
		let locked;
		s.isLocked.subscribe((x) => (locked = x))();
		return { escSeen: window.__escSeen, locked, claims: s.inputRuntime.isClaimed('keys') };
	});
	h.check(
		afterEsc.escSeen.length === 1,
		`Escape REACHES the bubble phase — the HUD never swallows it (${JSON.stringify(afterEsc.escSeen)})`
	);
	h.check(
		afterEsc.escSeen[0]?.prevented === false,
		'and it is not even preventDefault()ed, so the browser`s own pointer-lock exit still applies'
	);
	// `isLocked` is a THREE-state store, not a boolean: null = editor, ready to play ·
	// true = playing · false = just exited (transient — Controls turns it back to null with
	// a 2s cooldown). So the post-exit state is null, and the assertion is "no longer
	// playing", never "=== false".
	h.check(
		afterEsc.locked !== true,
		`AND PLAY MODE ACTUALLY EXITS with a HUD screen up — the cannot-ship risk (locked=${JSON.stringify(afterEsc.locked)})`
	);

	// ---- 6. the claim is RELEASED when the HUD goes away -------------------
	// A claim left standing pauses editor fly for good, which is the same bug from the
	// other end: not stuck in a screen, but unable to move afterwards.
	const released = await page.evaluate(async () => {
		const s = window.__stores;
		// a screen with no buttons at all
		s.hudDocs.setHudDocFor('scene', {
			screens: [{ id: 'hudless', name: 'Hudless', elements: [{ id: 'only-text', kind: 'text', label: 'no buttons' }] }],
			active: 'hudless'
		});
		await new Promise((r) => setTimeout(r, 700));
		const afterTextOnly = s.inputRuntime.isClaimed('keys');
		s.hudDocs.setHudDocFor('scene', null);
		await new Promise((r) => setTimeout(r, 700));
		return { afterTextOnly, afterDelete: s.inputRuntime.isClaimed('keys') };
	});
	h.check(
		released.afterTextOnly === false,
		`a screen with no buttons claims NOTHING — a claim is for a keyboard menu (${released.afterTextOnly})`
	);
	h.check(
		released.afterDelete === false,
		`and deleting the document releases it (${released.afterDelete})`
	);

	// editor navigation works again, which is what the release is FOR
	const navBack = await page.evaluate(() => !window.__stores.inputRuntime.isClaimed('keys'));
	h.check(navBack, 'so editor fly and play WASD are back');

	await h.finish(browser);
});
