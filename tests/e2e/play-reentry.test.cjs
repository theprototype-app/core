// W3: two things that both left the play button looking broken.
//
// FIX 1 — Esc, then play again, IMMEDIATELY. playMode.js used to hold play shut for a
// flat 2000ms after every exit, because Chromium refuses `requestPointerLock` for
// about a second after a USER-INITIATED Esc. That is a real browser rule, but paying
// for it on the BUTTON was the wrong layer (every other exit path — programmatic
// stop, menu substate, a HUD button — was charged for a rule it is not subject to)
// and the wrong price (two seconds for a one-second refusal). The wall is gone;
// PointerLockControls RETRIES the lock instead, on both failure signals the platform
// offers, and stops the moment it lands.
//
// FIX 2 — deny the immersive permission and the context menu dies. `requestPlay`
// sets `isVRMode` optimistically one line before clicking the hidden XR button, and
// NOTHING put it back: `sessionend` is the only reset in the app and a rejected
// `requestSession` fires no session events, while threlte's XRButton swallows the
// rejection into an `onerror` prop no call site passed. Stuck true, `isLocked`
// untouched, so the app LOOKS normal — but Scene's `openViewportMenuAt` refuses
// while it holds, and that is the one writer of the viewport AND object context
// menus, so right-click, the touch long-press and the mobile "+" all go silently
// dead. That is the report verbatim.
const h = require('./helpers.cjs');

const lockedState = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))()));

const vrState = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.isVRMode.subscribe((v) => r(v))()));

/**
 * A page whose `navigator.xr` says immersive-vr is SUPPORTED and whose
 * `requestSession` REJECTS the way a denied permission does. That is the whole
 * scenario: with a real support answer threlte's button labels itself "Enter VR",
 * which is what `requestPlay`'s own guard checks, so the ordinary click path runs
 * end to end — the button, `toggleXRSession`, the rejection and `onerror`. Headless
 * Chromium's real `navigator.xr` answers "unsupported", so without this the XR
 * branch is unreachable and the whole fix would go untested.
 *
 * setupPage cannot take an extra init script, so this mirrors the parts of it that
 * matter (the localStorage seeds, the settle, the debugStores wait).
 */
async function xrDeniedPage(browser) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	await ctx.addInitScript(() => {
		/** @type {any} */ (window).__xrCalls = { supported: 0, requested: 0 };
		const stub = {
			isSessionSupported: (mode) => {
				/** @type {any} */ (window).__xrCalls.supported++;
				return Promise.resolve(mode === 'immersive-vr');
			},
			requestSession: () => {
				/** @type {any} */ (window).__xrCalls.requested++;
				const err = new Error('Permission denied');
				err.name = 'NotAllowedError';
				return Promise.reject(err);
			},
			addEventListener() {},
			removeEventListener() {}
		};
		Object.defineProperty(navigator, 'xr', { value: stub, configurable: true });
	});
	const page = await ctx.newPage();
	/** @type {string[]} */
	page.__errors = [];
	page.on('pageerror', (err) => {
		page.__errors.push(err.message ?? String(err));
		console.log('[XR pageerror] ' + err.stack);
	});
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForTimeout(4000);
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, {
		timeout: 30000
	});
	return page;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	/* ================================================================= section 1 ==
	 * The premise, and the round trip the wall used to block.
	 */
	h.check((await lockedState(A.page)) === null, 'premise: the app starts in the editor');
	// the desktop branch is what this page takes — headless Chromium answers
	// "unsupported" to both probes, which IS the desktop case
	const noXr = await A.page.evaluate(async () => ({
		vr: await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false),
		ar: await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)
	}));
	h.check(!noXr.vr && !noXr.ar, `premise: no immersive support here (vr=${noXr.vr} ar=${noXr.ar})`);

	await A.page.locator('#play-button').click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'play mode engaged');

	/* ================================================================= section 2 ==
	 * THE MEASUREMENT, and the whole point of the fix.
	 *
	 * Everything happens INSIDE the page, for two reasons that both turned out to
	 * matter. Timing the Playwright call would measure its actionability wait and the
	 * CDP round trips too — ~1.7s of noise on this box, most of the budget. Worse, it
	 * would also DELAY the press by that much, and a press that lands 1.7s after the
	 * exit has already outlived any wall shorter than that: the first version of this
	 * check stayed green with a 1500ms gate deliberately put back, which is a check
	 * that cannot fail. So the press is fired the instant the exit SETTLES, from the
	 * store subscription itself, which is the earliest a user could possibly click.
	 */
	const reentry = A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const store = window.__stores.isLocked;
				let sawExit = false;
				let pressed = 0;
				let done = false;
				const stop = store.subscribe((v) => {
					if (v === false) sawExit = true;
					// settled after the exit: press play RIGHT NOW
					else if (sawExit && !pressed && v === null) {
						pressed = performance.now();
						document.getElementById('play-button')?.click();
					} else if (pressed && !done && v === true) {
						done = true;
						resolve({ elapsed: Math.round(performance.now() - pressed), sawExit });
					}
				});
				setTimeout(() => {
					if (!done) resolve({ elapsed: -1, sawExit });
					stop();
				}, 6000);
			})
	);
	await A.page.keyboard.press('Escape');
	const { elapsed, sawExit } = await reentry;
	// read from the same observer, not from a poll: re-entry is instant now, so a
	// polled "did it leave play" check races the press and reads `true` again
	h.check(sawExit, 'Escape leaves play mode');
	h.check(elapsed >= 0, `premise: the press-to-play latency was measured (${elapsed}ms)`);
	// 1900 names the old number (the wall queued the press and replayed it on a 2000ms
	// timer, so a press at the settle read ~2000) — but it is the SOFT line: a gate
	// anywhere under it would slip through. The one with teeth is 250, and it is the
	// one that went red when a 1500ms gate was put back to check: 1342ms.
	h.check(elapsed < 1900, `re-entry took ${elapsed}ms — no fixed cooldown left (was ~2000)`);
	h.check(elapsed < 250, `...and it is effectively instant (${elapsed}ms)`);
	await h.eventually(
		() => lockedState(A.page),
		(v) => v === true,
		'play re-enters immediately after Escape'
	);
	// and the state is genuinely play, not a flicker
	await A.page.waitForTimeout(300);
	h.check((await lockedState(A.page)) === true, 're-entered play mode is stable');

	/* ================================================================= section 3 ==
	 * A press inside the TRANSIENT still lands. `isLocked === false` is what the exit
	 * path writes and the settle turns to null on the next macrotask; a press that
	 * falls in that sliver is remembered and replayed there (21-F3), never eaten.
	 */
	const queued = await A.page.evaluate(async () => {
		const store = window.__stores.isLocked;
		const read = () => new Promise((r) => store.subscribe((v) => r(v))());
		// leave play and press the button in the SAME synchronous block, so the press
		// cannot help but land before the settle timer runs. `.click()` bubbles, which
		// is what svelte's delegated onclick needs.
		store.set(false);
		document.getElementById('play-button')?.click();
		const during = await read();
		await new Promise((r) => setTimeout(r, 300));
		return { during, after: await read() };
	});
	h.check(queued.during === false, 'premise: the press landed inside the false transient');
	h.check(queued.after === true, 'a press inside the transient is replayed, not eaten');

	/* ================================================================= section 4 ==
	 * THE RETRY. Headless never reproduces Chromium's post-Esc refusal, so the
	 * refusal is SIMULATED at the only place that matters — the lock request itself.
	 * Both signals are covered because both exist in the wild: modern Chromium
	 * returns a promise that rejects, the older signature returns undefined and only
	 * fires `pointerlockerror` on the document. Handling one alone would leave half
	 * the engines with the bug.
	 */
	await A.page.keyboard.press('Escape');
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'back to the editor for the retry checks');
	await A.page.waitForTimeout(200);

	// -- 4a: a REJECTED promise must be retried ------------------------------------
	const rejectRun = await A.page.evaluate(async () => {
		const proto = HTMLCanvasElement.prototype;
		const original = proto.requestPointerLock;
		let calls = 0;
		proto.requestPointerLock = function () {
			calls++;
			return Promise.reject(new Error('The user has exited the lock before this request was completed'));
		};
		window.__stores.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 1000));
		proto.requestPointerLock = original;
		const locked = await new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))());
		return { calls, locked };
	});
	h.check(rejectRun.calls >= 1, `premise: the stub saw the entry request (${rejectRun.calls} calls)`);
	h.check(
		// the PROPERTY is "it asked again"; pinning an exact count pins the beat and
		// the machine's load with it (3 on one run, 2 on the next)
		rejectRun.calls >= 2,
		`a refused lock is retried on a short beat (${rejectRun.calls} attempts in 1s)`
	);
	h.check(rejectRun.locked === true, 'play mode is NOT abandoned while the retry runs');

	// leave cleanly
	await A.page.evaluate(() => window.__stores.isLocked.set(false));
	await A.page.waitForTimeout(300);

	// -- 4b: the pointerlockerror signal (old signature, no promise) ----------------
	const errorRun = await A.page.evaluate(async () => {
		const proto = HTMLCanvasElement.prototype;
		const original = proto.requestPointerLock;
		let calls = 0;
		// the OLD signature: returns undefined, failure arrives as a document event
		proto.requestPointerLock = function () {
			calls++;
			setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
			return undefined;
		};
		window.__stores.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 1000));
		proto.requestPointerLock = original;
		return { calls };
	});
	h.check(
		errorRun.calls >= 2,
		`a pointerlockerror is retried too (${errorRun.calls} attempts in 1s)`
	);

	// -- 4c: the retry STOPS when play stops (no runaway timer) ---------------------
	const stopped = await A.page.evaluate(async () => {
		const proto = HTMLCanvasElement.prototype;
		const original = proto.requestPointerLock;
		let calls = 0;
		proto.requestPointerLock = function () {
			calls++;
			return Promise.reject(new Error('refused'));
		};
		window.__stores.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 400));
		const during = calls;
		window.__stores.isLocked.set(false);
		await new Promise((r) => setTimeout(r, 900));
		proto.requestPointerLock = original;
		return { during, after: calls };
	});
	h.check(stopped.during >= 1, `premise: the retry was running (${stopped.during} attempts)`);
	h.check(
		stopped.after === stopped.during,
		`leaving play stops the retry (${stopped.during} -> ${stopped.after})`
	);
	await A.page.waitForTimeout(400);
	h.check((await lockedState(A.page)) !== true, 'and the editor is back');

	/* ================================================================= section 5 ==
	 * FIX 2, through the REAL click path: a denied immersive session must not leave
	 * the editor unusable.
	 */
	const X = await xrDeniedPage(browser);

	// premise: this page really does think VR is available, which is what makes the
	// XR branch reachable at all
	const label = await X.evaluate(
		() => document.querySelector('#vrButtonVr button')?.textContent?.trim() ?? ''
	);
	h.check(label.startsWith('Enter'), `premise: the hidden VR button offers a session ("${label}")`);
	h.check((await vrState(X)) === false, 'premise: not in VR mode yet');
	const fabTitle = await X.evaluate(
		() => document.getElementById('play-button')?.getAttribute('title') ?? ''
	);
	h.check(fabTitle !== 'Play', `premise: the FAB knows this press means a headset ("${fabTitle}")`);

	// the press: requestPlay sets isVRMode optimistically and clicks the button,
	// whose requestSession rejects
	await X.locator('#play-button').click();
	await h.eventually(
		() => X.evaluate(() => /** @type {any} */ (window).__xrCalls.requested),
		(n) => n >= 1,
		'the press really asked for a session'
	);

	// THE FIX: onerror puts the mode back, well inside the watchdog's 6s
	await h.eventually(
		() => vrState(X),
		(v) => v === false,
		'a denied session clears VR mode (onerror recovery)'
	);
	h.check((await lockedState(X)) !== true, 'and it did not fall into desktop play instead');

	/* ================================================================= section 6 ==
	 * The actual REPORT: the context menu works again. Asserted with a real
	 * right-click, because the guard that broke it lives inside the opener the
	 * browser event reaches — not in any store a check could read.
	 */
	// the RENDERER's own canvas, never `locator('canvas').first()` — DungeonMinimap
	// mounts a hidden canvas ahead of threlte's, so the first one has no box at all
	const box = await X.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalRenderer.subscribe((renderer) => {
					const element = renderer?.domElement;
					if (!element) return resolve(null);
					const r = element.getBoundingClientRect();
					resolve({ x: r.x, y: r.y, width: r.width, height: r.height });
				})();
			})
	);
	h.check(!!box && box.width > 0, 'premise: the viewport canvas is on screen');
	const at = { x: Math.round(box.x + box.width * 0.4), y: Math.round(box.y + box.height * 0.55) };
	const onCanvas = await X.evaluate(
		(p) => document.elementFromPoint(p.x, p.y)?.tagName ?? '',
		at
	);
	h.check(onCanvas === 'CANVAS', `premise: that pixel is the canvas, not chrome (${onCanvas})`);

	await X.mouse.click(at.x, at.y, { button: 'right' });
	await h.eventually(
		() => X.evaluate(() => document.querySelectorAll('[role="menuitem"]').length),
		(n) => n > 0,
		'right-click opens the viewport context menu after a denied session'
	);
	await X.keyboard.press('Escape');
	await X.waitForTimeout(200);

	// and the play button is RE-ARMED: a second press asks for a session again
	const before = await X.evaluate(() => /** @type {any} */ (window).__xrCalls.requested);
	await X.locator('#play-button').click();
	await h.eventually(
		() => X.evaluate(() => /** @type {any} */ (window).__xrCalls.requested),
		(n) => n > before,
		'the play button is re-armed after a denial'
	);
	await h.eventually(() => vrState(X), (v) => v === false, 'and recovers a second time');

	/* ================================================================= section 7 ==
	 * THE COUNTERFACTUAL for section 6, in-page: this is what the bug looked like.
	 * With `isVRMode` stuck true the very same right-click opens NOTHING — which is
	 * the whole reason the recovery has to exist, and proof the check above is not
	 * passing for some unrelated reason.
	 */
	await X.evaluate(() => window.__stores.isVRMode.set(true));
	await X.waitForTimeout(200);
	await X.mouse.click(at.x, at.y, { button: 'right' });
	await X.waitForTimeout(500);
	const deadMenu = await X.evaluate(
		() => document.querySelectorAll('[role="menuitem"]').length
	);
	h.check(deadMenu === 0, `counterfactual: stuck VR mode really does kill the menu (${deadMenu} rows)`);
	await X.evaluate(() => window.__stores.isVRMode.set(false));
	await X.waitForTimeout(200);
	await X.mouse.click(at.x, at.y, { button: 'right' });
	await h.eventually(
		() => X.evaluate(() => document.querySelectorAll('[role="menuitem"]').length),
		(n) => n > 0,
		'...and clearing it brings the menu straight back'
	);
	await X.keyboard.press('Escape');

	await h.finish(browser);
});
