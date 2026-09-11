// 24-B3: floating windows keep their HEADER above the bottom chrome. dragWindow's clamp
// kept a 52px strip of the window inside the RAW viewport — exactly the strip the
// Controls pill / play FAB (z-hud, above windows) and the `--controls-inset` band on
// coarse-pointer or narrow viewports cover — so a module toolbox dragged low lost its
// header under the HUD (user-reported). The clamp now measures the `.move-handle`,
// subtracts `windowSize.bottomReserve()` (`--controls-inset`, the dock when it pushes
// the viewport, `visualViewport` overlays) and treats the centred pill as a rect.
//
// The toolbox is the module-toolbox suite's inline module through the REAL api.
const h = require('./helpers.cjs');

async function installToolbox(page, tallBody = false) {
	await page.waitForFunction(() => !!window.__stores?.moduleToolboxes, { timeout: 30000 });
	await page.evaluate(async (tallBody) => {
		await window.__stores.moduleSDK.initModules([
			{
				id: 'clamptbx',
				name: 'Clamp toolbox',
				version: '1.0.0',
				description: 'proves the 24-B3 clamp',
				register(api) {
					api.registerToolbox({
						id: 'panel',
						title: 'Clamp Panel',
						width: 240,
						defaultRect: { left: 300, top: 200 },
						mount(el) {
							const n = tallBody ? 40 : 2;
							for (let i = 0; i < n; i++) {
								const row = document.createElement('div');
								row.className = 'tbx-label';
								row.style.height = '24px';
								row.textContent = 'Row ' + i;
								el.append(row);
							}
							return () => {};
						}
					});
				}
			}
		]);
		window.__stores.moduleToolboxes.openModuleToolbox('mod-clamptbx-panel');
	}, tallBody);
	await page.waitForSelector('#mod-clamptbx-panel .move-handle', { timeout: 15000 });
	await page.waitForTimeout(400);
}

/** drag the toolbox header to an absolute (x, y) — the pointer STARTS on the handle
 * (a pointerdown beside it drags nothing, which reads as a pass); y way past the
 * bottom is fine, that is the point */
async function dragHeaderTo(page, y, x) {
	const box = await page.locator('#mod-clamptbx-panel .move-handle').boundingBox();
	const fromX = box.x + box.width / 2;
	const fromY = box.y + 8;
	await page.mouse.move(fromX, fromY);
	await page.mouse.down();
	await page.mouse.move(x ?? fromX, y, { steps: 16 });
	await page.mouse.up();
	await page.waitForTimeout(250);
}

const geometry = (page) =>
	page.evaluate(() => {
		const el = document.querySelector('#mod-clamptbx-panel');
		const header = el?.querySelector('.move-handle')?.getBoundingClientRect();
		const win = el?.getBoundingClientRect();
		const pill = document.getElementById('controls-pill')?.getBoundingClientRect();
		const cs = getComputedStyle(document.documentElement);
		return {
			innerHeight: window.innerHeight,
			innerWidth: window.innerWidth,
			coarse: window.matchMedia('(pointer: coarse)').matches,
			controlsInset: parseFloat(cs.getPropertyValue('--controls-inset')) || 0,
			viewportInset: parseFloat(cs.getPropertyValue('--viewport-inset')) || 0,
			header: header ? { top: header.top, bottom: header.bottom, left: header.left, right: header.right } : null,
			win: win ? { top: win.top, bottom: win.bottom, left: win.left, right: win.right, height: win.height } : null,
			pill: pill && pill.height > 0 ? { top: pill.top, left: pill.left, right: pill.right } : null,
			reserve: window.__stores.windowSizeReserve ?? null
		};
	});

const overlapsPill = (g) => !!g.pill && g.win.left < g.pill.right && g.win.right > g.pill.left && g.pill.top > g.innerHeight / 2;

h.run(async () => {
	const browser = await h.launch();

	// ---- A. desktop, fine pointer: the band is 0, the centred pill is a rect ---------
	const A = await h.setupPage(browser, 'A');
	await installToolbox(A.page);
	let g = await geometry(A.page);
	h.check(!!g.header && g.controlsInset === 0 && !g.coarse, `A: desktop premise — fine pointer, no controls band (inset ${g.controlsInset})`);
	const startTop = g.header.top;
	await dragHeaderTo(A.page, g.innerHeight + 200);
	g = await geometry(A.page);
	h.check(g.header.top > startTop + 100, `A: premise — the drag moved the window (${startTop.toFixed(0)} -> ${g.header.top.toFixed(0)})`);
	h.check(g.header.bottom <= g.innerHeight + 0.5, `A: header stays inside the viewport (bottom ${g.header.bottom.toFixed(0)} / ${g.innerHeight})`);
	h.check(
		!overlapsPill(g) || g.header.bottom <= g.pill.top - 4 + 0.5,
		`A: a window over the Controls pill keeps its header above it (header ${g.header.bottom.toFixed(0)}, pill top ${g.pill?.top?.toFixed(0)})`
	);
	// beside the pill (a bottom corner) the window may go lower: only the strip rule holds
	await dragHeaderTo(A.page, 200, 60);
	await dragHeaderTo(A.page, g.innerHeight + 200, 60);
	const corner = await geometry(A.page);
	h.check(
		!overlapsPill(corner) && corner.header.bottom <= corner.innerHeight + 0.5 && corner.header.bottom > (g.pill ? g.pill.top : 0),
		`A: parked in the corner beside the pill the header may sit lower (header bottom ${corner.header.bottom.toFixed(0)}, pill top ${corner.pill?.top?.toFixed(0)})`
	);
	// a browser overlay (visualViewport shorter than the layout viewport) is chrome too
	await A.page.evaluate(() => {
		const fake = { height: window.innerHeight - 120, offsetTop: 0, width: window.innerWidth, addEventListener() {}, removeEventListener() {} };
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake });
	});
	await dragHeaderTo(A.page, g.innerHeight + 200, 60);
	const overlay = await geometry(A.page);
	h.check(
		overlay.header.bottom <= overlay.innerHeight - 120 + 0.5,
		`A: a visualViewport overlay of 120px keeps the header above it (header bottom ${overlay.header.bottom.toFixed(0)} <= ${overlay.innerHeight - 120})`
	);
	await A.page.evaluate(() => {
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
	});
	// a viewport that SHRINKS re-clamps the parked window (the resize listener)
	await dragHeaderTo(A.page, g.innerHeight + 200, 60);
	await A.page.setViewportSize({ width: 1280, height: 520 });
	await A.page.waitForTimeout(400);
	const shrunk = await geometry(A.page);
	h.check(
		shrunk.innerHeight === 520 && shrunk.header.bottom <= 520 + 0.5,
		`A: shrinking the viewport pulls the header back inside (header bottom ${shrunk.header.bottom.toFixed(0)} / 520)`
	);
	await A.page.setViewportSize({ width: 1280, height: 720 });
	await A.page.waitForTimeout(300);

	// ---- B. coarse pointer (touch): the 76px Controls band ---------------------------
	const B = await h.setupPage(browser, 'B', { context: { hasTouch: true } });
	await installToolbox(B.page, true);
	g = await geometry(B.page);
	if (!g.coarse) {
		console.log('  hasTouch did not make (pointer: coarse) match here — the band is covered by section C');
		h.check(true, 'B: coarse-pointer emulation unavailable (skipped, not failed)');
	} else {
		h.check(g.controlsInset === 76, `B: coarse pointer reserves the 76px controls band (${g.controlsInset})`);
		await dragHeaderTo(B.page, g.innerHeight + 200, 60);
		g = await geometry(B.page);
		h.check(
			g.header.bottom <= g.innerHeight - 76 + 0.5,
			`B: header stays above the band (bottom ${g.header.bottom.toFixed(0)} <= ${g.innerHeight - 76})`
		);
		// the toolbox body is 40 rows tall: the max-height cap keeps the whole window
		// above the band and the body scrolls instead
		h.check(
			g.win.bottom <= g.innerHeight - 76 + 0.5,
			`B: a tall toolbox caps itself above the band (window bottom ${g.win.bottom.toFixed(0)} <= ${g.innerHeight - 76})`
		);
		const cap = await B.page.evaluate(() => window.__stores.windowSize?.clampWinSize?.(9999, 9999) ?? null);
		if (cap) h.check(cap.h <= g.innerHeight - 76, `B: viewportCap subtracts the band too (h ${cap.h} <= ${g.innerHeight - 76})`);
	}

	// ---- C. a narrow viewport (<=820px wide, still >640 so the toolbox floats) -------
	const C = await h.setupPage(browser, 'C', { context: { viewport: { width: 700, height: 500 } } });
	await installToolbox(C.page, true);
	g = await geometry(C.page);
	h.check(g.controlsInset === 76, `C: a 700px-wide viewport reserves the 76px band (${g.controlsInset})`);
	await dragHeaderTo(C.page, g.innerHeight + 200, 60);
	g = await geometry(C.page);
	h.check(
		g.header.bottom <= g.innerHeight - 76 + 0.5,
		`C: header stays above the band on a 700x500 viewport (bottom ${g.header.bottom.toFixed(0)} <= ${g.innerHeight - 76})`
	);
	h.check(
		g.win.bottom <= g.innerHeight - 76 + 0.5,
		`C: the tall toolbox is capped above the band (window bottom ${g.win.bottom.toFixed(0)} <= ${g.innerHeight - 76})`
	);
	h.check(g.header.top >= 0, `C: ...and its header never went above the top edge (top ${g.header.top.toFixed(0)})`);

	await h.finish(browser);
});
