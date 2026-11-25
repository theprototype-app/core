// 105-noise (roadmap 105 T4a) — THE NOISE PANEL BY TOUCH, ON THE PHONE TIER (emulated: the lane's stand-in for the
// HONOR row, which needs the Deck's device lab — QUESTIONS-105-noise Q3).
//
//   §1  the phone tier: a phone UA makes deviceClass "phone"
//   §2  the editor on a 1600 px image with the Noise panel: the "over 1024 px on a phone" note shows; the kind, the new
//       seed and Apply are TAPPED (each is the thing under the finger, not covered by the bottom bar); Apply lands as
//       one editor undo step
//   §3  Fill with noise on an empty Roughness row: the size dialog warns about 2048 on a phone; a tap on 1024 fills it
//
// Run: APP_URL='https://localhost:7208/' npm run e2e -- image-noise-touch
const h = require('./helpers.cjs');

async function until(fn, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}
const S = (p, fn, arg) => p.page.evaluate(fn, arg);
const OUT = 'test-results/105-noise';

/** is the element's centre the thing a tap there would hit? */
const underFinger = (p, sel) =>
	S(p, (s) => {
		const el = document.querySelector(s);
		if (!el) return false;
		el.scrollIntoView({ block: 'center' });
		const b = el.getBoundingClientRect();
		const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
		return !!hit && (hit === el || el.contains(hit) || !!hit.closest(s));
	}, sel);

/** tap an element after checking it is what the finger lands on @param {any} p @param {string} sel @param {string} label */
async function tapChecked(p, sel, label) {
	const ok = await underFinger(p, sel);
	h.check(ok, `${label}: ${sel} is what a tap lands on`);
	await p.page.locator(sel).first().tap();
	await p.page.waitForTimeout(250);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const P = await h.setupPage(browser, 'P', {
		context: { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, userAgent: h.N6_UA }
	});

	// ---- §1 the phone tier --------------------------------------------------------------------
	const cls = await S(P, async () => {
		const m = window.__tp.test.v1.deviceClass;
		let v;
		m.deviceClass.subscribe((x) => (v = x))();
		return v;
	});
	h.check(cls === 'phone', `PREMISE: the phone tier (deviceClass ${cls})`);

	// ---- §2 the panel by touch ---------------------------------------------------------------------
	const id = await S(P, async () => {
		const s = window.__tp.test.v1;
		const r = await s.noiseRun.renderNoise({ kind: 'value', colors: ['#204060', '#a0c0e0'] }, { width: 1600, height: 1600 });
		const blob = await s.imageEditor.encodeImage(r, { type: 'image/png' });
		const rec = await s.explorer.addItemFromBytes(await blob.arrayBuffer(), 'phone1600.png', null, { type: 'image/png' });
		s.imageEditor.openImageEditor(rec.id, { panel: 'noise' });
		return rec.id;
	});
	await P.page.locator('#image-editor-window').waitFor({ timeout: 15000 });
	await until(async () => /1600 × 1600/.test((await P.page.locator('#image-editor-size').textContent()) ?? ''), 15000);
	await S(P, () => document.querySelectorAll('.toasts-stack .tp-toast-x').forEach((b) => b.click()));
	// on a phone the side panel starts hidden: open the Edit pane the way a finger does
	if (!(await P.page.locator('#image-noise-apply').isVisible().catch(() => false))) await h.openWsMode(P.page, '#image-editor-window', 'edit', { tap: true });
	await P.page.locator('#image-noise-apply').waitFor({ timeout: 10000 });
	h.check(await P.page.locator('#image-noise-phone-warn').isVisible(), 'the panel says a > 1024 px image is slow on a phone');
	await until(async () => (await P.page.locator('#image-editor-noise-badge').count()) === 1, 15000);
	h.check((await P.page.locator('#image-editor-noise-badge').count()) === 1, 'the live preview is on the canvas');
	await P.page.screenshot({ path: OUT + '/phone-noise-panel.png' });
	await tapChecked(P, '#image-noise-kind [role="radio"]:nth-child(3)', 'the Cells kind');
	h.check((await P.page.locator('#image-noise-kind [role="radio"][aria-checked="true"]').textContent())?.trim() === 'Cells', 'the tap picked Cells');
	const seed0 = await P.page.locator('#image-noise-seed input, #image-noise-seed').first().inputValue().catch(() => null);
	await tapChecked(P, '#image-noise-new-seed', 'New seed');
	const seed1 = await P.page.locator('#image-noise-seed input, #image-noise-seed').first().inputValue().catch(() => null);
	h.check(seed0 !== null && seed1 !== null && seed0 !== seed1, `a tap on New seed changes the seed (${seed0} → ${seed1})`);
	await tapChecked(P, '#image-noise-apply', 'Apply noise');
	await until(async () => !(await P.page.locator('#image-editor-undo').isDisabled()), 30000);
	h.check(!(await P.page.locator('#image-editor-undo').isDisabled()), 'Apply by touch is one editor undo step');
	h.check((await P.page.locator('#image-editor-noise').count()) === 0, 'and closes the panel');
	void id;
	await S(P, () => window.__tp.test.v1.imageEditor.closeImageEditor());
	await P.page.locator('#confirm-dialog-close').tap({ timeout: 4000 }).catch(() => {});
	await P.page.waitForTimeout(500);

	// ---- §3 the size dialog on a phone ----------------------------------------------------------------
	await S(P, () => window.__tp.test.v1.commandsHandler.sceneCommand('/create Box 1 1 1'));
	await P.page.waitForTimeout(800);
	const box = await S(P, async () => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	const filling = S(P, (u) => window.__tp.test.v1.noiseFill.fillSlotWithNoise({ uuids: [u], key: 'roughnessMap' }), box);
	await P.page.locator('#confirm-dialog-2048').waitFor({ timeout: 10000 });
	const big = (await P.page.locator('#confirm-dialog-2048').textContent()) ?? '';
	const body = await S(P, () => document.querySelector('#confirm-dialog-2048')?.closest('[role="dialog"], .modal, dialog')?.textContent ?? document.body.innerText);
	h.check(/slow on a phone/.test(big), `2048 is marked slow on a phone ("${big.trim()}")`);
	h.check(/above 1024 are slow/.test(body ?? ''), 'and the dialog says why');
	await P.page.screenshot({ path: OUT + '/phone-fill-dialog.png' });
	await tapChecked(P, '#confirm-dialog-1024', 'the 1024 size');
	await filling.catch(() => {});
	const w = await until(
		() =>
			S(P, async (u) => {
				const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
				const img = g.getObjectByProperty('uuid', u)?.material?.roughnessMap?.image;
				return (img?.naturalWidth || img?.width || 0) === 1024;
			}, box),
		20000
	);
	h.check(w, 'a tap on 1024 filled the Roughness row at 1024');

	h.check(h.pageErrors(P).length === 0, `no page errors (${JSON.stringify(h.pageErrors(P).slice(0, 3))})`);
	await h.finish(browser);
});
