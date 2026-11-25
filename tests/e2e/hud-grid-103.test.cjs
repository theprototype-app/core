// 103 H15 — ONE GRID FOR THE STANDING CONTROLS (styles/hud.css `--hud-inset / --hud-tile / --hud-gap / --hud-radius`,
// $lib/hudGrid). The owner's real OPPO N6 unfolded shots (1.73.0) showed a top row of four heights and centres, the
// undo / redo / box-select buttons round, translucent and at their own x, and the toolbar starting at a third x.
// Geometry asserted per layout, read from the live DOM against the grid tokens the page itself computes:
//  1. the top row (logo, the row beside it, the Connect pill on the row, the top-right group, the profile button):
//     ONE height (= the tile), one centre line, one top (the inset, or a docked Connect bar's bottom + the inset)
//  2. the left edge: the logo, the corner stack (and the touch tools when they stand in a column) at the inset from
//     the free viewport's left edge; the touch tools are TILES (the tile square, the grid's radius) like Add / AI;
//     a full toolbar (something folded into "»") in its own row starts at the same inset
//  3. the right edge: the profile button and the right corner stack (mic / chat) at the same inset; a full toolbar
//     in its own row ends there too; the top-right group sits one tile + one gap in from it
//  4. split view (the N6 unfolded with the panels open): the same rules against the free viewport's own box
//  5. row 9 (owner 22 Nov): opening the profile menu moves NOTHING — the avatar's box is identical closed and open,
//     the circle seated in the menu is the trigger's box, it is not clipped (its border pixels hit-test to it, and
//     the drawn border strips match closed / open within one device px of antialiasing)
//  6. Edit positions still moves a cluster and Reset puts it back on the grid (desktop, the Connect pill)
// Layouts: desktop 1920 x 1080 and 1280 x 800; the N6 unfolded at its REAL size (692 x 633 viewport, screen 692 x 763,
// DPR 3.25 — measured from the owner's 2248 px shot), its split view and landscape; the N6 folded landscape (844 x 390)
// and portrait (390 x 844, the phone shell: only its top row's one centre line, the shell owns the rest).
//
//   APP_URL=https://theprototype.app:7194/ e2e-slot --local --dev $PWD 7194 -- node tests/e2e/hud-grid-103.test.cjs
const h = require('./helpers.cjs');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const OUT = path.join(process.env.E2E_OUT || path.join(__dirname, '../../test-results/103-hud-align'), 'hud-grid');
fs.mkdirSync(OUT, { recursive: true });

const touch = { hasTouch: true, isMobile: true, userAgent: h.N6_UA };
const N6U = { viewport: { width: 692, height: 633 }, screen: { width: 692, height: 763 }, deviceScaleFactor: 3.25, ...touch };
const LAYOUTS = [
	{ name: 'desktop-1920', ctx: { viewport: { width: 1920, height: 1080 } } },
	{ name: 'desktop-1280', ctx: { viewport: { width: 1280, height: 800 } }, reset: true },
	{ name: 'n6-unfolded', ctx: N6U },
	{ name: 'n6-unfolded-split', ctx: N6U, split: true },
	{ name: 'n6-unfolded-landscape', ctx: { viewport: { width: 763, height: 560 }, screen: { width: 763, height: 692 }, deviceScaleFactor: 3.25, ...touch } },
	{ name: 'n6-folded-landscape', ctx: { viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 }, deviceScaleFactor: 2.9, ...touch } },
	{ name: 'n6-folded-portrait', ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.9, ...touch }, shell: true }
];
const only = (process.env.ONLY || '').split(',').filter(Boolean);
const EPS = 0.6;
const near = (a, b, e = EPS) => Math.abs(a - b) <= e;

/** everything the checks read, in one evaluate */
const read = (page) =>
	page.evaluate(() => {
		const root = document.documentElement;
		const cs = getComputedStyle(root);
		const px = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
		const box = (el) => {
			if (!el) return null;
			const s = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			if (s.display === 'none' || s.visibility === 'hidden' || !r.width || !r.height) return null;
			return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, cy: r.top + r.height / 2, radius: parseFloat(s.borderTopLeftRadius) };
		};
		const q = (s) => box(document.querySelector(s));
		const all = (s) => [...document.querySelectorAll(s)].map(box).filter(Boolean);
		// the grid as the page computes it (a probe resolves the tokens through any calc / ui-scale)
		const probe = document.createElement('div');
		probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--hud-inset);height:var(--hud-tile);padding-left:var(--hud-gap);border-radius:var(--hud-radius)';
		document.body.appendChild(probe);
		const pr = getComputedStyle(probe);
		const grid = { inset: parseFloat(pr.width), tile: parseFloat(pr.height), gap: parseFloat(pr.paddingLeft), radius: parseFloat(pr.borderTopLeftRadius) };
		probe.remove();
		const wrap = document.querySelector('.connect-wrap');
		return {
			W: root.getBoundingClientRect().width, // the REAL layout width: innerWidth rounds (718.67 on the HONOR)
			H: innerHeight,
			grid,
			shell: root.classList.contains('phone-shell'),
			dockLeft: px('--sb-dock-left'),
			freeLeft: px('--sb-free-left'),
			freeRight: px('--sb-free-right'),
			freeTopRight: px('--sb-free-top-right'),
			docked: !!wrap?.classList.contains('docked'),
			logo: q('#logo-menu'),
			pill: q('.connect-pill'),
			tr: q('#hud-tr'),
			trStacked: !!document.querySelector('#hud-tr.tr-stacked'),
			avatar: q('#avatar-trigger > *'),
			tools: all('#touch-tools .tt-btn'),
			toolsStacked: !!document.querySelector('#touch-tools.tt-stacked'),
			stackL: all('#hud-stack-left > .hud-fab'),
			stackR: all('#hud-stack-right > .hud-fab'),
			bar: q('#controls-pill'),
			folded: !!q('#toolbar-overflow')
		};
	});

/** two shots of one strip draw the same, give or take ONE device px of antialiasing (the open circle rides a
 *  composited, fading top-layer panel, and at a fractional DPR its edge rasterises ~0.3 device px apart). The clip this
 *  guards against removed 3 device px of border on the N6, which no 1 px shift explains. */
async function nearSame(a, b) {
	const A = await sharp(a).raw().toBuffer({ resolveWithObject: true });
	const B = await sharp(b).raw().toBuffer({ resolveWithObject: true });
	const { width: w, height: hh, channels: c } = A.info;
	if (w !== B.info.width || hh !== B.info.height) return false;
	const at = (buf, x, y) => (y * w + x) * c;
	let bad = 0;
	for (let y = 0; y < hh; y++)
		for (let x = 0; x < w; x++)
			for (let best = Infinity, dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= w || yy >= hh) continue;
					const i = at(A.data, x, y), j = at(B.data, xx, yy);
					best = Math.min(best, Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1]) + Math.abs(A.data[i + 2] - B.data[j + 2]));
				}
				if (dy === 1 && best > 24) bad++;
			}
	return bad / (w * hh) < 0.02;
}

/** the profile button closed and open: its box, the seated circle, the hit test on its border, the border strips */
async function avatarOpenClose(page, isTouch) {
	const trig = page.locator('#avatar-trigger');
	const closed = await page.evaluate(() => {
		const r = document.querySelector('#avatar-trigger > *').getBoundingClientRect();
		return { x: r.left, y: r.top, w: r.width, h: r.height };
	});
	// the border strips (top and right, clear of the rounded corners) as drawn, closed
	// half a CSS px in from the outer edge: at a fractional DPR (3.25) a clip ending ON the edge rounds out one device
	// column past it, where the open panel's shadow lies (that is the panel, not the circle)
	const strips = (b) => [
		{ x: b.x + 14, y: b.y + 0.5, width: b.w - 28, height: 1.5 },
		{ x: b.x + b.w - 2, y: b.y + 14, width: 1.5, height: b.h - 28 }
	];
	const shotsClosed = [];
	for (const clip of strips(closed)) shotsClosed.push(await page.screenshot({ clip }));
	if (isTouch) await trig.tap();
	else await trig.click();
	await page.waitForSelector('#avatar-dropdown', { timeout: 5000 });
	await page.waitForTimeout(450); // the panel's fade
	if (!isTouch) await page.mouse.move(4, 300); // nothing hovered while the strips are drawn
	await page.waitForTimeout(150);
	const open = await page.evaluate(() => {
		const r = document.querySelector('#avatar-trigger > *').getBoundingClientRect();
		const seatEl = document.querySelector('#avatar-dropdown .pm-seat > *');
		const s = seatEl?.getBoundingClientRect();
		// a pixel INSIDE the circle's own top and right border: clipped by the panel, it hit-tests to the panel
		const hit = (x, y) => {
			const e = document.elementFromPoint(x, y);
			return !!e && !!seatEl && (e === seatEl || seatEl.contains(e) || e.closest('.pm-seat') !== null);
		};
		return {
			trig: { x: r.left, y: r.top, w: r.width, h: r.height },
			seat: s ? { x: s.left, y: s.top, w: s.width, h: s.height } : null,
			hitTop: s ? hit(s.left + s.width / 2, s.top + 0.5) : null,
			hitRight: s ? hit(s.right - 0.5, s.top + s.height / 2) : null
		};
	});
	const shotsOpen = [];
	for (const clip of strips(closed)) shotsOpen.push(await page.screenshot({ clip }));
	const same = [];
	for (let i = 0; i < shotsClosed.length; i++) same.push(await nearSame(shotsClosed[i], shotsOpen[i]));
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	return { closed, open, same };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const L of LAYOUTS) {
		if (only.length && !only.includes(L.name)) continue;
		const T = `[${L.name}] `;
		const { page: P } = await h.setupPage(browser, 'grid-' + L.name, { context: L.ctx, storage: { toastsInDrawerOnly: 'true', toursSeen: '{"editor":true,"editor-touch":true}' } });
		await P.waitForTimeout(2500);
		if (L.split) {
			const t = P.locator('#panels-toggle');
			h.check((await t.count()) > 0, T + 'premise: the panels button is on the unfolded N6');
			await t.tap();
			await h.eventually(() => read(P), (v) => v.freeRight > 100 || v.freeLeft > 100, T + 'premise: a column is open (split view)');
			await P.waitForTimeout(800);
		}
		const g = await read(P);
		fs.writeFileSync(path.join(OUT, `${L.name}.json`), JSON.stringify(g, null, 1));
		await P.screenshot({ path: path.join(OUT, `${L.name}.png`) });
		const { inset, tile, gap, radius } = g.grid;
		h.check(inset > 0 && tile >= 44 && gap > 0 && radius > 0, T + `premise: the grid tokens resolve (${JSON.stringify(g.grid)})`);
		if (L.name.startsWith('n6-unfolded')) {
			h.check((await P.evaluate(() => matchMedia('(pointer: coarse)').matches)) && !g.shell, T + 'premise: a touch screen in the unfolded (sidebar) layout, not the phone shell');
			// the N6's REAL inner width (692, not the 906 the brief guessed) is a PHONE to 103-viewbar too: no Preview pill
			const phone = await P.evaluate(() => {
				let v;
				window.__tp?.test.v1?.deviceClass?.unfoldedPhone?.subscribe((x) => (v = x))();
				return { unfolded: v, pill: !!document.getElementById('preview-pill') };
			});
			h.check(phone.unfolded === true && !phone.pill, T + `the real unfolded width reads as a phone (unfoldedPhone ${phone.unfolded}, Preview pill ${phone.pill})`);
		}

		if (L.shell) {
			// the phone shell owns its own top bar (phone.css): only its one centre line is held here
			const row = [g.logo, g.avatar].filter(Boolean);
			h.check(g.shell && row.length === 2 && row.every((b) => near(b.cy, row[0].cy, 1)), T + `the phone shell's top row has one centre line (${row.map((b) => b.cy).join(', ')})`);
		} else {
			// ---- 1. the top row ----
			const top = (g.docked ? (g.pill?.b ?? 0) : 0) + inset;
			const row = [['logo', g.logo], ['avatar', g.avatar]];
			if (g.pill && !g.docked) row.push(['connect pill', g.pill]);
			if (g.tr && !g.trStacked) row.push(['top-right group', g.tr]);
			if (!g.toolsStacked) g.tools.forEach((b, i) => row.push(['touch tool ' + i, b]));
			const bad = row.filter(([, b]) => !b || !near(b.h, tile) || !near(b.y, top));
			h.check(bad.length === 0, T + `1. the top row: ${row.length} items, each ${tile} px tall at y = ${top} (one centre line at ${top + tile / 2})${bad.length ? ' — off: ' + bad.map(([n, b]) => `${n} ${b ? `y ${b.y.toFixed(1)} h ${b.h.toFixed(1)}` : 'missing'}`).join('; ') : ''}`);
			h.check(!!g.logo && near(g.logo.w, tile), T + `1. the logo is a tile (${g.logo?.w} x ${g.logo?.h})`);
			h.check(!!g.avatar && near(g.avatar.w, tile), T + `1. the profile button is a tile (${g.avatar?.w} x ${g.avatar?.h})`);
			// (a DOCKED Connect bar is the top edge itself and squares its top corners by design)
			const radii = [g.logo, g.avatar, g.docked ? null : g.pill, g.tr, ...g.tools, ...g.stackL, ...g.stackR].filter(Boolean).map((b) => b.radius);
			h.check(radii.every((r) => near(r, radius)), T + `1. one corner radius (${radius}) on the row, the touch tools and the corner tiles (${[...new Set(radii)].join(', ')})`);

			// ---- 2. the left edge ----
			h.check(!!g.logo && near(g.logo.x, inset + g.dockLeft), T + `2. the logo at the left inset (${g.logo?.x} vs ${inset + g.dockLeft})`);
			const leftEdge = inset + g.freeLeft;
			h.check(g.stackL.length > 0 && g.stackL.every((b) => near(b.x, leftEdge) && near(b.w, tile) && near(b.h, tile)), T + `2. the left corner stack: tiles at the left inset (${g.stackL.map((b) => `${b.x.toFixed(1)}:${b.w.toFixed(0)}`).join(', ')} vs ${leftEdge})`);
			for (let i = 1; i < g.stackL.length; i++) h.check(near(g.stackL[i - 1].y - g.stackL[i].b, gap), T + `2. the left stack's gap is the grid's (${(g.stackL[i - 1].y - g.stackL[i].b).toFixed(1)} vs ${gap})`);
			if (g.tools.length) {
				h.check(g.tools.every((b) => near(b.w, tile) && near(b.h, tile)), T + `2. the touch tools are tiles of the corner tiles' size (${g.tools.map((b) => `${b.w.toFixed(0)}x${b.h.toFixed(0)}`).join(', ')} vs ${tile})`);
				if (g.toolsStacked) {
					h.check(g.tools.every((b) => near(b.x, g.logo.x)), T + `2. stacked, the touch tools stand at the logo's x (${g.tools.map((b) => b.x.toFixed(1)).join(', ')} vs ${g.logo.x})`);
					h.check(near(g.tools[0].y, g.logo.b + gap), T + `2. …one gap under the logo (${(g.tools[0].y - g.logo.b).toFixed(1)})`);
				} else {
					h.check(near(g.tools[0].x, g.logo.r + gap), T + `2. in a row, the touch tools start one gap right of the logo (${(g.tools[0].x - g.logo.r).toFixed(1)} vs ${gap})`);
				}
				for (let i = 1; i < g.tools.length; i++) {
					const d = g.toolsStacked ? g.tools[i].y - g.tools[i - 1].b : g.tools[i].x - g.tools[i - 1].r;
					h.check(near(d, gap), T + `2. the touch tools are one gap apart (${d.toFixed(1)})`);
				}
			} else if (L.name.startsWith('n6')) h.check(false, T + 'premise: the touch tools show on a phone');

			// ---- 3. the right edge ----
			const rightEdge = g.W - inset - g.freeRight;
			h.check(!!g.avatar && near(g.avatar.r, g.W - inset - g.freeTopRight), T + `3. the profile button at the right inset (${g.avatar ? (g.W - g.avatar.r).toFixed(1) : '-'} from the edge vs ${inset + g.freeTopRight})`);
			h.check(g.stackR.length > 0 && g.stackR.every((b) => near(b.r, rightEdge) && near(b.w, tile)), T + `3. the right corner stack (mic / chat) at the right inset (${g.stackR.map((b) => (g.W - b.r).toFixed(1)).join(', ')} vs ${inset + g.freeRight})`);
			if (g.tr && !g.trStacked) h.check(near(g.tr.r, g.avatar.x - gap), T + `3. the top-right group one gap left of the profile button (${(g.avatar.x - g.tr.r).toFixed(1)} vs ${gap})`);

			// ---- 2 / 3. the toolbar's edges when it is full ----
			if (g.bar && g.folded) {
				const besideL = g.stackL.some((b) => b.b > g.bar.y && b.y < g.bar.b);
				const besideR = g.stackR.some((b) => b.b > g.bar.y && b.y < g.bar.b);
				const wantL = besideL ? Math.max(...g.stackL.map((b) => b.r)) + gap : leftEdge;
				const wantR = besideR ? Math.min(...g.stackR.map((b) => b.x)) - gap : rightEdge;
				h.check(near(g.bar.x, wantL, 1) && near(g.bar.r, wantR, 1), T + `2/3. the full toolbar ("»") spans its band: ${g.bar.x.toFixed(1)}..${g.bar.r.toFixed(1)} vs ${wantL.toFixed(1)}..${wantR.toFixed(1)}`);
			}
			if (L.split) h.check(g.stackR.every((b) => b.r <= g.W - g.freeRight - inset + EPS) && g.avatar.r <= g.W - g.freeTopRight - inset + EPS, T + '4. split: every right-hand control keeps the inset from the open column');
		}

		// ---- 5. row 9: the profile button holds still ----
		const av = await avatarOpenClose(P, !!L.ctx.hasTouch);
		const same = (a, b) => !!a && !!b && near(a.x, b.x, 0.01) && near(a.y, b.y, 0.01) && near(a.w, b.w, 0.01) && near(a.h, b.h, 0.01);
		h.check(same(av.closed, av.open.trig), T + `5. the avatar's box is identical closed and open (${JSON.stringify(av.closed)} / ${JSON.stringify(av.open.trig)})`);
		if (!L.shell) {
			h.check(same(av.closed, av.open.seat), T + `5. the circle seated in the menu IS the trigger's box (${JSON.stringify(av.open.seat)})`);
			h.check(av.open.hitTop === true && av.open.hitRight === true, T + `5. …and it is not clipped: its top and right border pixels hit-test to it (top ${av.open.hitTop}, right ${av.open.hitRight})`);
			h.check(av.same.every(Boolean), T + `5. …and its border draws the same closed / open (±1 device px) (top ${av.same[0]}, right ${av.same[1]})`);
		}

		// ---- 6. Edit positions moves a cluster, Reset puts it back on the grid ----
		if (L.reset) {
			const pillAt = async () => {
				const b = (await read(P)).pill;
				return b && { x: b.x + 10, y: b.cy, b };
			};
			const at = await pillAt();
			const menuPick = async (label) => {
				const row = P.locator('[role="menu"] [role="menuitem"]', { hasText: label }).first();
				if (await row.count()) await row.click();
				await P.waitForTimeout(500);
			};
			if (at) {
				await P.mouse.click(at.x, at.y, { button: 'right' });
				await P.waitForTimeout(400);
				await menuPick('Move');
				await P.mouse.move(at.x - 100, at.y + 200, { steps: 6 });
				await P.mouse.click(at.x - 100, at.y + 200);
				await P.waitForTimeout(700);
				const moved = (await read(P)).pill;
				h.check(!!moved && moved.y > at.b.y + 100, T + `6. Move still moves the Connect pill off the row (${at.b.y.toFixed(0)} → ${moved?.y.toFixed(0)})`);
				const at2 = await pillAt();
				await P.mouse.click(at2.x, at2.y, { button: 'right' });
				await P.waitForTimeout(400);
				await menuPick('Reset position');
				const back = (await read(P)).pill;
				h.check(!!back && near(back.y, inset) && near(back.h, tile) && near(back.x, at.b.x, 1), T + `6. Reset puts it back on the grid's top row (y ${back?.y} h ${back?.h})`);
			} else h.check(false, T + 'premise: the Connect pill is on the desktop top row');
		}
		await P.context().close();
	}
	await browser.close();
});
