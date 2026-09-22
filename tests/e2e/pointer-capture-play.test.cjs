// 30 P0 — THE POINTER-CAPTURE THROW. ~100 errors on a Quest were one per press.
//
// three 0.185's OrbitControls.onPointerDown calls `domElement.setPointerCapture` with
// no guard, and the editor's <OrbitControls> stays MOUNTED in play (only its zoom
// stands down). Chromium refuses a pointer capture while the page holds a pointer
// lock — InvalidStateError — and the throw lands before `_addPointer`, so EVERY press
// in play threw once and, after leaving play, surfaced as "Something went wrong".
//
// Headless has no real pointer lock, so the suite supplies Chromium's rule itself: a
// `document.pointerLockElement` getter that answers the canvas while "locked", and a
// prototype `setPointerCapture` that throws InvalidStateError exactly when one is set.
// That model is checked FIRST (premise), so the suite cannot pass by the stub doing
// nothing. The fix has two independent halves and each has its own check:
//   (1) the editor OrbitControls is DISABLED while isLocked === true, so its
//       onPointerDown returns before the capture (checked on the instance itself);
//   (2) the capture on the canvas wrapper is GUARDED under a lock, for the moment
//       something re-enables the controls (TransformControls' unmount cleanup does,
//       unconditionally) — checked by re-enabling it by hand and pressing again.

const h = require('./helpers.cjs');

const PRESSES = 20;

/** real CDP presses at the canvas centre; returns how many pointerdowns the canvas saw */
async function pressCanvas(page, n) {
	const box = await page.evaluate(() => {
		let renderer = null;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const r = renderer.domElement.getBoundingClientRect();
		window.__p0downs = 0;
		renderer.domElement.addEventListener('pointerdown', () => window.__p0downs++, { once: false });
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	for (let i = 0; i < n; i++) {
		await page.mouse.move(box.x + (i % 5), box.y + (i % 3));
		await page.mouse.down();
		await page.mouse.up();
		await page.waitForTimeout(30);
	}
	return page.evaluate(() => window.__p0downs);
}

const captureErrors = (peer) => h.pageErrors(peer).filter((m) => /setPointerCapture|InvalidStateError/.test(m));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// Chromium's rule, installed on the prototype so every element obeys it
	await page.evaluate(() => {
		let locked = null;
		Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => locked });
		window.__p0lock = (on) => {
			let renderer = null;
			window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
			locked = on ? renderer.domElement : null;
		};
		const real = Element.prototype.setPointerCapture;
		Element.prototype.setPointerCapture = function (id) {
			if (document.pointerLockElement)
				throw new DOMException("Failed to execute 'setPointerCapture' on 'Element': InvalidStateError", 'InvalidStateError');
			return real.call(this, id);
		};
	});

	// a game-like scene: a floor, a crate, a collectible-ish marker
	await page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create sphere');
	});
	await page.waitForTimeout(800);

	// ---- premise: the model throws, the way Chromium does ----
	const premise = await page.evaluate(() => {
		window.__p0lock(true);
		try {
			document.body.setPointerCapture(1);
			return 'no throw';
		} catch (e) {
			return e.name;
		} finally {
			window.__p0lock(false);
		}
	});
	h.check(premise === 'InvalidStateError', `premise: a capture under the stubbed lock throws InvalidStateError (${premise})`);

	// ---- enter play with the lock held ----
	const before = captureErrors(A).length;
	await page.evaluate(() => {
		window.__p0lock(true);
		window.__stores.isLocked.set(true);
	});
	await page.waitForTimeout(600);
	const orbitInPlay = await page.evaluate(() => {
		let oc = null;
		window.__stores.orbitControls.subscribe((v) => (oc = v))();
		return oc ? oc.enabled : 'none';
	});
	h.check(orbitInPlay === false, `the editor OrbitControls stands down in play (enabled=${orbitInPlay})`);

	const downs = await pressCanvas(page, PRESSES);
	h.check(downs === PRESSES, `premise: the canvas really received ${PRESSES} pointerdowns (${downs})`);
	const inPlay = captureErrors(A).length - before;
	h.check(inPlay === 0, `ZERO setPointerCapture errors over ${PRESSES} presses in play (${inPlay})`);

	// ---- guard (2): something re-enables the controls mid-play (TransformControls'
	// unmount cleanup does exactly this) — the capture itself must still not throw ----
	const guardBefore = captureErrors(A).length;
	await page.evaluate(() => {
		let oc = null;
		window.__stores.orbitControls.subscribe((v) => (oc = v))();
		oc.enabled = true;
	});
	// press straight away, before the next frame can stand it down again
	const stomped = await page.evaluate(() => {
		let renderer = null;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const wrapper = renderer.domElement.parentElement;
		let oc = null;
		window.__stores.orbitControls.subscribe((v) => (oc = v))();
		oc.enabled = true;
		const errors = [];
		const onErr = (e) => { if (/setPointerCapture|InvalidStateError/.test(String(e.message))) errors.push(String(e.message)); };
		window.addEventListener('error', onErr);
		const ev = new PointerEvent('pointerdown', { pointerId: 1, button: 0, bubbles: true, clientX: 300, clientY: 300 });
		renderer.domElement.dispatchEvent(ev);
		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, bubbles: true }));
		document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, bubbles: true }));
		window.removeEventListener('error', onErr);
		return { sameEl: oc.domElement === wrapper || oc.domElement === renderer.domElement, errors };
	});
	await page.waitForTimeout(300);
	h.check(stomped.sameEl, 'premise: the OrbitControls listens on the canvas or its wrapper');
	const stompErrors = captureErrors(A).length - guardBefore + stomped.errors.length;
	h.check(stompErrors === 0, `a re-enabled OrbitControls under the lock still captures nothing (${stompErrors} errors)`);
	const reDisabled = await page.evaluate(() => {
		let oc = null;
		window.__stores.orbitControls.subscribe((v) => (oc = v))();
		return oc.enabled;
	});
	h.check(reDisabled === false, `...and the next frame stands it down again (enabled=${reDisabled})`);

	// ---- leave play: no "Something went wrong", and the editor still orbits ----
	await page.evaluate(() => {
		window.__p0lock(false);
		window.__stores.isLocked.set(false);
	});
	await page.waitForTimeout(2600); // Controls' own effect walks false -> null
	const toast = await page.evaluate(() => document.body.innerText.includes('Something went wrong'));
	h.check(!toast, 'no "Something went wrong" toast after leaving play');
	const locked = await page.evaluate(() => {
		let v;
		window.__stores.isLocked.subscribe((x) => (v = x))();
		return v;
	});
	h.check(locked !== true, `back in the editor (isLocked=${locked})`);
	const enabledAfter = await page.evaluate(() => {
		let oc = null;
		window.__stores.orbitControls.subscribe((v) => (oc = v))();
		return oc.enabled;
	});
	h.check(enabledAfter === true, `the editor OrbitControls is enabled again (${enabledAfter})`);

	const camBefore = await page.evaluate(() => {
		let cam = null;
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		return cam.position.toArray();
	});
	const box = await page.evaluate(() => {
		let renderer = null;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const r = renderer.domElement.getBoundingClientRect();
		return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.6 };
	});
	await page.mouse.move(box.x, box.y);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + i * 18, box.y - i * 4);
	await page.mouse.up();
	await page.waitForTimeout(600);
	const camAfter = await page.evaluate(() => {
		let cam = null;
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		return cam.position.toArray();
	});
	const moved = Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]);
	h.check(moved > 0.2, `a drag orbits the editor camera after Esc (moved ${moved.toFixed(2)})`);
	h.check(captureErrors(A).length === 0, `no capture error anywhere in the run (${captureErrors(A).length})`);

	await h.finish(browser);
});
