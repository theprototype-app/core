// phone-polish (owner ruling 2026-11-05) — INVISIBLE TAP AREAS. On a touch screen a small control keeps its look
// and gains a tap area up to 44 px that never reaches into a neighbour ($lib/ui/hitSlop + hitSlopCore).
// Measured, not believed:
//  1. desktop: nothing installed (no data-hs, no scans);
//  2. touch: the LAYOUT is identical with the slop on and off (every control's rect);
//  3. TAP ACCURACY: for every small control, a 7x7 grid over the 44 px square centred on it — the share of points
//     that land on THAT control rises with the slop on, and no point that landed on control X lands on control Y;
//  4. a real tap just outside a small ✕ closes its window.
const h = require('./helpers.cjs');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** the tap-accuracy probe (also in the HONOR audit): per small control, the 44 px square sampled 7x7 */
function tapAccuracy() {
	const SEL =
		'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio]';
	const ctl = (e) => e?.closest?.(SEL) ?? null;
	const vis = (e) => {
		const r = e.getBoundingClientRect();
		if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
		const s = getComputedStyle(e);
		return s.visibility !== 'hidden' && s.pointerEvents !== 'none';
	};
	const all = [...document.querySelectorAll(SEL)].filter((e) => !e.closest('.svelte-flow, canvas') && vis(e));
	const small = all.filter((e) => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height) < 43.5; });
	let samples = 0, onIt = 0;
	const owner = []; // per sample: which control (index in all) got it, -1 none
	for (const e of small) {
		const r = e.getBoundingClientRect();
		const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
		for (let i = 0; i < 7; i++)
			for (let j = 0; j < 7; j++) {
				const x = cx - 22 + (44 * (i + 0.5)) / 7, y = cy - 22 + (44 * (j + 0.5)) / 7;
				if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
				samples++;
				const hit = ctl(document.elementFromPoint(x, y));
				if (hit === e) onIt++;
				owner.push(hit ? all.indexOf(hit) : -1);
			}
	}
	return { small: small.length, samples, accuracy: samples ? Math.round((1000 * onIt) / samples) / 10 : 0, owner };
}
const rects = (page) =>
	page.evaluate(() => [...document.querySelectorAll('button, [role=button], [role=menuitem], [role=tab], a[href]')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); }).join('|'));
const slopOn = (page, on) => page.evaluate((on) => window.__stores.hitSlop.setHitSlopEnabled(on), on);

h.run(async () => {
	const browser = await h.launch();

	// 1. desktop
	const D = await h.setupPage(browser, 'desk');
	const d = await D.page.evaluate(() => ({ hs: document.querySelectorAll('[data-hs]').length, scans: window.__stores.hitSlop.hitSlopStats.scans }));
	h.check(d.hs === 0 && d.scans === 0, `desktop: not installed (${JSON.stringify(d)})`);
	await h.closePeer(D);

	for (const vp of [{ name: 'folded', width: 390, height: 844 }, { name: 'unfolded', width: 718, height: 587 }]) {
		const tag = (t) => `[${vp.name}] ${t}`;
		const P = await h.setupPage(browser, vp.name, { context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, viewport: { width: vp.width, height: vp.height } } });
		const page = P.page;
		// a busy screen: the Objects window (small ✕ / pin / filter buttons) over the editor chrome
		await page.evaluate(() => window.__stores.objectListClose.set(false));
		await nap(1500);
		// 1.63 ships it OFF (98-int fork (a), until lane hitslop-fix): installed and scanning, no tap area drawn
		const shipped = await page.evaluate(() => ({ on: window.__stores.hitSlop.hitSlopEnabled(), hs: document.querySelectorAll('[data-hs]').length, scans: window.__stores.hitSlop.hitSlopStats.scans }));
		h.check(!shipped.on && shipped.hs === 0 && shipped.scans > 0, tag(`ships off: installed, no tap area (${JSON.stringify(shipped)})`));
		await slopOn(page, true);
		await nap(300);
		const st = await page.evaluate(() => ({ ...window.__stores.hitSlop.hitSlopStats }));
		h.check(st.scans > 0 && st.slopped > 0, tag(`installed on touch: ${JSON.stringify(st)}`));

		// 2. layout unchanged
		await slopOn(page, false);
		await nap(200);
		const offRects = await rects(page);
		const off = await page.evaluate(tapAccuracy);
		await slopOn(page, true);
		await nap(200);
		const onRects = await rects(page);
		const on = await page.evaluate(tapAccuracy);
		h.check(offRects === onRects, tag('every control keeps its exact box (no layout change)'));

		// 3. accuracy
		h.check(on.small === off.small && on.samples === off.samples, tag(`same controls measured (${on.small} small, ${on.samples} points)`));
		h.check(on.accuracy > off.accuracy, tag(`tap accuracy on small controls: ${off.accuracy}% → ${on.accuracy}%`));
		let stolen = 0;
		for (let i = 0; i < on.owner.length; i++) if (off.owner[i] >= 0 && on.owner[i] >= 0 && on.owner[i] !== off.owner[i]) stolen++;
		h.check(stolen === 0, tag(`no point moved from one control to another (${stolen})`));
		console.log(tag(`TAP-ACCURACY off=${off.accuracy}% on=${on.accuracy}% small=${on.small} points=${on.samples}`));

		// 4. a real tap 5 px outside the Objects window's ✕
		const x = await page.evaluate(() => {
			const b = document.querySelector('#object-list .wc-close, #object-list [aria-label^="Close"]');
			if (!b) return null;
			const r = b.getBoundingClientRect();
			const s = getComputedStyle(b, b.getAttribute('data-hs')?.startsWith('b') ? '::before' : '::after');
			return { x: r.left + r.width / 2, y: r.bottom + Math.min(5, parseFloat(b.style.getPropertyValue('--hs-b')) - 1), hs: b.getAttribute('data-hs'), slopB: b.style.getPropertyValue('--hs-b'), h: r.height, top: s.top };
		});
		if (x && x.h >= 43.5) console.log(tag(`the Objects ✕ is already ${x.h} px here — no tap area needed`));
		else h.check(!!x && !!x.hs, tag(`the Objects ✕ has a tap area (${JSON.stringify(x)})`));
		if (x?.hs && x.y > 0) {
			await page.touchscreen.tap(x.x, x.y);
			await nap(800);
			const closed = await page.evaluate(() => { let v; window.__stores.objectListClose.subscribe((y) => (v = y))(); return v; });
			h.check(closed === true, tag('a tap just below the ✕ (outside its drawn box) closes the window'));
		}
		await h.closePeer(P);
	}
	await h.finish(browser);
});
