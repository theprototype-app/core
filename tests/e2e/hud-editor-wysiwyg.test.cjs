// 21-E1 — THE HUD EDITOR IS CORRECT: drop, add-at-position, WYSIWYG, z-tier, guides.
//
// Every section here covers a thing that was WRONG rather than missing, so each one has a
// counterfactual worth stating:
//
//   * the palette set `application/x-hud-kind` in ondragstart and NOTHING consumed it, while
//     App.svelte's window-level dragover preventDefault made every surface look droppable —
//     so the drop the palette hint promises silently did nothing (E1.1);
//   * `add(kind)` ignored every position source and used a `24 + (n % 6) * 16` cascade, which
//     WRAPS: the 7th element landed exactly on the 1st (E1.2);
//   * the artboard multiplied BOX rects by the scale while HudElement emitted its font-size in
//     absolute px, so a 0.3-scaled board clipped text the runtime shows (E1.3);
//   * the layer sat at --z-hud 45 while authoring, i.e. OVER every floating window, and an
//     interactive kind swallowed the clicks meant for it (E1.5);
//   * snapping existed and was invisible: no persisted on/off, constant grid and threshold,
//     and the lines a drag landed on were never drawn (E1.7);
//   * `flowRuntime`'s onInput subscriber read `event.type`/`event.code` off the first
//     POSITIONAL arg (`fn('down', code)`), so it returned on every press and only the ~3/s
//     held re-stamp ever fired a Key Press node — a TAP fired nothing at all (E1.8).
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-editor-wysiwyg
const h = require('./helpers.cjs');

/** the HUD editor, opened and pointed at a known document */
async function openEditor(page) {
	await page.evaluate(() => {
		window.__stores.hudDocs.clearHudDocs();
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1400);
}

/** a point inside the artboard, as a fraction of the stage */
async function boardPoint(page, fx, fy) {
	return page.evaluate(
		(f) => {
			const b = document.querySelector('#hud-board').getBoundingClientRect();
			return { x: Math.round(b.x + b.width * f.fx), y: Math.round(b.y + b.height * f.fy) };
		},
		{ fx, fy }
	);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ======================================================================
	// 0. E1.8 — THE KEY PRESS NODE, before anything opens (nothing focused)
	// ======================================================================
	// A single TAP. The old subscriber returned on every event, so the only thing that ever
	// fired a keypress node was the held-key re-stamp in the tick (~3/s) — which a tap never
	// reaches, because the key is up again before the next tick looks. So the honest
	// assertions are BOTH the latency and that a tap fires at all.
	const tapped = await page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'kp-1', type: 'keypress', position: { x: 0, y: 0 }, data: { type: 'keypress', code: 'KeyJ', pulse: 0.3 } },
			{ id: 'kc-1', type: 'counter', position: { x: 240, y: 0 }, data: { type: 'counter', step: 1, op: 'up' } }
		]);
		s.flowEdges.set([{ id: 'kp-e', source: 'kp-1', target: 'kc-1', targetHandle: 'pulse' }]);
		return true;
	});
	h.check(tapped, 'premise: a Key Press node feeds a Counter');
	await page.waitForTimeout(900);
	// the subscription is installed with NO stamp on the node yet, so the first value it
	// sees is the press itself and not a replay of history
	await page.evaluate(() => {
		document.body.focus();
		window.__kp = { at: null, t0: 0, count: 0 };
		window.__kpStop = window.__stores.flowTriggers.subscribe((t) => {
			if (!t) return;
			if (window.__kp.at === null && t['kp-1']) window.__kp.at = performance.now();
			window.__kp.count = t['kc-1']?.count ?? 0;
		});
	});
	const preCount = await page.evaluate(() => window.__kp.count);
	await page.evaluate(() => (window.__kp.t0 = performance.now()));
	await page.keyboard.press('KeyJ'); // a TAP: down and straight back up
	await page.waitForTimeout(700);
	const kp = await page.evaluate(() => {
		window.__kpStop?.();
		return { at: window.__kp.at, t0: window.__kp.t0, count: window.__kp.count };
	});
	h.check(
		kp.at !== null,
		`a single TAP fires the Key Press node at all — the old path needed the key HELD (stamped=${kp.at !== null})`
	);
	const latency = kp.at === null ? Infinity : kp.at - kp.t0;
	h.check(
		latency < 100,
		`and it fires on the KEYDOWN, not on the ~3/s re-stamp (${latency === Infinity ? 'never' : Math.round(latency) + 'ms'}, budget 100ms incl. the CDP round trip)`
	);
	h.check(
		kp.count === preCount + 1,
		`one tap counts exactly once (${preCount} -> ${kp.count})`
	);
	await page.evaluate(() => {
		window.__stores.flowNodes.set([]);
		window.__stores.flowEdges.set([]);
	});

	// ======================================================================
	// 1. E1.1 — a palette DROP lands where it was released
	// ======================================================================
	await openEditor(page);
	const opened = await page.evaluate(() => ({
		board: !!document.querySelector('#hud-board'),
		stage: !!document.querySelector('#hud-stage'),
		ghost: !!document.querySelector('#hud-viewport-ghost'),
		ref: document.querySelector('#hud-stage-ref')?.textContent?.trim() ?? ''
	}));
	h.check(opened.board && opened.stage, 'premise: the artboard is up, with a 1:1 stage inside it');
	// E1.4, in the same breath: the reference resolution is stated, and the current
	// viewport's shape is drawn on the stage
	h.check(/1280/.test(opened.ref), `the topbar names the reference resolution (${opened.ref})`);
	h.check(opened.ghost, 'and a ghost outline shows the CURRENT viewport on the stage');

	const dropPt = await boardPoint(page, 0.72, 0.66);
	const dropped = await page.evaluate((pt) => {
		const board = document.querySelector('#hud-board');
		const dt = new DataTransfer();
		dt.setData('application/x-hud-kind', 'button');
		const fire = (type) =>
			board.dispatchEvent(
				new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y })
			);
		const overDefaultPrevented = !fire('dragover');
		// the STAGE point the drop happened at, measured against the board as it was AT
		// DROP TIME: selecting the new element auto-opens the properties pane, and the board
		// is centred in what is left, so its left edge moves afterwards
		const br = board.getBoundingClientRect();
		const scale = br.width / 1280;
		fire('drop');
		return {
			overDefaultPrevented,
			stageX: (pt.x - br.left) / scale,
			stageY: (pt.y - br.top) / scale
		};
	}, dropPt);
	h.check(
		dropped.overDefaultPrevented,
		'the board accepts the drag (dragover is preventDefault()ed, so the browser allows a drop)'
	);
	await page.waitForTimeout(700);
	const landed = await page.evaluate((d) => {
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		const els = doc.screens[0].elements;
		if (els.length !== 1) return { count: els.length };
		const el = els[0];
		// ANCHOR-AWARE: x/y are offsets in the element's own anchor frame, so the stage
		// centre is derived the way the 9-grid means them rather than assumed to be x + w/2
		const [v, hz] = el.anchor === 'center' ? ['middle', 'center'] : String(el.anchor).split('-');
		const left = hz === 'left' ? el.x : hz === 'right' ? 1280 - el.x - el.w : 640 - el.w / 2 + el.x;
		const top = v === 'top' ? el.y : v === 'bottom' ? 720 - el.y - el.h : 360 - el.h / 2 + el.y;
		return {
			count: els.length,
			kind: el.kind,
			anchor: el.anchor,
			x: el.x,
			y: el.y,
			stageCx: Math.round(left + el.w / 2),
			stageCy: Math.round(top + el.h / 2),
			wantCx: Math.round(d.stageX),
			wantCy: Math.round(d.stageY)
		};
	}, dropped);
	h.check(landed.count === 1 && landed.kind === 'button', `the drop CREATES the dropped kind (${landed.count} × ${landed.kind})`);
	h.check(
		Math.abs(landed.stageCx - landed.wantCx) <= 3 && Math.abs(landed.stageCy - landed.wantCy) <= 3,
		`and it lands WHERE IT WAS RELEASED (stage centre ${landed.stageCx},${landed.stageCy} vs drop ${landed.wantCx},${landed.wantCy}; anchor ${landed.anchor})`
	);
	// the counterfactual: the old cascade put every add at (24,24) + n*16, regardless
	h.check(
		landed.x > 200 && landed.y > 100,
		`not in the old fixed cascade corner (authored x=${landed.x}, y=${landed.y}; the cascade was 24,24)`
	);

	// ======================================================================
	// 2. E1.2 — the context menu adds AT THE CLICK, with registry labels
	// ======================================================================
	const menuPt = await boardPoint(page, 0.22, 0.28);
	await page.mouse.click(menuPt.x, menuPt.y, { button: 'right' });
	await page.waitForTimeout(700);
	const menuRows = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] *')]
			.filter((el) => el.children.length === 0)
			.map((el) => (el.textContent ?? '').trim())
			.filter(Boolean)
	);
	h.check(menuRows.length > 0, `premise: the Add menu is open (${menuRows.length} rows)`);
	// LABELS, not registry keys: 'Text field' rather than 'textfield'
	h.check(
		menuRows.includes('Text field') && !menuRows.includes('textfield'),
		`the menu shows the kind's own LABEL, not its key (has "Text field": ${menuRows.includes('Text field')}, has "textfield": ${menuRows.includes('textfield')})`
	);
	await page.evaluate(() => {
		const row = [...document.querySelectorAll('[role="menu"] *')].find(
			(el) => el.children.length === 0 && (el.textContent ?? '').trim() === 'Crosshair'
		);
		row?.click();
	});
	await page.waitForTimeout(700);
	const fromMenu = await page.evaluate((pt) => {
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		const el = doc.screens[0].elements.find((e) => e.kind === 'crosshair');
		if (!el) return null;
		const r = document.querySelector(`#hud-board [data-hud-item="${el.id}"]`)?.getBoundingClientRect();
		return {
			x: el.x,
			y: el.y,
			cx: r ? Math.round(r.x + r.width / 2) : null,
			cy: r ? Math.round(r.y + r.height / 2) : null,
			clickX: pt.x,
			clickY: pt.y
		};
	}, menuPt);
	h.check(!!fromMenu, 'the menu row adds the element');
	h.check(
		fromMenu && Math.abs(fromMenu.cx - fromMenu.clickX) <= 4 && Math.abs(fromMenu.cy - fromMenu.clickY) <= 4,
		`and it lands at the RIGHT-CLICK point (${fromMenu?.cx},${fromMenu?.cy} vs click ${fromMenu?.clickX},${fromMenu?.clickY})`
	);
	// two elements added at two different points must not be on top of each other, which
	// the wrapping cascade could not promise
	const spread = await page.evaluate(() => {
		const els = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements;
		return els.map((e) => e.x + ',' + e.y);
	});
	h.check(new Set(spread).size === spread.length, `every add has its own position (${spread.join(' · ')})`);

	// ======================================================================
	// 3. E1.3 — the artboard is WYSIWYG: rect parity AND text-clip parity
	// ======================================================================
	// 21-D5 hides the HUD in the viewport while the editor is open, so the comparison needs
	// the preview on — through the eye toggle's OWN store, never a test-only door.
	const par = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.hudPreviewInViewport.set(true);
		H.clearHudDocs();
		H.setHudDocFor('scene', {});
		const doc = H.hudDocOf('scene');
		const sid = doc.screens[0].id;
		const el = H.addHudElement('scene', sid, {
			kind: 'text',
			label: 'Score: 1234567',
			anchor: 'top-left',
			x: 40,
			y: 40,
			w: 300,
			h: 30,
			style: { size: 18 }
		});
		await new Promise((r) => setTimeout(r, 900));
		return { id: el.id, sid };
	});
	const measure = () =>
		page.evaluate((d) => {
			const item = document.querySelector(`#hud-board [data-hud-item="${d.id}"]`);
			const live = document.querySelector(`#hud-layer [data-hud-id="${d.id}"]`);
			const board = document.querySelector('#hud-board');
			if (!item || !live || !board) return null;
			const artText = item.querySelector('.hud-el');
			const liveText = live.querySelector('.hud-el');
			const el = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id);
			const br = board.getBoundingClientRect();
			return {
				w: el.w,
				scale: br.width / 1280,
				// the CONTENT box: 1:1 with the authored size is the mechanism (it used to be
				// authored * scale, while the font stayed at its authored px)
				artClientW: artText?.clientWidth ?? -1,
				liveClientW: liveText?.clientWidth ?? -1,
				// and the RENDERED box still fits the artboard, because the transform scales it
				artRenderW: artText ? Math.round(artText.getBoundingClientRect().width) : -1,
				liveRenderW: liveText ? Math.round(liveText.getBoundingClientRect().width) : -1,
				artScroll: artText?.scrollWidth ?? -1,
				liveScroll: liveText?.scrollWidth ?? -1,
				artClips: artText ? artText.scrollWidth > artText.clientWidth + 1 : null,
				liveClips: liveText ? liveText.scrollWidth > liveText.clientWidth + 1 : null
			};
		}, par);

	const wide = await measure();
	h.check(!!wide, 'premise: the element is on the artboard AND in the runtime layer');
	h.check(wide.scale < 0.9, `premise: the artboard is genuinely scaled down (scale ${wide.scale.toFixed(3)})`);
	h.check(
		wide.artClientW === wide.liveClientW,
		`the artboard lays the element out at 1:1, exactly like the runtime (content ${wide.artClientW}px vs ${wide.liveClientW}px)`
	);
	h.check(
		Math.abs(wide.artRenderW - wide.liveRenderW * wide.scale) <= 2,
		`and DRAWS it scaled to fit, so the box is still right on screen (${wide.artRenderW}px = ${wide.liveRenderW} × ${wide.scale.toFixed(3)})`
	);
	h.check(
		wide.artScroll === wide.liveScroll,
		`the text measures the same in both (scrollWidth ${wide.artScroll} vs ${wide.liveScroll})`
	);

	// A LABEL THAT BARELY FITS, which is the case the old artboard got wrong: at 0.3 scale
	// its content box was a third as wide with the same font, so it clipped while the
	// runtime did not.
	const justFits = await page.evaluate(async (d) => {
		const live = document.querySelector(`#hud-layer [data-hud-id="${d.id}"] .hud-el`);
		// scrollWidth is clamped below by clientWidth, so it reports the BOX whenever the
		// text fits. A Range over the contents measures the text itself.
		const range = document.createRange();
		range.selectNodeContents(live);
		const need = Math.ceil(range.getBoundingClientRect().width);
		const H = window.__stores.hudDocs;
		H.updateHudElement('scene', d.sid, d.id, { w: need + 4 });
		await new Promise((r) => setTimeout(r, 700));
		return need;
	}, par);
	const fitted = await measure();
	h.check(
		fitted.liveClips === false && fitted.w === justFits + 4,
		`premise: at ${justFits + 4}px — four more than the label needs — it JUST fits at runtime (clips=${fitted.liveClips})`
	);
	h.check(
		fitted.artClips === fitted.liveClips,
		`and the artboard agrees — TEXT-CLIP PARITY (artboard clips=${fitted.artClips}, runtime clips=${fitted.liveClips})`
	);
	await page.evaluate(async (d) => {
		window.__stores.hudDocs.updateHudElement('scene', d.sid, d.id, { w: Math.max(16, d.need - 24) });
		await new Promise((r) => setTimeout(r, 700));
	}, { ...par, need: justFits });
	const clipped = await measure();
	h.check(
		clipped.liveClips === true && clipped.artClips === true,
		`and both clip together once it does not fit (artboard=${clipped.artClips}, runtime=${clipped.liveClips})`
	);

	// the board clips at the STAGE now, like the runtime clips at the window
	const clipStyle = await page.evaluate(() => getComputedStyle(document.querySelector('#hud-board')).overflow);
	h.check(clipStyle === 'hidden', `the artboard clips at the stage edge (overflow: ${clipStyle})`);

	// ======================================================================
	// 4. E1.5 — while AUTHORING the layer sits BELOW a floating window
	// ======================================================================
	// Undock the HUD editor: that is a real floating window at --z-window, and the one
	// guaranteed to be on screen.
	await page.evaluate(() => {
		const btn = document.querySelector('#hud-dock button[title="Undock into a floating window"]');
		btn?.click();
	});
	await page.waitForTimeout(1200);
	const zAuthoring = await page.evaluate(async () => {
		const win = document.querySelector('#hud-window');
		if (!win) return { noWindow: true };
		const wr = win.getBoundingClientRect();
		const cx = Math.round(wr.x + wr.width / 2);
		const cy = Math.round(wr.y + wr.height / 2);
		// a BUTTON (pointer-events: auto — the kind that swallowed clicks) placed over the
		// window. Runtime coords are real window px, so x/y go straight in.
		const H = window.__stores.hudDocs;
		const doc = H.hudDocOf('scene');
		const sid = doc.screens[0].id;
		const el = H.addHudElement('scene', sid, {
			kind: 'button',
			label: 'OVER',
			anchor: 'top-left',
			x: cx - 80,
			y: cy - 18,
			w: 160,
			h: 36
		});
		await new Promise((r) => setTimeout(r, 900));
		const layer = document.querySelector('#hud-layer');
		const slot = document.querySelector(`#hud-layer [data-hud-id="${el.id}"]`);
		const sr = slot?.getBoundingClientRect();
		const at = document.elementFromPoint(cx, cy);
		return {
			id: el.id,
			cx,
			cy,
			layerZ: layer ? getComputedStyle(layer).zIndex : null,
			winZ: getComputedStyle(win).zIndex,
			authoring: layer?.getAttribute('data-authoring'),
			// premise: the HUD element really does cover that pixel
			covers: !!sr && sr.left <= cx && sr.right >= cx && sr.top <= cy && sr.bottom >= cy,
			hitInWindow: !!at?.closest('#hud-window'),
			hitInLayer: !!at?.closest('#hud-layer'),
			hit: at?.tagName + '.' + (at?.className?.toString?.().slice(0, 40) ?? '')
		};
	});
	h.check(!zAuthoring.noWindow, 'premise: the editor undocks into a floating window');
	h.check(zAuthoring.covers, `premise: a HUD button really covers the window's centre pixel (${zAuthoring.cx},${zAuthoring.cy})`);
	h.check(
		zAuthoring.authoring === 'true' && Number(zAuthoring.layerZ) < Number(zAuthoring.winZ),
		`while authoring the layer sits BELOW the window (layer z=${zAuthoring.layerZ}, window z=${zAuthoring.winZ})`
	);
	h.check(
		zAuthoring.hitInWindow && !zAuthoring.hitInLayer,
		`so the click goes to the WINDOW, not to the HUD button over it (hit ${zAuthoring.hit})`
	);

	// ...and in PLAY it keeps 45, which is the 21-A rule and must not have moved
	const zPlaying = await page.evaluate(async () => {
		window.__stores.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 900));
		const layer = document.querySelector('#hud-layer');
		return {
			z: layer ? getComputedStyle(layer).zIndex : null,
			authoring: layer?.getAttribute('data-authoring')
		};
	});
	h.check(
		zPlaying.z === '45' && zPlaying.authoring === 'false',
		`and in PLAY mode it is back on --z-hud, above the camera PiP (z=${zPlaying.z})`
	);
	// the focus-ring capture handler is play-mode-only now: in the editor it stole
	// Tab/arrows/Space from every panel whenever a screen had a button
	const ringKeys = await page.evaluate(async () => {
		const s = window.__stores;
		s.isLocked.set(null);
		await new Promise((r) => setTimeout(r, 700));
		window.__tabSeen = 0;
		window.addEventListener('keydown', (e) => {
			if (e.code === 'Tab') window.__tabSeen++;
		});
		return true;
	});
	void ringKeys;
	await page.keyboard.press('Tab');
	await page.waitForTimeout(300);
	const tabReached = await page.evaluate(() => window.__tabSeen);
	h.check(
		tabReached === 1,
		`with a button on screen but no play mode, Tab still reaches the app (${tabReached} of 1)`
	);
	// back to docked for the rest of the run
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('#hud-window button')].find((b) => /Dock/.test(b.textContent ?? ''));
		btn?.click();
	});
	await page.waitForTimeout(1200);

	// ======================================================================
	// 5. E1.7 — the guides are DRAWN, and the snap prefs persist
	// ======================================================================
	const guideSetup = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.clearHudDocs();
		H.setHudDocFor('scene', {});
		const sid = H.hudDocOf('scene').screens[0].id;
		// the anchor's left edge is at 403 — deliberately NOT a multiple of the 8px grid, or
		// the grid would already be at distance 0 and no guide could ever beat it
		const anchor = H.addHudElement('scene', sid, { kind: 'panel', anchor: 'top-left', x: 403, y: 300, w: 200, h: 90 });
		const mover = H.addHudElement('scene', sid, { kind: 'text', label: 'drag me', anchor: 'top-left', x: 150, y: 120, w: 160, h: 30 });
		await new Promise((r) => setTimeout(r, 900));
		return { sid, anchor: anchor.id, mover: mover.id };
	});
	const grip = await page.evaluate((g) => {
		const r = document.querySelector(`#hud-board [data-hud-item="${g.mover}"]`).getBoundingClientRect();
		const board = document.querySelector('#hud-board').getBoundingClientRect();
		return {
			x: Math.round(r.x + r.width / 2),
			y: Math.round(r.y + r.height / 2),
			scale: board.width / 1280,
			left: r.x
		};
	}, guideSetup);
	const under = await page.evaluate(
		(pt) => document.elementFromPoint(pt.x, pt.y)?.closest('[data-hud-item]')?.getAttribute('data-hud-item'),
		grip
	);
	h.check(under === guideSetup.mover, `premise: the press lands on the element to drag (${under})`);
	// aim its LEFT edge at 403 (stage px), in screen px
	const dx = Math.round((403 - 150) * grip.scale);
	await page.mouse.move(grip.x, grip.y);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(grip.x + Math.round((dx * i) / 8), grip.y);
	await page.waitForTimeout(200);
	const midDrag = await page.evaluate(() => ({
		guides: document.querySelectorAll('#hud-board [data-hud-guide]').length,
		xs: [...document.querySelectorAll('#hud-board [data-hud-guide="x"]')].map((el) => el.style.left)
	}));
	h.check(midDrag.guides > 0, `a guide line is DRAWN while the drag is snapped to it (${midDrag.guides} guide(s) at ${midDrag.xs.join(', ')})`);
	await page.mouse.up();
	await page.waitForTimeout(600);
	const afterDrag = await page.evaluate((g) => {
		const els = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements;
		return {
			moverX: els.find((e) => e.id === g.mover).x,
			guides: document.querySelectorAll('#hud-board [data-hud-guide]').length
		};
	}, guideSetup);
	h.check(afterDrag.moverX === 403, `and the edge SNAPPED to its neighbour, not to the grid (x=${afterDrag.moverX}, grid would be 400 or 408)`);
	h.check(afterDrag.guides === 0, `the guides clear when the gesture ends (${afterDrag.guides})`);

	// the snap settings live in the no-selection pane, and they PERSIST
	const prefs = await page.evaluate(async () => {
		// nothing selected -> the settings pane
		window.__stores.hudDocs.hudSelection.set({});
		document.querySelector('#hud-board')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		await new Promise((r) => setTimeout(r, 600));
		const box = document.querySelector('#hud-snap-on');
		const grid = document.querySelector('#hud-snap-grid');
		const pull = document.querySelector('#hud-snap-threshold');
		return { hasBox: !!box, hasGrid: !!grid, hasPull: !!pull, checked: box?.checked };
	});
	h.check(prefs.hasBox && prefs.hasGrid && prefs.hasPull, 'the no-selection pane offers snap on/off, grid and pull');
	h.check(prefs.checked === true, `premise: snapping is on (${prefs.checked})`);
	await page.locator('#hud-snap-on').click();
	await page.waitForTimeout(400);
	const stored = await page.evaluate(() => ({
		on: localStorage.getItem('hud:snapOn'),
		grid: localStorage.getItem('hud:snapGrid'),
		pull: localStorage.getItem('hud:snapThreshold')
	}));
	h.check(stored.on === 'false', `toggling it writes the pref (hud:snapOn=${stored.on})`);
	h.check(stored.grid !== null && stored.pull !== null, `and the grid/pull are stored too (${stored.grid}/${stored.pull})`);
	await h.freshReload(A);
	await page.waitForTimeout(1200);
	const survived = await page.evaluate(async () => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
		await new Promise((r) => setTimeout(r, 1400));
		const box = document.querySelector('#hud-snap-on');
		return { checked: box?.checked, raw: localStorage.getItem('hud:snapOn') };
	});
	h.check(
		survived.checked === false && survived.raw === 'false',
		`and it SURVIVES a reload — the pref was never persisted before (checked=${survived.checked})`
	);
	// leave it on for anyone reading the localStorage after this run
	await page.evaluate(() => localStorage.setItem('hud:snapOn', 'true'));

	// ======================================================================
	// 6. E1.6 — the colour swatch opens a picker, and merely OPENING it writes nothing
	// ======================================================================
	const cp = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.clearHudDocs();
		H.setHudDocFor('scene', {});
		const sid = H.hudDocOf('scene').screens[0].id;
		// a TOKEN value, which is the case the mount echo would destroy: the picker seeds
		// from the RESOLVED colour, so a guard comparing against the authored text would
		// let simply opening the popover rewrite `accent` as a hex
		const el = H.addHudElement('scene', sid, {
			kind: 'text',
			label: 'tinted',
			anchor: 'top-left',
			x: 60,
			y: 60,
			style: { color: 'accent' }
		});
		H.hudSelection.set({ scene: [el.id] });
		await new Promise((r) => setTimeout(r, 500));
		// select it through the artboard, so the properties pane opens the way it does for a user
		const item = document.querySelector(`#hud-board [data-hud-item="${el.id}"]`);
		item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		await new Promise((r) => setTimeout(r, 900));
		return { id: el.id, sid, swatches: document.querySelectorAll('[data-hud-swatch]').length };
	});
	h.check(cp.swatches > 0, `premise: the properties pane shows colour swatches (${cp.swatches})`);
	await page.locator('[data-hud-swatch="color"]').first().click();
	await page.waitForTimeout(900);
	const popped = await page.evaluate((d) => {
		const pop = document.querySelector('[data-hud-colorpicker]');
		const el = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id);
		return {
			open: !!pop,
			portaled: pop?.parentElement === document.body,
			chips: document.querySelectorAll('[data-hud-token]').length,
			hasPicker: !!pop?.querySelector('[aria-label="color picker"], .wrapper'),
			colour: el?.style?.color
		};
	}, cp);
	h.check(popped.open, 'clicking the swatch opens a colour popover');
	h.check(popped.portaled, 'PORTALED to body, so a transformed panel ancestor cannot capture its fixed position');
	h.check(popped.hasPicker, 'with the app colour picker inside it');
	h.check(popped.chips >= 4, `and a row of theme-token chips (${popped.chips})`);
	h.check(
		popped.colour === 'accent',
		`and merely OPENING it does not overwrite a theme token — the mount-echo guard (colour still ${popped.colour})`
	);
	await page.locator('[data-hud-token="text-2"]').click();
	await page.waitForTimeout(600);
	const chose = await page.evaluate(
		(d) => window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.find((e) => e.id === d.id)?.style?.color,
		cp
	);
	h.check(chose === 'text-2', `a chip writes the TOKEN NAME, not a hex (${chose})`);
	// Escape closes the popover, and does not tear the editor down with it
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	const closed = await page.evaluate(() => ({
		pop: !!document.querySelector('[data-hud-colorpicker]'),
		board: !!document.querySelector('#hud-board')
	}));
	h.check(!closed.pop && closed.board, `Escape closes the popover and leaves the editor open (pop=${closed.pop}, board=${closed.board})`);

	// ======================================================================
	// 7. E1.8 — the two small consolidations
	// ======================================================================
	const small = await page.evaluate(() => {
		const cat = window.__stores.nodeCatalog.nodeCatalog;
		const game = cat.find((g) => g.group === 'Game');
		const setcamera = game.items.find((i) => i.type === 'setcamera');
		const states = window.__stores.gameState.GAME_STATES;
		const stateParams = game.items
			.filter((i) => i.params?.some((p) => p.key === 'state'))
			.map((i) => i.params.find((p) => p.key === 'state').options.join('|'));
		return {
			restore: Object.prototype.hasOwnProperty.call(setcamera.defaults, 'restore'),
			camera: Object.prototype.hasOwnProperty.call(setcamera.defaults, 'camera'),
			states: states.join('|'),
			stateParams
		};
	});
	h.check(!small.restore && small.camera, `setcamera's dead \`restore\` default is gone, \`camera\` remains (${JSON.stringify(small)})`);
	h.check(
		small.stateParams.length >= 2 && small.stateParams.every((s) => s === small.states),
		`every game-state list IS GAME_STATES, with the same strings (${small.states} · ${small.stateParams.join(' / ')})`
	);

	await h.finish(browser);
});
