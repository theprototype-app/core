// 38 NOTES-38 #35-#39 — the four editors on a PHONE (390x844, touch), driven by REAL touch
// events (CDP Input.dispatchTouchEvent: the browser turns them into pointer events with
// pointerType "touch", the path a finger takes — a synthetic dispatch would not travel it).
//
//   #38 Profiler   the recording controls scroll sideways; "Last 30 s" is one line; the LAST
//                  control (Live) is reached by a drag and answers a tap
//   #37 UV editor  the tool row scrolls sideways; the last tools (zoom / Fit) are reached
//   #35 Animation  one pane at a time behind a switch; a key is DRAGGED by a finger; two
//                  fingers pinch-zoom and pan the time axis
//   #36 Shader     the canvas takes the width, palette + properties are Sheets; a finger pans
//                  the canvas, adds a node from the sheet and drags a wire socket to socket
//   #39            ScrollStrip fades the side that still hides something
// Then a DESKTOP page (1440x900, mouse) proves none of the phone layout leaks there.
const h = require('./helpers.cjs');

/** @param {import('playwright').Page} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	/** a one-finger drag through `points` ([x, y] client coords) */
	const drag = async (/** @type {number[][]} */ points, steps = 8) => {
		const [x0, y0] = points[0];
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
		for (let k = 1; k < points.length; k++) {
			const [ax, ay] = points[k - 1];
			const [bx, by] = points[k];
			for (let i = 1; i <= steps; i++) {
				const f = i / steps;
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ax + (bx - ax) * f, y: ay + (by - ay) * f, id: 1 }] });
			}
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	/** two fingers from (a0, b0) to (a1, b1) */
	const two = async (/** @type {number[]} */ a0, /** @type {number[]} */ b0, /** @type {number[]} */ a1, /** @type {number[]} */ b1, steps = 10) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a0[0], y: a0[1], id: 1 }] });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a0[0], y: a0[1], id: 1 }, { x: b0[0], y: b0[1], id: 2 }] });
		for (let i = 1; i <= steps; i++) {
			const f = i / steps;
			const lerp = (/** @type {number[]} */ p, /** @type {number[]} */ q) => ({ x: p[0] + (q[0] - p[0]) * f, y: p[1] + (q[1] - p[1]) * f });
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...lerp(a0, a1), id: 1 }, { ...lerp(b0, b1), id: 2 }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	const tap = async (/** @type {number} */ x, /** @type {number} */ y) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	return { drag, two, tap };
}

/** the strip's state + whether `sel` is fully inside it and is what a finger would hit */
const stripState = (/** @type {import('playwright').Page} */ page, /** @type {string} */ strip, /** @type {string} */ sel) =>
	page.evaluate(
		([strip, sel]) => {
			const s = /** @type {HTMLElement} */ (document.querySelector(strip));
			const t = /** @type {HTMLElement|null} */ (sel ? document.querySelector(sel) : null);
			if (!s) return null;
			const sr = s.getBoundingClientRect();
			const out = { scrollLeft: s.scrollLeft, overflow: s.scrollWidth - s.clientWidth, fade: s.dataset.fade ?? '', inside: false, hit: false, cx: 0, cy: 0, stripY: sr.top + sr.height / 2, stripL: sr.left, stripR: sr.right };
			if (t) {
				const r = t.getBoundingClientRect();
				out.inside = r.left >= sr.left - 1 && r.right <= sr.right + 1;
				out.cx = r.left + r.width / 2;
				out.cy = r.top + r.height / 2;
				const at = document.elementFromPoint(out.cx, out.cy);
				out.hit = !!at && (at === t || t.contains(at));
			}
			return out;
		},
		[strip, sel]
	);

/** drag a strip sideways until `sel` is inside it (a finger needs a few swipes on a long row) */
async function swipeUntilInside(/** @type {any} */ touch, /** @type {import('playwright').Page} */ page, /** @type {string} */ strip, /** @type {string} */ sel) {
	for (let i = 0; i < 6; i++) {
		const st = await stripState(page, strip, sel);
		if (!st || st.inside) return st;
		await touch.drag([[st.stripR - 20, st.stripY], [st.stripL + 30, st.stripY]]);
		await page.waitForTimeout(350);
	}
	return stripState(page, strip, sel);
}

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
	});
	const page = P.page;
	const touch = await touchApi(page);

	// a textured box carrying two animated channels, selected
	const uuid = await page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 600));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'Door';
		box.position.set(0, 0, 0);
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const x = c.getContext('2d');
		x.fillStyle = '#c33';
		x.fillRect(0, 0, 32, 32);
		box.material.map = new w.THREE.CanvasTexture(c);
		box.material.needsUpdate = true;
		const ap = w.animationPreview;
		const a = ap.addTrack(box.uuid, 'pos.y', box);
		ap.addTrack(box.uuid, 'rot.y', box);
		ap.updateKey(box.uuid, a, 0, { t: 0, v: 0 });
		ap.updateKey(box.uuid, a, 1, { t: 0.5, v: 1 });
		ap.addKey(box.uuid, a, 1, 2);
		ap.addKey(box.uuid, a, 1.5, 0.5);
		ap.updateAnim(box.uuid, { duration: 2, loop: 'loop' });
		w.objectActions.selectObject(box.uuid, false);
		return box.uuid;
	});

	const open = (/** @type {string} */ key, /** @type {string} */ store) =>
		page.evaluate(
			([key, store]) => {
				const s = window.__stores;
				for (const k of ['animationClose', 'uvEditorClose', 'shaderEditorClose', 'profilerClose']) s[k].set(true);
				s[store].set(false);
				s.bottomDock.activateDock(key);
			},
			[key, store]
		);

	// ---------------- #38 Profiler ----------------
	await open('profiler', 'profilerClose');
	await page.waitForSelector('#profiler-toolbar', { timeout: 10000 });
	await page.waitForTimeout(600);
	let st = await stripState(page, '#profiler-toolbar', '#profiler-open-live');
	h.check(!!st && st.overflow > 20, `profiler: the toolbar is wider than the phone and scrolls (overflow ${st?.overflow}px)`);
	h.check(st?.fade === 'end', `profiler: the strip fades its right edge while tools hide there (fade "${st?.fade}")`);
	h.check(!st?.inside, 'profiler: the last control (Live) starts out of reach');
	const lastLines = await page.evaluate(() => {
		const b = document.getElementById('profiler-last30');
		if (!b) return -1;
		// the TEXT's own line boxes (the icon's box sits at a different top on the same line)
		const tops = new Set();
		for (const n of b.childNodes) {
			if (n.nodeType !== 3 || !n.textContent?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(n);
			for (const r of range.getClientRects()) if (r.width) tops.add(Math.round(r.top));
		}
		return tops.size;
	});
	h.check(lastLines === 1, `profiler: "Last 30 s" sits on ONE line (${lastLines} line boxes)`);
	st = await swipeUntilInside(touch, page, '#profiler-toolbar', '#profiler-open-live');
	h.check(!!st?.inside && st.hit, `profiler: a finger drag brings Live into reach (scrollLeft ${st?.scrollLeft}, hit ${st?.hit})`);
	h.check(st?.fade === 'start', `profiler: at the end the fade moves to the left edge ("${st?.fade}")`);
	await touch.tap(st?.cx ?? 0, st?.cy ?? 0);
	await page.waitForTimeout(500);
	const liveOpen = await page.evaluate(() => !!document.getElementById('profiler-live'));
	h.check(liveOpen, 'profiler: a tap on the reached Live control opens the live profiler');
	await page.evaluate(() => document.getElementById('profiler-live-close')?.click());

	// ---------------- #37 UV editor ----------------
	await open('uv', 'uvEditorClose');
	await page.waitForSelector('#uv-toolbar', { timeout: 10000 });
	await page.waitForTimeout(800);
	const zoomIn = '#uv-toolbar button[aria-label="Zoom in"]';
	st = await stripState(page, '#uv-toolbar', zoomIn);
	h.check(!!st && st.overflow > 20, `uv: the tool row scrolls (overflow ${st?.overflow}px)`);
	h.check(!st?.inside, 'uv: the zoom tools start past the right edge');
	st = await swipeUntilInside(touch, page, '#uv-toolbar', zoomIn);
	h.check(!!st?.inside && st.hit, `uv: a finger drag reaches Zoom in (hit ${st?.hit})`);
	const zoomText = () => page.evaluate(() => document.querySelector('#uv-toolbar button[aria-label="Zoom in"]')?.previousElementSibling?.textContent?.trim());
	const z0 = await zoomText();
	await touch.tap(st?.cx ?? 0, st?.cy ?? 0);
	await page.waitForTimeout(400);
	const z1 = await zoomText();
	h.check(!!z0 && !!z1 && parseInt(z1) > parseInt(z0), `uv: the reached tool works under a tap (${z0} -> ${z1})`);
	const fitBtn = await page.evaluate(() => {
		const strip = document.getElementById('uv-toolbar');
		const btns = strip ? [...strip.querySelectorAll('button')] : [];
		const last = btns[btns.length - 1];
		if (!last) return null;
		last.id ||= 'uv-last-tool-probe';
		return '#' + last.id;
	});
	st = fitBtn ? await swipeUntilInside(touch, page, '#uv-toolbar', fitBtn) : null;
	h.check(!!st?.inside && st.hit, `uv: the LAST tool in the row (Fit) is reachable too (hit ${st?.hit})`);
	// the Unwrap menu hangs under its button even though the button sits in a scroller
	await page.evaluate(() => (document.getElementById('uv-toolbar').scrollLeft = 0));
	await page.waitForTimeout(300);
	const unwrap = await stripState(page, '#uv-toolbar', '#uv-unwrap');
	if (!unwrap?.inside) await swipeUntilInside(touch, page, '#uv-toolbar', '#uv-unwrap');
	const ub = await stripState(page, '#uv-toolbar', '#uv-unwrap');
	await touch.tap(ub?.cx ?? 0, ub?.cy ?? 0);
	await page.waitForTimeout(400);
	const menuRect = await page.evaluate(() => {
		const m = document.getElementById('uv-unwrap-menu');
		const b = document.getElementById('uv-unwrap');
		if (!m || !b) return null;
		const mr = m.getBoundingClientRect();
		const br = b.getBoundingClientRect();
		const at = document.elementFromPoint(mr.left + mr.width / 2, mr.top + 10);
		return { dx: Math.round(mr.left - br.left), below: mr.top >= br.bottom - 2, visible: !!at && m.contains(at) };
	});
	h.check(!!menuRect && menuRect.below && menuRect.visible && Math.abs(menuRect.dx) <= 2, `uv: the Unwrap menu opens under its button, unclipped (${JSON.stringify(menuRect)})`);
	await touch.tap(ub?.cx ?? 0, ub?.cy ?? 0); // close it again
	await page.waitForTimeout(200);

	// ---------------- #35 Animation ----------------
	await open('animation', 'animationClose');
	await page.waitForSelector('#animation-pane-plot', { timeout: 10000 });
	await page.waitForTimeout(800);
	const panes = await page.evaluate(() => ({
		switch: ['list', 'plot', 'key', 'clip'].every((p) => !!document.getElementById('animation-pane-' + p)),
		plotShown: !!document.getElementById('animation-timeline')?.getClientRects().length,
		keyPaneHidden: !document.getElementById('animation-key-time')
	}));
	h.check(panes.switch, 'animation: a phone gets the Channels / Timeline / Key / Clip switch');
	h.check(panes.plotShown, 'animation: the timeline is the pane on show by default');
	// nothing overlaps: every visible text box in the editor sits inside the panel width
	const overflowing = await page.evaluate(() => {
		const dock = document.getElementById('animation-dock');
		if (!dock) return ['no dock'];
		const W = dock.getBoundingClientRect().right;
		const bad = [];
		for (const el of dock.querySelectorAll('button, label, span, select, input')) {
			const r = el.getBoundingClientRect();
			if (!r.width || el.closest('.scroll-strip')) continue; // a strip scrolls by design
			if (r.right > W + 1) bad.push((el.id || el.textContent || el.tagName).trim().slice(0, 20));
		}
		return bad;
	});
	h.check(overflowing.length === 0, `animation: nothing sticks out of the phone panel (${overflowing.slice(0, 5).join(' | ')})`);

	// the Channels pane, and a tap on a channel takes you to its timeline
	await page.locator('#animation-pane-list').tap();
	await page.waitForTimeout(400);
	const listShown = await page.evaluate(() => !document.getElementById('animation-timeline')?.getClientRects().length);
	h.check(listShown, 'animation: Channels shows the list instead of the timeline');
	await page.getByRole('button', { name: 'Position Y', exact: true }).last().tap();
	await page.waitForTimeout(400);
	const back = await page.evaluate(() => !!document.getElementById('animation-timeline')?.getClientRects().length);
	h.check(back, 'animation: tapping a channel opens its timeline');

	// DRAG A KEY with a finger: the pos.y key at 0.5 s, 40px to the right
	const keyAt = await page.evaluate(() => {
		const svg = document.getElementById('animation-timeline');
		const keys = svg ? [...svg.querySelectorAll('rect.an-key')] : [];
		// row 0 = pos.y; its keys sorted by x — the second one is t = 0.5
		const rows = keys.map((k) => k.getBoundingClientRect()).map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
		const y0 = Math.min(...rows.map((r) => r.y));
		const row0 = rows.filter((r) => Math.abs(r.y - y0) < 3).sort((a, b) => a.x - b.x);
		return row0[1] ?? null;
	});
	h.check(!!keyAt, 'animation: the key at 0.5 s is on screen');
	const timeOf = () =>
		page.evaluate((id) => {
			const clip = window.__stores.animationPreview.activeClip(id);
			const tr = clip.tracks.find((/** @type {any} */ t) => t.channel === 'pos.y');
			return tr.keys.map((/** @type {any} */ k) => +k.t.toFixed(3));
		}, uuid);
	const before = await timeOf();
	if (keyAt) await touch.drag([[keyAt.x, keyAt.y], [keyAt.x + 40, keyAt.y]], 12);
	await page.waitForTimeout(500);
	const after = await timeOf();
	h.check(before.includes(0.5) && !after.includes(0.5) && after.some((t) => t > 0.55 && t < 1), `animation: a finger drags the key later in time (${before.join(',')} -> ${after.join(',')})`);
	// one undo restores it (the drag was ONE gesture)
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(300);
	const undone = await timeOf();
	h.check(undone.includes(0.5), `animation: one undo puts the touch-dragged key back (${undone.join(',')})`);

	// TWO FINGERS: pinch out zooms the time axis in, a two-finger slide pans it
	const readout = () => page.evaluate(() => {
		const spans = [...document.querySelectorAll('#animation-plot-tools span')];
		const t = spans.map((s) => s.textContent?.trim() ?? '').find((x) => /^\d+\.\d\d–\d+\.\d\ds$/.test(x));
		if (!t) return null;
		const [a, b] = t.replace('s', '').split('–').map(Number);
		return { a, b };
	});
	const svgBox = await page.locator('#animation-timeline').boundingBox();
	const cy = (svgBox?.y ?? 0) + Math.min(60, (svgBox?.height ?? 80) - 10);
	const cx = (svgBox?.x ?? 0) + (svgBox?.width ?? 300) / 2;
	const v0 = await readout();
	await touch.two([cx - 30, cy], [cx + 30, cy], [cx - 120, cy], [cx + 120, cy]);
	await page.waitForTimeout(400);
	const v1 = await readout();
	h.check(!!v0 && !!v1 && v1.b - v1.a < (v0.b - v0.a) * 0.6, `animation: a two-finger pinch zooms the time axis in (${JSON.stringify(v0)} -> ${JSON.stringify(v1)})`);
	const timesAfterPinch = await timeOf();
	const selAfterPinch = await page.evaluate(() => /** @type {any} */ (window).__animationDebug?.selKeys() ?? []);
	h.check(selAfterPinch.length === 1, `animation: the pinch keeps the key you had selected (${selAfterPinch.join(' ')})`);
	h.check(JSON.stringify(timesAfterPinch) === JSON.stringify(undone), 'animation: the pinch moved no key (the second finger cancels the first finger\'s gesture)');
	await touch.two([cx + 40, cy], [cx + 100, cy], [cx - 60, cy], [cx, cy]);
	await page.waitForTimeout(400);
	const v2 = await readout();
	h.check(!!v1 && !!v2 && v2.a > v1.a + 0.01 && Math.abs((v2.b - v2.a) - (v1.b - v1.a)) < 0.02, `animation: a two-finger slide pans it at the same zoom (${JSON.stringify(v1)} -> ${JSON.stringify(v2)})`);

	// the Key pane carries the selected key's numbers
	await page.locator('#animation-pane-key').tap();
	await page.waitForTimeout(400);
	const keyPane = await page.evaluate(() => !!document.getElementById('animation-key-time')?.getClientRects().length);
	h.check(keyPane, 'animation: the Key pane shows the selected key\'s time and value');
	await page.locator('#animation-pane-clip').tap();
	await page.waitForTimeout(300);
	const clipPane = await page.evaluate(() => !!document.getElementById('animation-length')?.getClientRects().length);
	h.check(clipPane, 'animation: the Clip pane holds length / speed / fps / step / loop');
	await page.locator('#animation-pane-plot').tap();

	// ---------------- #36 Shader ----------------
	await open('shader', 'shaderEditorClose');
	await page.waitForSelector('#shader-create-btn', { timeout: 10000 });
	await page.locator('#shader-create-btn').tap();
	await page.waitForSelector('#shader-editor .svelte-flow__node', { timeout: 10000 });
	await page.waitForTimeout(800);
	const layout = await page.evaluate(() => {
		const canvas = document.querySelector('#shader-editor .shader-canvas')?.getBoundingClientRect();
		const ed = document.getElementById('shader-editor')?.getBoundingClientRect();
		return {
			full: !!canvas && !!ed && canvas.width >= ed.width - 4,
			columns: !!document.querySelector('#shader-editor .shader-side'),
			buttons: !!document.getElementById('shader-palette-sheet-btn') && !!document.getElementById('shader-props-sheet-btn')
		};
	});
	h.check(layout.full && !layout.columns, `shader: the canvas takes the full width, no side columns (${JSON.stringify(layout)})`);
	h.check(layout.buttons, 'shader: Nodes and Properties buttons sit over the canvas');

	const transform = () => page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#shader-editor .svelte-flow__viewport'))?.style.transform ?? '');
	const pane = await page.evaluate(() => {
		// an EMPTY spot of the pane: under the canvas buttons, away from every node
		const c = document.querySelector('#shader-editor .shader-canvas').getBoundingClientRect();
		const nodes = [...document.querySelectorAll('#shader-editor .svelte-flow__node, #shader-editor .svelte-flow__controls, #shader-editor .shader-fabs > *')].map((n) => n.getBoundingClientRect());
		for (let y = c.bottom - 30; y > c.top + 50; y -= 15) {
			for (let x = c.left + 60; x < c.right - 30; x += 15) {
				if (!nodes.some((r) => x > r.left - 30 && x < r.right + 30 && y > r.top - 30 && y < r.bottom + 30)) {
					const at = document.elementFromPoint(x, y);
					if (at?.closest('.svelte-flow__pane')) return { x, y };
				}
			}
		}
		return null;
	});
	h.check(!!pane, 'shader: found an empty spot of the canvas to put a finger on');
	const t0 = await transform();
	if (pane) await touch.drag([[pane.x, pane.y], [pane.x - 70, pane.y - 30]], 10);
	await page.waitForTimeout(400);
	const t1 = await transform();
	h.check(!!t0 && t0 !== t1, `shader: a finger drag on the canvas PANS it (${t0} -> ${t1})`);

	const nodeCount = () => page.evaluate(() => document.querySelectorAll('#shader-editor .svelte-flow__node').length);
	const n0 = await nodeCount();
	await page.locator('#shader-palette-sheet-btn').tap();
	await page.waitForSelector('#shader-palette-sheet #shader-palette', { timeout: 5000 });
	await page.locator('#shader-palette .shader-palette-item', { hasText: /^\s*Float\s*$/ }).first().tap();
	await page.waitForTimeout(700);
	const n1 = await nodeCount();
	const sheetGone = await page.evaluate(() => !document.getElementById('shader-palette-sheet'));
	h.check(n1 === n0 + 1 && sheetGone, `shader: a tap in the Nodes sheet adds the node and closes the sheet (${n0} -> ${n1})`);

	// CONNECT BY DRAG: the new Float's output to the Surface's "emissive" socket
	const edgeCount = () => page.evaluate(() => document.querySelectorAll('#shader-editor .svelte-flow__edge').length);
	const e0 = await edgeCount();
	const sockets = await page.evaluate(() => {
		const nodes = [...document.querySelectorAll('#shader-editor .svelte-flow__node')];
		const float = nodes.find((n) => /Float/.test(n.textContent ?? '') && !/Surface/.test(n.textContent ?? ''));
		const surface = nodes.find((n) => /Surface/.test(n.textContent ?? ''));
		const src = float?.querySelector('.svelte-flow__handle.source');
		const dst = surface && [...surface.querySelectorAll('.svelte-flow__handle.target')].find((h) => (h.getAttribute('data-handleid') ?? '').includes('emissive'));
		const c = (/** @type {Element|null|undefined} */ el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		};
		return { src: c(src), dst: c(dst) };
	});
	h.check(!!sockets.src && !!sockets.dst, `shader: both sockets are on screen (${JSON.stringify(sockets)})`);
	if (sockets.src && sockets.dst) {
		// land 6px off the socket centre: a finger is never exact, the enlarged target catches it
		await touch.drag([[sockets.src.x + 4, sockets.src.y + 3], [sockets.dst.x - 6, sockets.dst.y + 5]], 14);
	}
	await page.waitForTimeout(700);
	const e1 = await edgeCount();
	h.check(e1 === e0 + 1, `shader: a finger drags a wire from a socket to a socket (${e0} -> ${e1} wires)`);

	await page.locator('#shader-props-sheet-btn').tap();
	await page.waitForTimeout(500);
	const props = await page.evaluate(() => !!document.querySelector('#shader-props-sheet #shader-props-graph, #shader-props-sheet #shader-props-node'));
	h.check(props, 'shader: Properties opens as a sheet with the graph / node settings');
	await page.evaluate(() => /** @type {HTMLElement|null} */ (document.querySelector('#shader-props-sheet .sh-close'))?.click());

	// ---------------- DESKTOP: none of it leaks ----------------
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } } });
	const dp = D.page;
	await dp.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 600));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.animationPreview.addTrack(box.uuid, 'pos.y', box);
		w.objectActions.selectObject(box.uuid, false);
	});
	const dOpen = (/** @type {string} */ key, /** @type {string} */ store) =>
		dp.evaluate(
			([key, store]) => {
				const s = window.__stores;
				for (const k of ['animationClose', 'uvEditorClose', 'shaderEditorClose', 'profilerClose']) s[k].set(true);
				s[store].set(false);
				s.bottomDock.activateDock(key);
			},
			[key, store]
		);
	await dOpen('animation', 'animationClose');
	await dp.waitForSelector('#animation-timeline', { timeout: 10000 });
	await dp.waitForTimeout(500);
	const dAnim = await dp.evaluate(() => ({
		switch: !!document.getElementById('animation-pane'),
		keyCol: !!document.getElementById('animation-length'),
		hit: document.querySelectorAll('.an-hit').length,
		fade: document.getElementById('animation-plot-tools')?.dataset.fade ?? ''
	}));
	h.check(!dAnim.switch && dAnim.keyCol && dAnim.hit === 0, `desktop: the animation window keeps its columns, no pane switch, no touch hit areas (${JSON.stringify(dAnim)})`);
	h.check(dAnim.fade === '', `desktop: a timeline toolbar that fits shows no fade ("${dAnim.fade}")`);
	await dOpen('shader', 'shaderEditorClose');
	await dp.waitForSelector('#shader-editor', { timeout: 10000 });
	await dp.waitForTimeout(500);
	const dShader = await dp.evaluate(() => ({
		toggles: !!document.getElementById('shader-palette-toggle') && !!document.getElementById('shader-props-toggle'),
		buttons: !!document.getElementById('shader-palette-sheet-btn')
	}));
	h.check(dShader.toggles && !dShader.buttons, `desktop: the shader editor keeps its side columns and toggles (${JSON.stringify(dShader)})`);
	await dOpen('profiler', 'profilerClose');
	await dp.waitForSelector('#profiler-toolbar', { timeout: 10000 });
	await dp.waitForTimeout(500);
	const dProf = await dp.evaluate(() => {
		const s = document.getElementById('profiler-toolbar');
		return { overflow: s ? s.scrollWidth - s.clientWidth : -1, fade: s?.dataset.fade ?? '' };
	});
	h.check(dProf.overflow <= 1 && dProf.fade === '', `desktop: the profiler toolbar fits, nothing scrolls or fades (${JSON.stringify(dProf)})`);

	h.check(h.pageErrors(P).length === 0 && h.pageErrors(D).length === 0, 'no page errors on either page');
	await h.finish(browser);
});
