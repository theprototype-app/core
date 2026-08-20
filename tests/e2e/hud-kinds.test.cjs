// 21-D1 + D2 — the element registry, per-kind parameters, and the sidebar palette.
//
// 21-A gave every kind the same property rows, which is why `image` shipped inside
// HUD_KINDS with no way to choose an image. The registry makes a kind a thing with its own
// parameters, and the properties pane walks it — so the checks that matter are that the
// pane is genuinely SCHEMA-DRIVEN (different kinds show different fields), that per-kind
// defaults reach the document, and that an unknown kind still round-trips untouched.
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-kinds
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudKinds, { timeout: 30000 });

	// ---- 1. the registry is the single source of truth ----------------------
	const reg = await page.evaluate(() => {
		const K = window.__stores.hudKinds;
		const H = window.__stores.hudDocs;
		return {
			kinds: K.HUD_KINDS,
			docKinds: H.HUD_KINDS,
			same: K.HUD_KINDS === H.HUD_KINDS,
			groups: K.paletteGroups().map((g) => g.group + ':' + g.items.length),
			// every def must carry the things the pane and the palette read
			complete: K.HUD_KIND_DEFS.every(
				(d) => d.key && d.label && d.group && d.icon && d.summary && d.defaultSize && Array.isArray(d.fields) && Array.isArray(d.style)
			),
			unknownDefaults: JSON.stringify(K.defaultsForKind('holotable')),
			unknownFields: K.fieldsForKind('holotable').length
		};
	});
	h.check(reg.same, 'hudDocs.HUD_KINDS IS the registry list — a kind is declared once');
	h.check(reg.kinds.includes('image') && reg.kinds.includes('bar'), `the kinds are registered (${reg.kinds.join(', ')})`);
	h.check(reg.complete, 'every def carries label/group/icon/summary/defaultSize/fields/style');
	h.check(reg.groups.length >= 2, `the palette groups (${reg.groups.join(' · ')})`);
	h.check(
		reg.unknownDefaults === '{}' && reg.unknownFields === 0,
		`an UNKNOWN kind contributes no defaults and no fields, so it passes through (${reg.unknownDefaults})`
	);

	// ---- 2. per-kind DEFAULTS reach the document ---------------------------
	const defaults = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const K = window.__stores.hudKinds;
		H.clearHudDocs();
		H.setHudDocFor('scene', {});
		const sid = H.hudDocOf('scene').screens[0].id;
		const made = {};
		for (const kind of K.HUD_KINDS) made[kind] = H.addHudElement('scene', sid, K.newElementOfKind(kind));
		const doc = H.hudDocOf('scene');
		const byKind = {};
		for (const el of doc.screens[0].elements) byKind[el.kind] = el;
		return {
			// a bar carries its own min/max/orientation, which 21-A had nowhere to put
			bar: { min: byKind.bar.min, max: byKind.bar.max, orientation: byKind.bar.orientation, w: byKind.bar.w, h: byKind.bar.h },
			// an image carries a src slot and a fit mode
			image: { src: byKind.image.src, fit: byKind.image.fit, w: byKind.image.w },
			// text gets its label default THROUGH normalize, which writes label AFTER the
			// spread — the bug this ordering caused once already
			text: { label: byKind.text.label, size: byKind.text.style?.size },
			crosshair: { thickness: byKind.crosshair.thickness, gap: byKind.crosshair.gap },
			button: { enabled: byKind.button.enabled, align: byKind.button.style?.align },
			count: doc.screens[0].elements.length
		};
	});
	h.check(defaults.count === reg.kinds.length, `one element per kind (${defaults.count})`);
	h.check(
		defaults.bar.min === 0 && defaults.bar.max === 100 && defaults.bar.orientation === 'horizontal',
		`a bar carries min/max/orientation (${JSON.stringify(defaults.bar)})`
	);
	h.check(
		defaults.bar.w === 220 && defaults.bar.h === 16,
		`and its own default SIZE from the registry, not a shared literal (${defaults.bar.w}x${defaults.bar.h})`
	);
	h.check(defaults.image.fit === 'contain' && defaults.image.src === '', `an image has a src slot and a fit (${JSON.stringify(defaults.image)})`);
	h.check(
		defaults.text.label === 'Text',
		`normalize does not clobber a kind default with its own literal — text keeps its label (${JSON.stringify(defaults.text.label)})`
	);
	h.check(defaults.text.size === 14, `and its style default (${defaults.text.size})`);
	h.check(defaults.crosshair.thickness === 2 && defaults.crosshair.gap === 4, `a crosshair carries thickness/gap (${JSON.stringify(defaults.crosshair)})`);
	h.check(defaults.button.enabled === true && defaults.button.align === 'center', `a button is enabled and centred (${JSON.stringify(defaults.button)})`);

	// an AUTHORED value must survive normalize — defaults merge UNDER, never over
	const authored = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		const sid = H.hudDocOf('scene').screens[0].id;
		const el = H.addHudElement('scene', sid, { kind: 'bar', min: 5, max: 50, orientation: 'vertical', w: 12, h: 200 });
		const back = H.elementById('scene', el.id);
		return { min: back.min, max: back.max, orientation: back.orientation, w: back.w, h: back.h };
	});
	h.check(
		authored.min === 5 && authored.max === 50 && authored.orientation === 'vertical' && authored.w === 12,
		`an AUTHORED param beats the default (${JSON.stringify(authored)})`
	);

	// ---- 3. the RENDER honours the per-kind params -------------------------
	const rendered = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.clearHudDocs();
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'main',
					name: 'Main',
					elements: [
						{ id: 'hb', kind: 'bar', min: 0, max: 100, value: 25, anchor: 'top-left', x: 20, y: 20, w: 200, h: 20 },
						{ id: 'vb', kind: 'bar', min: 0, max: 100, value: 25, orientation: 'vertical', anchor: 'top-left', x: 20, y: 60, w: 20, h: 200 },
						{ id: 'pc', kind: 'bar', min: 0, max: 200, value: 50, showPercent: true, anchor: 'top-left', x: 60, y: 60, w: 200, h: 20 },
						{ id: 'xh', kind: 'crosshair', thickness: 4, gap: 6, anchor: 'center', w: 40, h: 40 },
						{ id: 'dis', kind: 'button', label: 'Off', enabled: false, anchor: 'top-right', x: 20, y: 20 }
					]
				}
			],
			active: 'main'
		});
		await new Promise((r) => setTimeout(r, 700));
		const frac = (id, axis) => {
			const el = document.querySelector(`#hud-layer [data-hud-id="${id}"]`);
			const fill = el?.querySelector('.hud-bar-fill');
			const box = el?.querySelector('.hud-el');
			if (!fill || !box) return -1;
			const f = fill.getBoundingClientRect();
			const b = box.getBoundingClientRect();
			return Math.round((axis === 'w' ? f.width / b.width : f.height / b.height) * 100);
		};
		const xh = document.querySelector('#hud-layer [data-hud-id="xh"]');
		return {
			hFill: frac('hb', 'w'),
			vFillH: frac('vb', 'h'),
			// a VERTICAL bar must fill in height, and stay full width
			vFillW: frac('vb', 'w'),
			percentText: document.querySelector('#hud-layer [data-hud-id="pc"] .hud-bar-label')?.textContent?.trim(),
			arms: xh?.querySelectorAll('.hud-cross-arm').length ?? 0,
			disabled: !!document.querySelector('#hud-layer [data-hud-id="dis"] button')?.disabled
		};
	});
	h.check(rendered.hFill === 25, `a bar fills to (value-min)/(max-min) (${rendered.hFill}%)`);
	h.check(
		rendered.vFillH === 25 && rendered.vFillW === 100,
		`a VERTICAL bar fills in height and stays full width (${rendered.vFillH}% h, ${rendered.vFillW}% w)`
	);
	h.check(rendered.percentText === '25%', `showPercent renders the percentage, not the value (${rendered.percentText})`);
	h.check(rendered.arms === 4, `a crosshair draws four arms around its gap (${rendered.arms})`);
	h.check(rendered.disabled, 'a button with enabled: false is really disabled at runtime');

	// ---- 4. the properties pane is SCHEMA-DRIVEN --------------------------
	// The counterfactual that matters: two kinds must show DIFFERENT fields. A pane that
	// hardcoded its rows would show the same ones for both.
	await page.evaluate(() => {
		window.__stores.hudEditorClose.set(false);
		window.__stores.bottomDock.activateDock('hud');
	});
	await page.waitForTimeout(1800);
	const paneFor = async (kind) =>
		page.evaluate(async (k) => {
			const H = window.__stores.hudDocs;
			const K = window.__stores.hudKinds;
			const sid = H.hudDocOf('scene').screens[0].id;
			const el = H.addHudElement('scene', sid, K.newElementOfKind(k));
			H.hudSelection.set({ scene: [el.id] });
			// select it through the artboard so the pane follows the editor's own state
			await new Promise((r) => setTimeout(r, 400));
			const item = document.querySelector(`#hud-board [data-hud-item="${el.id}"]`);
			item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
			await new Promise((r) => setTimeout(r, 600));
			// the properties pane is secondaryDefaultOpen: false, so selecting an element is
			// what opens it (HudEditor's showSecondary effect) — give that a beat
			await new Promise((r) => setTimeout(r, 500));
			const pane = document.querySelector('#hud-dock');
			// BOTH row shapes: a text/select/toggle row is a .hud-field with a caption span,
			// while a NUMBER field is a DragRow, whose label is .dn-label. Reading only the
			// first missed min/max/value and made the bar look like it had no numeric params.
			const labels = [
				...[...(pane?.querySelectorAll('.hud-field > span:first-child') ?? [])],
				...[...(pane?.querySelectorAll('.dn-label') ?? [])]
			].map((s) => s.textContent?.trim());
			const heads = [...(pane?.querySelectorAll('.hud-sec-head') ?? [])].map((s) => s.textContent?.trim());
			return { id: el.id, labels, heads, hasPicker: !!pane?.querySelector('.hud-pick') };
		}, kind);

	const barPane = await paneFor('bar');
	const imagePane = await paneFor('image');
	h.check(
		barPane.heads.includes('Bar'),
		`the pane heads the kind's own section (${JSON.stringify(barPane.heads)})`
	);
	h.check(
		barPane.labels.includes('min') && barPane.labels.includes('max') && barPane.labels.includes('direction'),
		`a bar shows min/max/direction (${JSON.stringify(barPane.labels)})`
	);
	h.check(
		imagePane.labels.includes('image') && imagePane.labels.includes('fit'),
		`an image shows image/fit (${JSON.stringify(imagePane.labels)})`
	);
	// A premise first: this comparison passes on two EMPTY lists, and did exactly that
	// while the pane was closed — a check that cannot fail is not a check.
	h.check(
		barPane.labels.length > 4 && imagePane.labels.length > 4,
		`premise: both panes actually rendered fields (${barPane.labels.length} / ${imagePane.labels.length})`
	);
	h.check(
		!imagePane.labels.includes('min') && !barPane.labels.includes('fit'),
		'COUNTERFACTUAL: the two kinds show DIFFERENT fields — the pane really is schema-driven'
	);
	h.check(imagePane.hasPicker, 'and the image kind gets a real picker, which 21-A had no way to show at all');

	// ---- 5. D2: the palette lives in the sidebar and adds elements --------
	const palette = await page.evaluate(() => {
		const pal = document.querySelector('#hud-palette');
		const side = document.querySelector('#hud-dock .hud-side');
		const screens = document.querySelector('#hud-dock .hud-screens');
		const grip = document.querySelector('#hud-screens-resize');
		return {
			present: !!pal,
			inSidebar: !!(side && pal && side.contains(pal)),
			// the palette must sit BELOW the screens list
			below: !!(screens && pal && screens.getBoundingClientRect().bottom <= pal.getBoundingClientRect().top + 12),
			hasGrip: !!grip,
			kinds: [...(pal?.querySelectorAll('[data-hud-kind]') ?? [])].map((b) => b.getAttribute('data-hud-kind')),
			groups: [...(pal?.querySelectorAll('.hud-pal-group') ?? [])].map((g) => g.textContent?.trim())
		};
	});
	h.check(palette.present && palette.inSidebar, 'the add palette is in the LEFT SIDEBAR, not the topbar');
	h.check(palette.below, 'and sits BELOW the screens list');
	h.check(palette.hasGrip, 'with a horizontal grip between them');
	h.check(
		palette.kinds.length === reg.kinds.length,
		`it offers every registered kind (${palette.kinds.length} of ${reg.kinds.length})`
	);
	h.check(palette.groups.length >= 2, `grouped (${JSON.stringify(palette.groups)})`);

	const added = await page.evaluate(async () => {
		const before = window.__stores.hudDocs.hudDocOf('scene').screens[0].elements.length;
		const btn = document.querySelector('#hud-palette [data-hud-kind="list"]');
		btn?.click();
		await new Promise((r) => setTimeout(r, 600));
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		const last = doc.screens[0].elements[doc.screens[0].elements.length - 1];
		return { before, after: doc.screens[0].elements.length, kind: last.kind, rows: last.rows, w: last.w };
	});
	h.check(added.after === added.before + 1, `clicking a palette entry adds an element (${added.before} -> ${added.after})`);
	h.check(
		added.kind === 'list' && added.rows === 5 && added.w === 200,
		`with that kind's registry defaults (${JSON.stringify(added)})`
	);

	// the filter narrows the palette
	const filtered = await page.evaluate(async () => {
		const input = document.querySelector('#hud-palette-filter');
		// 'bar' now also matches the Hotbar pack kind, so the unique term is the one that
		// still proves the filter narrows (a term matching two kinds proves the opposite)
		input.value = 'crosshair';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 400));
		const shown = [...document.querySelectorAll('#hud-palette [data-hud-kind]')].map((b) => b.getAttribute('data-hud-kind'));
		input.value = '';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		return { shown, restored: document.querySelectorAll('#hud-palette [data-hud-kind]').length };
	});
	h.check(
		filtered.shown.length === 1 && filtered.shown[0] === 'crosshair',
		`the filter narrows it (${JSON.stringify(filtered.shown)})`
	);
	h.check(filtered.restored === reg.kinds.length, `and clearing it restores every kind (${filtered.restored})`);

	// ---- 6. the grip resizes, persists, and re-clamps on a SHRINKING pane --
	// A 320px dock leaves the screens list already AT its ceiling (paneH - reserve), so a
	// downward drag is a no-op and the check reads as a broken grip. Give it room first.
	await page.evaluate(() => window.__stores.bottomDock.dockHeight.set(560));
	await page.waitForTimeout(700);
	const grip = await page.evaluate(() => {
		const g = document.querySelector('#hud-screens-resize').getBoundingClientRect();
		const s = document.querySelector('#hud-dock .hud-screens');
		return { x: Math.round(g.x + g.width / 2), y: Math.round(g.y + g.height / 2), maxH: s.style.maxHeight };
	});
	await page.mouse.move(grip.x, grip.y);
	await page.mouse.down();
	await page.mouse.move(grip.x, grip.y + 60, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(500);
	const afterGrip = await page.evaluate(() => ({
		maxH: document.querySelector('#hud-dock .hud-screens').style.maxHeight,
		stored: localStorage.getItem('hudScreens:h')
	}));
	h.check(
		parseInt(afterGrip.maxH) > parseInt(grip.maxH),
		`dragging the grip grows the screens list (${grip.maxH} -> ${afterGrip.maxH})`
	);
	h.check(!!afterGrip.stored, `and persists it (hudScreens:h = ${afterGrip.stored})`);

	// a SHRINKING pane must re-clamp, or the grip strands off the bottom with no way back
	const shrunk = await page.evaluate(async () => {
		window.__stores.hudDocs.hudSelection.set({});
		window.__stores.bottomDock.dockHeight.set(200);
		await new Promise((r) => setTimeout(r, 800));
		const s = document.querySelector('#hud-dock .hud-screens');
		const g = document.querySelector('#hud-screens-resize');
		const dock = document.querySelector('#hud-dock').getBoundingClientRect();
		const gr = g.getBoundingClientRect();
		window.__stores.bottomDock.dockHeight.set(560);
		return {
			maxH: parseInt(s.style.maxHeight),
			gripInsideDock: gr.bottom <= dock.bottom + 1,
			gripOnScreen: gr.bottom <= window.innerHeight
		};
	});
	h.check(shrunk.maxH < parseInt(afterGrip.maxH), `a shrinking pane re-clamps the list (${afterGrip.maxH} -> ${shrunk.maxH}px)`);
	h.check(shrunk.gripInsideDock && shrunk.gripOnScreen, 'so the grip stays inside the dock and on screen');

	// ---- 7. an UNKNOWN kind still round-trips ------------------------------
	const unknown = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const doc = H.hudDocOf('scene');
		H.setHudDocFor('scene', {
			...doc,
			screens: doc.screens.map((s, i) =>
				i === 0 ? { ...s, elements: [...s.elements, { id: 'future', kind: 'holotable', label: 'Map', zoom: 3 }] } : s
			)
		});
		await new Promise((r) => setTimeout(r, 500));
		const back = H.elementById('scene', 'future');
		return {
			kept: !!back,
			kind: back?.kind,
			extra: back?.zoom,
			// and it is not rendered, because the registry does not know how
			rendered: !!document.querySelector('#hud-layer [data-hud-id="future"]')
		};
	});
	h.check(unknown.kept && unknown.kind === 'holotable' && unknown.extra === 3, `an unknown kind survives the registry untouched (${JSON.stringify(unknown)})`);
	h.check(!unknown.rendered, 'and is skipped at render, never deleted');

	await h.finish(browser);
});
