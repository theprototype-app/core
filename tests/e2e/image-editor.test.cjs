// 40-image (roadmap 40 F13) — IMAGES: a big one becomes a texture, and the Image editor.
//
// The user's report (image-large.jpg): a phone photo picked as a texture was REFUSED with
// "Image is too large (max 8 MB)" although the texture path shrinks every image to 1024 px.
// And the ask: an Image editor (the UV window's canvas + a right sidebar) with crop,
// rotate/flip, resize, brightness/contrast/saturation, Save, Save as copy, per-image
// version history with Restore original — and textures made from an image follow its saves.
//
//   §1  a 14 MB photo through the Inspector's real file input becomes a 1024 px texture, on both peers
//   §2  a library image textures a box and the box REMEMBERS it (mapSource, both peers)
//   §3  the preview window's Edit button opens the editor on that image
//   §4  rotate + the editor's own undo/redo (Ctrl+Z) never touch the scene's undo
//   §5  a crop drawn with the real mouse, applied with Enter
//   §6  brightness + Save: the same record, a version kept, the linked texture updated on BOTH
//       peers, and the texture picked from disk (no link) left alone
//   §7  Versions ▸ Restore original
//   §8  Save as copy leaves the original and its texture alone
//   §9  the Inspector's Edit on an unlinked texture puts it in the library and links it
//   §10 closing with unsaved edits asks first
//   §11 phone: the editor is a sheet that leaves Play uncovered, and a TOUCH drag crops
//
// Run: APP_URL='https://localhost:5395/' npm run e2e -- image-editor
const h = require('./helpers.cjs');
const zlib = require('zlib');

/** a W x H PNG of random noise — incompressible, so it really is big */
function noisePng(w, hh) {
	const row = w * 3 + 1;
	const raw = Buffer.alloc(row * hh);
	for (let y = 0; y < hh; y++) {
		raw[y * row] = 0;
		require('crypto').randomFillSync(raw, y * row + 1, w * 3);
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(hh, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** wait until `fn` resolves truthy (or the time runs out) — the checks after it decide */
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

/** run in the page with the debug stores */
const S = (p, fn, arg) => p.page.evaluate(fn, arg);

/** the width x height of a dataURL / blob url image, decoded in the page */
const dims = (p, url) =>
	S(
		p,
		(u) =>
			new Promise((res) => {
				const im = new Image();
				im.onload = () => res([im.naturalWidth, im.naturalHeight]);
				im.onerror = () => res([0, 0]);
				im.src = u;
			}),
		url
	);

/** a box's slot-0 texture facts @param {any} p @param {string} uuid */
const texOf = (p, uuid) =>
	S(
		p,
		async (id) => {
			const s = window.__stores;
			const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
			const m = g.getObjectByProperty('uuid', id)?.material;
			return { url: m?.userData?.mapDataUrl ?? null, source: m?.userData?.mapSource ?? null, hasMap: !!m?.map };
		},
		uuid
	);

const itemOf = (p, id) => S(p, (i) => {
	const it = window.__stores.explorer.itemById(i);
	return it && { id: it.id, name: it.name, hash: it.hash, folderId: it.folderId ?? null };
}, id);

const sizeText = (p) => p.page.locator('#image-editor-size').textContent();

/** the first pixel of a library item's bytes */
const firstPixel = (p, id) =>
	S(
		p,
		async (i) => {
			const blob = await window.__stores.explorer.itemBlob(i);
			const bmp = await createImageBitmap(blob);
			const c = document.createElement('canvas');
			c.width = bmp.width;
			c.height = bmp.height;
			const ctx = c.getContext('2d');
			ctx.drawImage(bmp, 0, 0);
			return { w: bmp.width, h: bmp.height, px: Array.from(ctx.getImageData(0, 0, 1, 1).data) };
		},
		id
	);

/** image px -> page px, from the canvas and the editor's own fit rule (24 px margin, centred) */
async function imageToPage(p, ix, iy, w, hh) {
	const box = await p.page.locator('#image-editor-canvas-wrap').boundingBox();
	const scale = Math.min((box.width - 24) / w, (box.height - 24) / hh);
	const ox = box.x + (box.width - w * scale) / 2;
	const oy = box.y + (box.height - hh * scale) / 2;
	return { x: ox + ix * scale, y: oy + iy * scale };
}

h.run(async () => {
	// the GPU backend: on software GL two pages plus a 14 MB photo starve the compositor (round trips ~1 s, measured)
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await S(A, () => window.__stores.explorer.loadExplorer());
	await h.connect(B, A);
	await A.page.waitForTimeout(1500);

	// two boxes, created on A and replicated to B
	await S(A, () => {
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
	});
	await A.page.waitForTimeout(900);
	const [box1, box2] = await S(A, async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const boxes = g.children.slice(-2);
		boxes[1].position.set(2, 0, 0);
		return boxes.map((b) => b.uuid);
	});
	await until(async () => !!(await texOf(B, box2)).hasMap || (await S(B, async (id) => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return !!g.getObjectByProperty('uuid', id);
	}, box2)), 8000);

	// ---- §1 the big photo -------------------------------------------------------------
	const big = noisePng(2400, 2000);
	h.check(big.length > 8 * 1024 * 1024, `PREMISE: the photo is over the old 8 MB cap (${(big.length / 1048576).toFixed(1)} MB)`);
	await S(A, (id) => window.__stores.objectActions.selectObject(id, true), box1);
	await A.page.waitForTimeout(700);
	await A.page.locator('#texture-file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: big });
	await until(async () => !!(await texOf(A, box1)).url, 20000);
	const t1 = await texOf(A, box1);
	const toasts = await S(A, () => document.body.innerText);
	h.check(!/too large/i.test(toasts), 'no "too large" refusal');
	h.check(!!t1.url && t1.hasMap, 'the photo became the texture');
	const d1 = await dims(A, t1.url);
	h.check(d1[0] === 1024 && d1[1] === 853, `it was shrunk to fit 1024 px, aspect kept (${d1.join('×')})`);
	h.check(!t1.source, 'a file picked from disk carries no library link');
	await until(async () => !!(await texOf(B, box1)).url, 10000);
	h.check(!!(await texOf(B, box1)).url, 'the peer received the texture too');

	// ---- §2 a library image textures box2, and the box remembers it ------------------
	const quad = await S(A, async () => {
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 48;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#c03030'; ctx.fillRect(0, 0, 32, 24);
		ctx.fillStyle = '#30c030'; ctx.fillRect(32, 0, 32, 24);
		ctx.fillStyle = '#3030c0'; ctx.fillRect(0, 24, 32, 24);
		ctx.fillStyle = '#c0c030'; ctx.fillRect(32, 24, 32, 24);
		const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
		const rec = await window.__stores.explorer.addItemFromBytes(await blob.arrayBuffer(), 'quad.png', null, { imported: true });
		return { id: rec.id, hash: rec.hash };
	});
	await S(A, ({ uuid, id }) => window.__stores.explorerDrop.applyExplorerImage(uuid, { id }), { uuid: box2, id: quad.id });
	await until(async () => (await texOf(A, box2)).source === quad.hash, 8000);
	h.check((await texOf(A, box2)).source === quad.hash, 'the textured box remembers which library image it shows');
	await until(async () => (await texOf(B, box2)).source === quad.hash, 10000);
	h.check((await texOf(B, box2)).source === quad.hash, 'so does the peer (the link rides the map message)');
	const before2 = await texOf(B, box2);

	// ---- §3 the preview window's Edit button opens the editor ------------------------
	await S(A, () => {
		window.__stores.inspectorClose.set(true);
		window.__stores.objectActions.deselectObject?.();
	});
	await A.page.waitForTimeout(400);
	await S(A, async (id) => {
		const s = window.__stores;
		const blob = await s.explorer.itemBlob(id);
		s.fileWindows.openFilePreview({ title: 'quad.png', kind: 'image', itemId: id, name: 'quad.png', url: URL.createObjectURL(blob) });
	}, quad.id);
	await A.page.locator('#preview-edit').waitFor({ timeout: 8000 });
	await A.page.locator('#preview-edit').click({ timeout: 30000 });
	await A.page.locator('#image-editor-window').waitFor({ timeout: 15000 }).catch(async () => {
		console.log('  errors: ' + JSON.stringify(h.pageErrors(A).slice(-4)));
		console.log('  console: ' + JSON.stringify(A.page.__console.filter((m) => m.type === 'error' || m.type === 'warning').slice(-8)));
		console.log('  target: ' + JSON.stringify(await S(A, () => new Promise((r) => window.__stores.imageEditor.imageEditorTarget.subscribe(r)()))));
		throw new Error('the editor window did not appear');
	});
	await until(async () => /64 × 48/.test((await sizeText(A)) ?? ''), 8000);
	h.check(/64 × 48/.test((await sizeText(A)) ?? ''), `the editor opened on the image (${await sizeText(A)})`);
	await S(A, () => window.__stores.fileWindows.previewWindows.set([]));
	// the editor draws the picture (a canvas that stayed blank would read all-zero)
	const drawn = await S(A, () => {
		const c = document.querySelector('#image-editor-canvas');
		const ctx = c.getContext('2d');
		const d = ctx.getImageData(Math.floor(c.width / 4), Math.floor(c.height / 2), 1, 1).data;
		return d[3];
	});
	h.check(drawn > 0, 'the canvas shows the image');

	// ---- §4 rotate + the editor's own undo ---------------------------------------------
	const sceneUndo = () => S(A, () => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));
	const undoBefore = await sceneUndo();
	await A.page.locator('#image-editor-rotate-cw').click();
	h.check(/48 × 64/.test((await sizeText(A)) ?? ''), 'rotate turns 64×48 into 48×64');
	await A.page.locator('#image-editor-canvas-wrap').click({ position: { x: 5, y: 5 } });
	await A.page.keyboard.press('Control+z');
	h.check(/64 × 48/.test((await sizeText(A)) ?? ''), 'Ctrl+Z undoes it inside the editor');
	await A.page.keyboard.press('Control+Shift+z');
	h.check(/48 × 64/.test((await sizeText(A)) ?? ''), 'Ctrl+Shift+Z redoes it');
	await A.page.keyboard.press('Control+z');
	h.check((await sceneUndo()) === undoBefore, `the scene's undo stack is untouched (${undoBefore} → ${await sceneUndo()})`);
	h.check(!!(await texOf(A, box2)).hasMap, 'and the scene is untouched — no box lost its texture');

	// ---- §5 crop with the real mouse --------------------------------------------------
	await A.page.locator('#image-editor-crop').click();
	const p0 = await imageToPage(A, 8, 8, 64, 48);
	const p1 = await imageToPage(A, 40, 32, 64, 48);
	// a press OUTSIDE the default full-image box starts a new one, so start just off the image first
	await A.page.mouse.move(p0.x, p0.y);
	await A.page.mouse.down();
	await A.page.mouse.move((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, { steps: 4 });
	await A.page.mouse.move(p1.x, p1.y, { steps: 4 });
	await A.page.mouse.up();
	const cropText = await A.page.locator('#image-editor-crop-badge').textContent();
	h.check(/Crop \d+ × \d+/.test(cropText ?? ''), `a crop box is showing (${cropText})`);
	await A.page.keyboard.press('Enter');
	const afterCrop = (await sizeText(A)) ?? '';
	const [cw, ch] = (afterCrop.match(/(\d+) × (\d+)/) ?? []).slice(1).map(Number);
	h.check(Math.abs(cw - 32) <= 1 && Math.abs(ch - 24) <= 1, `Enter applied the dragged crop (${afterCrop})`);

	// ---- §6 brightness + Save -----------------------------------------------------------
	const bright = A.page.locator('#image-editor-brightness');
	await bright.click();
	await bright.fill('40');
	await bright.press('Enter');
	await A.page.waitForTimeout(300);
	const box1Before = await texOf(A, box1);
	await A.page.locator('#image-editor-save').click();
	await until(async () => (await itemOf(A, quad.id))?.hash !== quad.hash, 20000);
	const saved = await itemOf(A, quad.id);
	h.check(saved && saved.hash !== quad.hash, 'Save replaced the bytes');
	h.check(saved?.id === quad.id && saved?.name === 'quad.png', 'in the SAME library record (id and name kept)');
	const px = await firstPixel(A, quad.id);
	h.check(Math.abs(px.w - 32) <= 1 && Math.abs(px.h - 24) <= 1, `the saved file is the cropped size (${px.w}×${px.h})`);
	h.check(px.px[0] > 0xc0 + 40 && px.px[1] > 0x30 + 40, `the saved pixel is the red quadrant brightened (${px.px.slice(0, 3)})`);
	const versions = await S(A, (id) => window.__stores.imageVersions.listImageVersions(id), quad.id);
	h.check(versions.length === 2 && versions[0].label === 'Original' && versions[0].hash === quad.hash, `two versions, the first is the Original (${versions.map((v) => v.label)})`);
	await until(async () => (await texOf(A, box2)).source === saved.hash, 8000);
	const a2 = await texOf(A, box2);
	h.check(a2.source === saved.hash, 'the linked box now names the new bytes');
	h.check(JSON.stringify(await dims(A, a2.url)) === JSON.stringify([px.w, px.h]), 'and shows them (its texture is the cropped image)');
	await until(async () => (await texOf(B, box2)).source === saved.hash, 10000);
	const b2 = await texOf(B, box2);
	h.check(b2.source === saved.hash && b2.url !== before2.url, 'the PEER\'s box updated too');
	h.check((await texOf(A, box1)).url === box1Before.url, 'the texture picked from disk (no link) was left alone');

	// ---- §7 Restore original ------------------------------------------------------------
	await A.page.locator('[data-ws-mode="history"]').click();
	await A.page.locator('#image-editor-restore-original').click();
	await until(async () => (await itemOf(A, quad.id))?.hash === quad.hash, 20000);
	h.check((await itemOf(A, quad.id))?.hash === quad.hash, 'Restore original put the original bytes back');
	await until(async () => /64 × 48/.test((await sizeText(A)) ?? ''), 6000);
	h.check(/64 × 48/.test((await sizeText(A)) ?? ''), 'the editor reloaded the original');
	await until(async () => (await texOf(B, box2)).source === quad.hash, 10000);
	h.check((await texOf(B, box2)).source === quad.hash, 'and the peer\'s texture went back with it');
	const v2 = await S(A, (id) => window.__stores.imageVersions.listImageVersions(id), quad.id);
	h.check(v2.length === 2, `restoring adds no duplicate version (${v2.length})`);
	const current = await A.page.locator('.ie-version-current .ie-version-label').textContent();
	h.check(/Original/.test(current ?? ''), `the Original row is marked current ("${current}")`);
	await A.page.locator('[data-ws-mode="edit"]').click();

	// ---- §8 Save as copy ---------------------------------------------------------------
	await A.page.locator('#image-editor-flip-h').click();
	await A.page.locator('#image-editor-save-copy').click();
	await until(async () => !!(await S(A, () => window.__stores.explorer.allItems().find((i) => i.name === 'quad copy.png'))), 8000);
	const copy = await S(A, () => {
		const it = window.__stores.explorer.allItems().find((i) => i.name === 'quad copy.png');
		return it && { id: it.id, hash: it.hash };
	});
	h.check(!!copy && copy.id !== quad.id, 'Save as copy made "quad copy.png" beside it');
	h.check((await itemOf(A, quad.id))?.hash === quad.hash, 'the original image is unchanged');
	h.check((await texOf(A, box2)).source === quad.hash, 'and so is the texture made from it');
	const title = await A.page.locator('#image-editor-window .ie-title').textContent();
	h.check(/quad copy\.png/.test(title ?? ''), `the editor carries on with the copy ("${title?.trim()}")`);

	// ---- §9 the Inspector's Edit on an unlinked texture --------------------------------
	await S(A, () => window.__stores.imageEditor.closeImageEditor());
	await S(A, (id) => window.__stores.objectActions.selectObject(id, true), box1);
	await A.page.waitForTimeout(600);
	await A.page.locator('#texture-edit').click();
	await A.page.locator('#image-editor-window').waitFor({ timeout: 8000 }).catch(async () => {
		console.log('  console after Edit: ' + JSON.stringify(A.page.__console.filter((m) => m.type === 'error' || m.type === 'warning').slice(-6)));
		console.log('  toasts: ' + (await S(A, () => document.querySelector('.toasts-stack')?.textContent?.slice(0, 300))));
	});
	const linked = await texOf(A, box1);
	const made = await S(A, (hash) => {
		const it = window.__stores.explorer.itemByHash(hash);
		return it && { name: it.name, kind: it.kind };
	}, linked.source);
	h.check(!!linked.source && made?.kind === 'image', `the texture went into the library and is linked (${made?.name})`);
	await until(async () => /1024 × 853/.test((await sizeText(A)) ?? ''), 8000);
	h.check(/1024 × 853/.test((await sizeText(A)) ?? ''), 'and the editor opened on it');
	await until(async () => (await texOf(B, box1)).source === linked.source, 10000);
	h.check((await texOf(B, box1)).source === linked.source, 'the peer learned the link');

	// ---- §10 closing with unsaved edits asks first --------------------------------------
	await A.page.locator('#image-editor-rotate-cw').click();
	await A.page.locator('#image-editor-close').click();
	await A.page.locator('#confirm-dialog-close').waitFor({ timeout: 5000 });
	await A.page.locator('#confirm-dialog-cancel').click();
	h.check(await A.page.locator('#image-editor-window').isVisible(), '"Keep editing" keeps the window and the edit');
	await A.page.locator('#image-editor-close').click();
	await A.page.locator('#confirm-dialog-close').click();
	await until(async () => !(await A.page.locator('#image-editor-window').count()), 4000);
	h.check(!(await A.page.locator('#image-editor-window').count()), '"Discard and close" closes it');

	// ---- §12 the storage breakdown names the version history and can reclaim it -------
	const scan = await S(A, async (id) => {
		const su = window.__stores.storageUsage;
		const r = await su.scanStorage();
		const cat = r.categories.find((c) => c.key === 'imageversions');
		const row = cat?.rows.find((x) => x.ref === id);
		const other = r.categories.find((c) => c.key === 'other')?.rows.some((x) => String(x.ref).startsWith('imgver:'));
		let after = -1;
		if (row) {
			await su.reclaimRow(row);
			after = (await window.__stores.imageVersions.listImageVersions(id)).length;
		}
		return { label: row?.label, bytes: row?.bytes ?? 0, other: !!other, after, image: !!window.__stores.explorer.itemById(id) };
	}, quad.id);
	h.check(scan.label === 'quad.png' && scan.bytes > 0, `Storage lists quad.png's versions as "Image versions" (${scan.label}, ${scan.bytes} B)`);
	h.check(!scan.other, 'and none of their keys fall into "Other"');
	h.check(scan.after === 0 && scan.image, 'reclaiming them forgets the history and keeps the image');

	// ---- §11 phone: a sheet that leaves Play free, and a touch crop ----------------------
	const P = await h.setupPage(browser, 'P', { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
	const pq = await S(P, async () => {
		const c = document.createElement('canvas');
		c.width = 80;
		c.height = 60;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#3070d0';
		ctx.fillRect(0, 0, 80, 60);
		const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
		const rec = await window.__stores.explorer.addItemFromBytes(await blob.arrayBuffer(), 'phone.png', null, {});
		window.__stores.imageEditor.openImageEditor(rec.id);
		return rec.id;
	});
	await P.page.locator('#image-editor-window').waitFor({ timeout: 8000 });
	await until(async () => /80 × 60/.test((await sizeText(P)) ?? ''), 8000);
	// toasts (the quality governor's, on a phone) sit over the sheet's top; they are not under test
	await S(P, () => document.querySelectorAll('.toasts-stack .tp-toast-x').forEach((b) => b.click()));
	await P.page.waitForTimeout(300);
	const win = await P.page.locator('#image-editor-window').boundingBox();
	h.check(win && win.x <= 1 && win.width >= 388, `on a phone the editor is full width (${win?.x}, ${win?.width})`);
	// the phone shell's Play lives in its bottom bar (#ps-play); the desktop pill is hidden there
	const playSel = (await S(P, () => document.documentElement.classList.contains('phone-shell'))) ? '#ps-play' : '#play-button';
	const play = await P.page.locator(playSel).boundingBox();
	h.check(!!play && win.y + win.height <= play.y + 1, `it ends above Play (sheet bottom ${Math.round(win.y + win.height)}, ${playSel} top ${Math.round(play?.y ?? -1)})`);
	const hitPlay = await S(P, (sel) => {
		const b = document.querySelector(sel).getBoundingClientRect();
		return !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest(sel);
	}, playSel);
	h.check(hitPlay, 'Play is still the thing under a tap');
	const head = await S(P, () => {
		const b = document.querySelector('#image-editor-close').getBoundingClientRect();
		return !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('#image-editor-close');
	});
	h.check(head, 'the top bar does not cover the editor\'s close button');
	const stack = await S(P, () => {
		const c = document.querySelector('#image-editor-canvas-wrap').getBoundingClientRect();
		const p = document.querySelector('#image-editor-window .ws-panel-secondary').getBoundingClientRect();
		return { cw: Math.round(c.width), below: p.top >= c.bottom - 1, pw: Math.round(p.width) };
	});
	h.check(stack.cw >= 380 && stack.below && stack.pw >= 380, `the panel stacks under a full-width canvas (canvas ${stack.cw} px, panel ${stack.pw} px, below: ${stack.below})`);
	await P.page.locator('#image-editor-crop').tap();
	const q0 = await imageToPage(P, 10, 10, 80, 60);
	const q1 = await imageToPage(P, 50, 40, 80, 60);
	const cdp = await P.ctx.newCDPSession(P.page);
	const touch = (type, pt) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pt ? [{ x: pt.x, y: pt.y, id: 1 }] : [] });
	await touch('touchStart', q0);
	for (let i = 1; i <= 6; i++) await touch('touchMove', { x: q0.x + ((q1.x - q0.x) * i) / 6, y: q0.y + ((q1.y - q0.y) * i) / 6 });
	await touch('touchEnd');
	await P.page.waitForTimeout(200);
	await P.page.locator('#image-editor-crop-apply').tap();
	const phoneSize = (await sizeText(P)) ?? '';
	const [pw, ph] = (phoneSize.match(/(\d+) × (\d+)/) ?? []).slice(1).map(Number);
	h.check(Math.abs(pw - 40) <= 1 && Math.abs(ph - 30) <= 1, `a touch drag cropped the image (${phoneSize})`);
	void pq;

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(P).length === 0, 'no page errors');
	await h.finish(browser);
});
