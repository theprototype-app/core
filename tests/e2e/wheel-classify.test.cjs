// 24-A2: the wheel is classified by DEVICE SIGNATURE, not magnitude. The old rule
// ("a pixel-mode delta under 40px is a trackpad") panned on every notch of a Linux
// Chromium high-resolution wheel (the Steam Deck's trackpad-as-wheel emits 3-15px
// ticks) and the dolly never fired. Now: `wheelDeltaY` notch multiples, integer
// vertical-only deltas of notch size, and a SPARSE cadence are a wheel; dense,
// two-axis, fractional streams are a trackpad; a lone vertical-only first sample is
// HELD for TRACKPAD_DENSE_MS and replayed as a notch if nothing follows.
//
// `wheelDeltaY` cannot be set on a synthetic WheelEvent, so the notch-multiple branch
// is covered by the Settings readout on real hardware (the Deck's own numbers); the
// cadence + integer rules and the hold are proven here.
const h = require('./helpers.cjs');

/** camera-to-target distance + the target, read together */
const view = (page) =>
	page.evaluate(
		() =>
			new Promise((r) => {
				window.__stores.globalCamera.subscribe((c) => {
					window.__stores.orbitControls.subscribe((o) => r({ dist: c.position.distanceTo(o.target), target: o.target.toArray() }))();
				})();
			})
	);
const moved = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** dispatch `count` synthetic wheel events on the canvas, `spacingMs` apart */
const stream = (page, init, count, spacingMs) =>
	page.evaluate(
		async ({ init, count, spacingMs }) => {
			const canvas = await new Promise((r) => window.__stores.globalRenderer.subscribe((x) => r(x?.domElement))());
			for (let i = 0; i < count; i++) {
				canvas.dispatchEvent(
					new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, clientX: 500, clientY: 350, ...init })
				);
				await new Promise((r) => setTimeout(r, spacingMs));
			}
		},
		{ init, count, spacingMs }
	);
const mode = (page, value) => page.evaluate((v) => window.__stores.trackpadNav.trackpadMode.set(v), value);
const settle = (page) => page.waitForTimeout(600); // gesture window (250ms) + damping

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	// the viewport must be the only thing under the wheel; no panel, no selection
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(300);

	// --- 1. a hi-res wheel: small vertical ticks, sparse -> DOLLY, target still --------
	let before = await view(A.page);
	await stream(A.page, { deltaY: 8, deltaX: 0 }, 5, 100);
	await settle(A.page);
	let after = await view(A.page);
	h.check(
		Math.abs(after.dist - before.dist) > 0.05,
		`sparse 8px vertical ticks dolly the camera (distance ${before.dist.toFixed(2)} -> ${after.dist.toFixed(2)})`
	);
	h.check(moved(before.target, after.target) < 0.01, `...and the target stays put (moved ${moved(before.target, after.target).toFixed(3)})`);

	// --- 2. a trackpad: fractional, two-axis, dense -> PAN, distance unchanged ---------
	await settle(A.page);
	before = await view(A.page);
	await stream(A.page, { deltaY: 3.5, deltaX: 1.2 }, 20, 8);
	await settle(A.page);
	after = await view(A.page);
	h.check(moved(before.target, after.target) > 0.01, `dense two-axis stream pans (target moved ${moved(before.target, after.target).toFixed(3)})`);
	h.check(Math.abs(after.dist - before.dist) < 0.01, `...without dollying (distance ${before.dist.toFixed(3)} -> ${after.dist.toFixed(3)})`);
	// A2.3: the one-time hint pointed at the override
	// read through the notification HISTORY (every toast lands there, and it persists) as
	// well as the live toast stack — the toast itself dismisses after 5s
	const hint = await A.page.evaluate(
		() =>
			new Promise((r) => {
				window.__stores.toastStore.subscribe((t) => {
					window.__stores.notifications.subscribe((n) =>
						r({ toasts: t.map((x) => (typeof x === 'string' ? x : x.text)), history: n.slice(-5).map((x) => x.text) })
					)();
				})();
			})
	);
	h.check(
		[...hint.toasts, ...hint.history].some((t) => /Mouse wheel/.test(t || '')),
		`the first auto pan shows the one-time hint (${JSON.stringify(hint)})`
	);
	h.check((await A.page.evaluate(() => localStorage.getItem('wheelHintSeen'))) === '1', 'wheelHintSeen is stored');

	// --- 3. a VERTICAL-ONLY trackpad swipe: dense, deltaX 0 -> still a pan (the hold) ---
	await settle(A.page);
	before = await view(A.page);
	await stream(A.page, { deltaY: 2.5, deltaX: 0 }, 20, 8);
	await settle(A.page);
	after = await view(A.page);
	h.check(moved(before.target, after.target) > 0.01, `dense vertical-only stream pans (target moved ${moved(before.target, after.target).toFixed(3)})`);
	h.check(Math.abs(after.dist - before.dist) < 0.01, `...and its first sample did NOT dolly (distance ${before.dist.toFixed(3)} -> ${after.dist.toFixed(3)})`);

	// --- 4. a classic Chromium notch (integer >= 40px) is a wheel at ANY cadence -------
	await settle(A.page);
	before = await view(A.page);
	await stream(A.page, { deltaY: 53, deltaX: 0 }, 4, 12);
	await settle(A.page);
	after = await view(A.page);
	h.check(Math.abs(after.dist - before.dist) > 0.05, `53px integer notches dolly even 12ms apart (distance ${before.dist.toFixed(2)} -> ${after.dist.toFixed(2)})`);
	h.check(moved(before.target, after.target) < 0.01, '...target still');

	// --- 5. a single lone tick is a notch: held, then replayed to OrbitControls --------
	await settle(A.page);
	before = await view(A.page);
	await stream(A.page, { deltaY: 5, deltaX: 0 }, 1, 0);
	await settle(A.page);
	after = await view(A.page);
	h.check(Math.abs(after.dist - before.dist) > 0.01, `one lone 5px tick still dollies after the hold (distance ${before.dist.toFixed(3)} -> ${after.dist.toFixed(3)})`);

	// --- 6. the override wins: 'on' pans a wheel, 'off' dollies a trackpad ------------
	await mode(A.page, 'on');
	await settle(A.page);
	before = await view(A.page);
	await stream(A.page, { deltaY: 53, deltaX: 0 }, 3, 100);
	await settle(A.page);
	after = await view(A.page);
	h.check(moved(before.target, after.target) > 0.01 && Math.abs(after.dist - before.dist) < 0.01, `mode 'on' (Pan): notches pan (target ${moved(before.target, after.target).toFixed(3)}, distance Δ${(after.dist - before.dist).toFixed(3)})`);
	await mode(A.page, 'off');
	await settle(A.page);
	before = await view(A.page);
	await stream(A.page, { deltaY: 3.5, deltaX: 1.2 }, 10, 8);
	await settle(A.page);
	after = await view(A.page);
	h.check(Math.abs(after.dist - before.dist) > 0.05 && moved(before.target, after.target) < 0.01, `mode 'off' (Zoom): a swipe dollies (distance Δ${(after.dist - before.dist).toFixed(3)}, target ${moved(before.target, after.target).toFixed(3)})`);
	await mode(A.page, 'auto');

	// --- 7. two-finger pan OFF: everything zooms (unchanged) ---------------------------
	await A.page.evaluate(() => window.__stores.trackpadNav.panEnabled.set(false));
	await settle(A.page);
	before = await view(A.page);
	await stream(A.page, { deltaY: 3.5, deltaX: 1.2 }, 10, 8);
	await settle(A.page);
	after = await view(A.page);
	h.check(Math.abs(after.dist - before.dist) > 0.05, `pan disabled: a swipe zooms (distance Δ${(after.dist - before.dist).toFixed(3)})`);
	await A.page.evaluate(() => window.__stores.trackpadNav.panEnabled.set(true));

	// --- 8. the readout: a ring of the last 8, with the verdicts -----------------------
	const log = await A.page.evaluate(() => new Promise((r) => window.__stores.trackpadNav.lastWheelEvents.subscribe((l) => r(l))()));
	h.check(log.length === 8, `lastWheelEvents keeps 8 entries (${log.length})`);
	h.check(log.every((s) => typeof s.dt === 'number' && typeof s.deltaY === 'number' && /^(wheel|trackpad|pinch)$/.test(s.kind) && s.why), 'every sample carries dt, deltas, a verdict and a reason');
	const kinds = await A.page.evaluate(() => {
		const { classifyWheelSignature } = window.__stores.trackpadNav;
		const ev = (init) => new WheelEvent('wheel', { deltaMode: 0, ...init });
		return {
			lines: classifyWheelSignature(ev({ deltaMode: 1, deltaY: 3 }))?.kind,
			bigInt: classifyWheelSignature(ev({ deltaY: 100, deltaX: 0 }))?.kind,
			twoAxis: classifyWheelSignature(ev({ deltaY: 3.5, deltaX: 1.2 }))?.kind,
			ambiguous: classifyWheelSignature(ev({ deltaY: 8, deltaX: 0 })),
			fractional: classifyWheelSignature(ev({ deltaY: 8.33, deltaX: 0 }))
		};
	});
	h.check(kinds.lines === 'wheel' && kinds.bigInt === 'wheel' && kinds.twoAxis === 'trackpad', `signature: lines/big-integer = wheel, two-axis = trackpad (${JSON.stringify(kinds)})`);
	h.check(kinds.ambiguous === null && kinds.fractional === null, 'a small vertical-only sample is ambiguous by signature (cadence decides)');
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('controls');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForSelector('#wheel-diagnostics', { timeout: 15000 });
	const rows = await A.page.evaluate(() => document.querySelectorAll('#wheel-diagnostics tbody tr').length);
	h.check(rows === 8, `Settings ▸ Controls ▸ Wheel diagnostics renders the ring (${rows} rows)`);
	const head = await A.page.evaluate(() => document.querySelector('#wheel-diagnostics p')?.textContent?.trim());
	h.check(/pointer: (fine|coarse)/.test(head || '') && /wheel mode: auto/.test(head || ''), `...with the platform line (${JSON.stringify(head)})`);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(300);

	// --- 9. Viewport menu ▸ View ▸ Mouse wheel writes the override ---------------------
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 200, y: 160, point: { x: 0, y: 0, z: 0 } }));
	await A.page.waitForTimeout(300);
	await A.page.locator('[role="menuitem"]', { hasText: 'View' }).first().hover();
	await A.page.waitForTimeout(400);
	// submenus are DOM CHILDREN of their parent row, so an ancestor's textContent also
	// matches — the deepest (last) match is the row itself
	const wheelRow = A.page.locator('[role="menuitem"]', { hasText: 'Mouse wheel' }).last();
	h.check((await wheelRow.count()) === 1, 'View submenu lists "Mouse wheel"');
	await wheelRow.hover();
	await A.page.waitForTimeout(400);
	const zoomRow = A.page.locator('[role="menuitem"]', { hasText: 'Zoom (mouse wheel)' }).last();
	h.check((await zoomRow.count()) === 1, '...with Zoom / Pan / Auto beneath it');
	await zoomRow.click();
	await A.page.waitForTimeout(200);
	const picked = await A.page.evaluate(() => new Promise((r) => window.__stores.trackpadNav.trackpadMode.subscribe((m) => r(m))()));
	h.check(picked === 'off', `picking Zoom sets trackpadMode 'off' (${picked})`);
	await mode(A.page, 'auto');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	await h.finish(browser);
});
