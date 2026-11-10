// uir-preview (owner 2026-11-09, "Windows, chat and tools") — PIN TO DOCK + VIEW | EDIT.
//
//   §1  Pin to dock: the preview docks as the Preview tab and is pinned
//   §2  single-clicking files in the Explorer: the pinned tab follows (image, text, image)
//   §3  ←/→ walk files in View
//   §4  View -> Edit on an image: the editor is IN the window, with the images filmstrip
//   §5  [ ] and Ctrl+arrows walk images in Edit; a text field keeps its brackets
//   §6  an unsaved edit asks before walking away; Save; back to View shows the saved picture
//   §7  floating: undocked it stays pinned and still follows; unpinned it stops following
//   §8  1280 with the Explorer DOCKED: Pin to dock splits the dock (Explorer | Preview), follows,
//       and the Edit face fits (filmstrip, canvas, Save, close all reachable)
//   §9  phone postures, emulated (the HONOR's cover screen 353x792 @3 folded, 770x850 unfolded): the
//       Edit face is a sheet whose header (View | Edit, close) and Save are reachable by a tap
//   dark + light shots of docked View / docked Edit / floating Edit for the owner
//
// Run: APP_URL='https://localhost:7008/' npm run e2e -- preview-pin-edit
const h = require('./helpers.cjs');

const S = (p, fn, arg) => p.page.evaluate(fn, arg);
async function until(fn, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}
const OUT = process.env.OUT || 'test-results/uir-preview';

/** the first preview window's state */
const pv = (p) =>
	S(p, () => {
		const w = document.getElementById('image-preview-window');
		let list;
		window.__stores.fileWindows.previewWindows.subscribe((x) => (list = x))();
		const t = list[0];
		return {
			open: !!w,
			hosted: w?.getAttribute('data-pd-host') ?? null,
			pinned: w?.dataset.previewPinned === 'true',
			mode: w?.dataset.previewMode ?? null,
			kind: t?.kind ?? null,
			itemId: t?.itemId ?? '',
			title: t?.title ?? '',
			place: document.getElementById('preview-place')?.textContent?.trim() ?? '',
			size: w?.querySelector('#image-editor-size')?.textContent ?? '',
			windows: list.length
		};
	});

/** seed: three images of different sizes, one text file — in the library root */
const seed = (p) =>
	S(p, async () => {
		const e = window.__stores.explorer;
		await e.loadExplorer?.();
		await e.clearLibrary();
		const png = async (w, hh, color) => {
			const c = document.createElement('canvas');
			c.width = w;
			c.height = hh;
			const ctx = c.getContext('2d');
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, w, hh);
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, 4, 4);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			return blob.arrayBuffer();
		};
		const a = await e.addItemFromBytes(await png(64, 48, '#c03030'), 'a-red.png', null);
		const b = await e.addItemFromBytes(await png(80, 60, '#30a040'), 'b-green.png', null);
		const n = await e.addItemFromBytes(new TextEncoder().encode('hello from the note\nline two').buffer, 'c-note.txt', null);
		const d = await e.addItemFromBytes(await png(40, 40, '#3050d0'), 'd-blue.png', null);
		return { a: a.id, b: b.id, n: n.id, d: d.id };
	});

async function shot(p, name, theme) {
	await S(p, (t) => {
		document.documentElement.dataset.theme = t;
		document.documentElement.classList.toggle('dark', t === 'dark');
	}, theme);
	await p.page.waitForTimeout(250);
	await p.page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
}

h.run(async () => {
	const browser = await h.launch();

	// ================= 1920 x 1080, the Explorer floating =================
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1920, height: 1080 } }, storage: { explorerDocked: 'false', 'preview:pinned': 'false' } });
	const page = A.page;
	const ids = await seed(A);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(1200);
	// park the Explorer top-left so the dock and a floating preview never cover its cards
	await S(A, () => {
		const ex = document.getElementById('explorer-window') ?? document.querySelector('[data-window-key="explorer"]');
		if (ex) Object.assign(ex.style, { left: '60px', top: '90px', width: '760px', height: '520px' });
	});
	await page.locator(`[data-card-id="${ids.a}"]`).waitFor({ timeout: 10000 });

	// ---- §1 Pin to dock ---------------------------------------------------------------
	await S(A, async (id) => {
		const s = window.__stores;
		const blob = await s.explorer.itemBlob(id);
		s.fileWindows.openFilePreview({ title: 'a-red.png', kind: 'image', itemId: id, name: 'a-red.png', url: URL.createObjectURL(blob) });
	}, ids.a);
	await page.locator('#preview-pin').waitFor({ timeout: 8000 });
	let st = await pv(A);
	h.check(st.open && !st.hosted && !st.pinned, `premise: a floating, unpinned preview (${JSON.stringify(st)})`);
	await page.locator('#preview-pin').click();
	await until(async () => (await pv(A)).hosted === 'shown');
	st = await pv(A);
	h.check(st.hosted === 'shown' && st.pinned, `§1 Pin to dock: docked as a tab, pinned (${JSON.stringify(st)})`);
	h.check(!!(await page.locator('[data-dock-tab="preview"]').count()), '§1 the dock strip has a Preview tab');
	await shot(A, '01-docked-view-1920', 'dark');

	// ---- §2 the pinned tab follows the Explorer selection -------------------------------
	await page.locator(`[data-card-id="${ids.n}"]`).click();
	await until(async () => (await pv(A)).kind === 'text');
	st = await pv(A);
	h.check(st.kind === 'text' && st.itemId === ids.n, `§2 a click on the text file: the Preview shows it (${JSON.stringify(st)})`);
	await until(async () => /hello from the note/.test((await page.locator('#preview-text').textContent()) ?? ''));
	h.check(/hello from the note/.test((await page.locator('#preview-text').textContent()) ?? ''), '§2 ...as read-only text');
	await page.locator(`[data-card-id="${ids.b}"]`).click();
	await until(async () => (await pv(A)).itemId === ids.b);
	st = await pv(A);
	h.check(st.kind === 'image' && st.itemId === ids.b, `§2 a click on another image: it follows (${JSON.stringify(st)})`);

	// ---- §3 ←/→ walk in View ----------------------------------------------------------
	await page.locator('#image-preview-window').focus();
	await page.keyboard.press('ArrowRight');
	await until(async () => (await pv(A)).itemId === ids.n);
	st = await pv(A);
	h.check(st.itemId === ids.n && st.place === '3/4', `§3 → walks to the next file, the text (${JSON.stringify(st)})`);
	await page.keyboard.press('ArrowLeft');
	await until(async () => (await pv(A)).itemId === ids.b);
	h.check((await pv(A)).itemId === ids.b, '§3 ← walks back');

	// ---- §4 View -> Edit -----------------------------------------------------------------
	await page.locator('#preview-edit').click();
	await until(async () => /80 × 60/.test((await pv(A)).size));
	st = await pv(A);
	h.check(st.mode === 'edit' && /80 × 60/.test(st.size) && st.hosted === 'shown', `§4 Edit: the editor opens IN the docked window (${JSON.stringify(st)})`);
	h.check(!(await page.locator('[id^="image-editor"][id$="dock"]').count()), '§4 no separate editor window or dock tab');
	const strip = await S(A, () => [...document.querySelectorAll('#image-editor-filmstrip [data-strip-id]')].map((b) => b.getAttribute('data-strip-id') + (b.getAttribute('aria-current') === 'true' ? '*' : '')));
	h.check(strip.length === 3 && strip.includes(ids.b + '*') && !strip.some((x) => x.startsWith(ids.n)), `§4 the filmstrip holds the folder's IMAGES, current one marked (${JSON.stringify(strip)})`);
	await shot(A, '02-docked-edit-1920', 'dark');

	// ---- §5 [ ] and Ctrl+arrows walk images in Edit -------------------------------------
	await page.locator('#image-editor-canvas-wrap').click({ position: { x: 6, y: 6 } });
	await page.keyboard.press(']');
	await until(async () => (await pv(A)).itemId === ids.d);
	st = await pv(A);
	h.check(st.itemId === ids.d && st.mode === 'edit' && st.place === '3/3', `§5 ] skips the text file to the next IMAGE, still in Edit (${JSON.stringify(st)})`);
	await until(async () => /40 × 40/.test((await pv(A)).size));
	await page.keyboard.press('Control+ArrowLeft');
	await until(async () => (await pv(A)).itemId === ids.b);
	h.check((await pv(A)).itemId === ids.b, '§5 Ctrl+← walks back');
	await page.keyboard.press('[');
	await until(async () => (await pv(A)).itemId === ids.a);
	h.check((await pv(A)).itemId === ids.a, '§5 [ walks back again');
	await until(async () => /64 × 48/.test((await pv(A)).size));
	// a text field keeps its brackets (the resize W field is a DragRow input)
	const field = page.locator('#image-editor-width input, input#image-editor-width').first();
	if (await field.count()) {
		await field.focus();
		await page.keyboard.press(']');
		await page.waitForTimeout(500);
		h.check((await pv(A)).itemId === ids.a, '§5 ] typed in a text field does not walk');
		await page.keyboard.press('Escape');
	} else h.check(false, '§5 premise: the resize W field is an input');
	// the filmstrip walks too
	await page.locator(`#image-editor-filmstrip [data-strip-id="${ids.b}"]`).click();
	await until(async () => (await pv(A)).itemId === ids.b);
	h.check((await pv(A)).itemId === ids.b, '§5 a filmstrip frame opens that image');

	// ---- §6 unsaved edits ask; Save; back to View ----------------------------------------
	await until(async () => /80 × 60/.test((await pv(A)).size));
	await page.locator('#image-editor-rotate-cw').click();
	await until(async () => /60 × 80/.test((await pv(A)).size));
	await page.locator('#image-editor-canvas-wrap').click({ position: { x: 6, y: 6 } });
	await page.keyboard.press(']');
	await page.locator('#confirm-dialog-cancel').waitFor({ timeout: 5000 });
	await page.locator('#confirm-dialog-cancel').click();
	await until(async () => !(await page.locator('#confirm-dialog-cancel').count()), 4000);
	await page.waitForTimeout(400);
	const dialogs = () => S(A, () => [...document.querySelectorAll('dialog[open]')].map((d) => d.textContent.trim().slice(0, 80)));
	h.check((await dialogs()).length === 0, `§6 "Keep editing" leaves no dialog behind (${JSON.stringify(await dialogs())})`);
	st = await pv(A);
	h.check(st.itemId === ids.b && /60 × 80/.test(st.size), `§6 walking away from an unsaved edit asks; "Keep editing" stays (${JSON.stringify(st)})`);
	const hashBefore = await S(A, (id) => window.__stores.explorer.itemById(id)?.hash, ids.b);
	const saveState = await S(A, () => ({ disabled: document.querySelector('#image-editor-save')?.disabled, dirty: document.querySelector('#image-editor-window')?.dataset.dirty ?? null }));
	await page.locator('#image-editor-save').click();
	await until(async () => (await S(A, (id) => window.__stores.explorer.itemById(id)?.hash, ids.b)) !== hashBefore, 8000);
	console.log('  save diag: ' + JSON.stringify({ saveState, dialogs: await dialogs(), toasts: await S(A, () => document.querySelector('.toasts-stack')?.textContent?.slice(0, 200)) }));
	h.check((await S(A, (id) => window.__stores.explorer.itemById(id)?.hash, ids.b)) !== hashBefore, '§6 Save writes the image');
	await page.locator('#preview-view').click();
	await until(async () => (await pv(A)).mode === 'view');
	const dims = async () =>
		S(A, () => {
			const im = document.querySelector('#image-preview-window #preview-body img');
			return im && im.complete ? [im.naturalWidth, im.naturalHeight] : null;
		});
	await until(async () => JSON.stringify(await dims()) === '[60,80]', 8000);
	h.check(JSON.stringify(await dims()) === '[60,80]', `§6 back in View, the window shows the SAVED picture (${JSON.stringify(await dims())})`);

	// ---- §7 floating: still pinned, still follows; unpinned it stops ----------------------
	await S(A, () => window.__stores.bottomDock.activateDock('preview'));
	await page.waitForTimeout(300);
	await S(A, () => document.getElementById('dock-undock').click());
	await until(async () => !(await pv(A)).hosted);
	await S(A, () => Object.assign(document.getElementById('image-preview-window').style, { left: '1100px', top: '120px' }));
	st = await pv(A);
	h.check(st.open && !st.hosted && st.pinned, `§7 undocked: floating, still pinned (${JSON.stringify(st)})`);
	await page.locator(`[data-card-id="${ids.d}"]`).click();
	await until(async () => (await pv(A)).itemId === ids.d);
	h.check((await pv(A)).itemId === ids.d, '§7 the floating pinned preview follows the Explorer');
	await page.locator('#preview-edit').click();
	await until(async () => /40 × 40/.test((await pv(A)).size));
	await shot(A, '03-floating-edit-1920', 'dark');
	await shot(A, '03-floating-edit-1920', 'light');
	await page.locator('#preview-view').click();
	await page.locator('#preview-pin').click();
	await page.waitForTimeout(300);
	h.check(!(await pv(A)).pinned, '§7 unpin');
	await page.locator(`[data-card-id="${ids.a}"]`).click();
	await page.waitForTimeout(900);
	h.check((await pv(A)).itemId === ids.d, '§7 unpinned, a selection no longer moves it');
	h.check((h.pageErrors(A) || []).length === 0, `no page errors at 1920 (${(h.pageErrors(A) || []).slice(-3).join(' | ')})`);
	await A.ctx.close();

	// ================= 1280 x 800, the Explorer DOCKED =================
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } }, storage: { explorerDocked: 'true', 'preview:pinned': 'false', previewDocked: 'false' } });
	const pb = B.page;
	const idsB = await seed(B);
	await pb.locator('#explorer-slot').click();
	await pb.waitForTimeout(1200);
	await S(B, () => window.__stores.bottomDock.activateDock('explorer'));
	await pb.locator(`[data-card-id="${idsB.a}"]`).waitFor({ timeout: 10000 });
	await pb.locator(`[data-card-id="${idsB.a}"]`).click();
	await S(B, () => window.__stores.fileWindows.openFilePreview({ title: 'Preview', kind: 'empty', url: '' }));
	await pb.locator('#preview-pin').click();
	await until(async () => (await pv(B)).hosted === 'shown');
	const split = await S(B, () => {
		let v;
		window.__stores.bottomDock.dockShownKeys.subscribe((x) => (v = x))();
		return v;
	});
	st = await pv(B);
	h.check(split.includes('explorer') && split.includes('preview'), `§8 Pin to dock beside the docked Explorer SPLITS the dock (${JSON.stringify(split)})`);
	h.check(st.itemId === idsB.a, `§8 ...and the Preview picks up the selection (${JSON.stringify(st)})`);
	await pb.locator(`[data-card-id="${idsB.b}"]`).click();
	await until(async () => (await pv(B)).itemId === idsB.b);
	h.check((await pv(B)).itemId === idsB.b, '§8 a click in the docked Explorer: the Preview beside it follows');
	await shot(B, '04-split-view-1280', 'dark');
	await shot(B, '04-split-view-1280', 'light');
	await pb.locator('#preview-edit').click();
	await until(async () => /80 × 60/.test((await pv(B)).size));
	const reach = await S(B, () => {
		const hit = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return 'missing';
			const b = el.getBoundingClientRect();
			if (!b.width || !b.height) return 'zero';
			return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest(sel) ? 'ok' : 'covered';
		};
		return { save: hit('#image-editor-save'), close: hit('#preview-close'), view: hit('#preview-view'), canvas: hit('#image-editor-canvas-wrap') };
	});
	h.check(Object.values(reach).every((v) => v === 'ok'), `§8 the Edit face fits at 1280 docked: Save, View, close and the canvas are reachable (${JSON.stringify(reach)})`);
	await shot(B, '05-split-edit-1280', 'dark');
	await shot(B, '05-split-edit-1280', 'light');
	h.check((h.pageErrors(B) || []).length === 0, `no page errors at 1280 (${(h.pageErrors(B) || []).slice(-3).join(' | ')})`);
	await B.ctx.close();

	// ================= §9 phone postures (emulated; the real HONOR is owed to the union preview) =====
	for (const [w, hh, dpr, label] of [[353, 792, 3, 'folded'], [770, 850, 2, 'unfolded']]) {
		const P = await h.setupPage(browser, 'P-' + label, { context: { viewport: { width: w, height: hh }, hasTouch: true, isMobile: true, deviceScaleFactor: dpr } });
		const idsP = await seed(P);
		await S(P, (id) => window.__stores.imageEditor.openImageEditor(id), idsP.b);
		await until(async () => /80 × 60/.test((await pv(P)).size), 10000);
		await S(P, () => document.querySelectorAll('.toasts-stack .tp-toast-x').forEach((b) => b.click()));
		await P.page.waitForTimeout(400);
		const r = await S(P, () => {
			const hit = (sel) => {
				const el = document.querySelector(sel);
				if (!el) return 'missing';
				const b = el.getBoundingClientRect();
				if (!b.width || !b.height) return 'zero';
				if (b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.left < -1) return 'off-screen';
				return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest(sel) ? 'ok' : 'covered';
			};
			const win = document.getElementById('image-preview-window').getBoundingClientRect();
			return {
				view: hit('#preview-view'),
				close: hit('#preview-close'),
				save: hit('#image-editor-save'),
				canvas: hit('#image-editor-canvas-wrap'),
				winW: Math.round(win.width),
				strip: !!document.querySelector('#image-editor-filmstrip')?.offsetParent,
				// the filmstrip may start collapsed on a phone (WindowShell's phone rule): its edge toggle
				stripToggle: hit('#image-editor-window [data-ws-primary-toggle]')
			};
		});
		h.check(['view', 'close', 'save', 'canvas'].every((k) => r[k] === 'ok'), `§9 ${label}: the Edit face's controls are tappable (${JSON.stringify(r)})`);
		if (label === 'folded') h.check(r.winW >= w - 2 && !r.strip, `§9 folded: the editor is a full-width sheet, filmstrip stood down (${JSON.stringify(r)})`);
		else h.check(r.strip || r.stripToggle === 'ok', `§9 unfolded: the filmstrip shows or its toggle is tappable (${JSON.stringify(r)})`);
		await shot(P, `06-phone-${label}-edit`, 'dark');
		await P.page.locator('#preview-view').tap();
		await until(async () => (await pv(P)).mode === 'view');
		h.check((await pv(P)).mode === 'view', `§9 ${label}: a tap on View goes back to the picture`);
		h.check((h.pageErrors(P) || []).length === 0, `no page errors (${label}) (${(h.pageErrors(P) || []).slice(-3).join(' | ')})`);
		await P.ctx.close();
	}
	await h.finish(browser);
});
