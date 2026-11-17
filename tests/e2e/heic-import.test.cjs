// 46-media H1 — HEIC/HEIF photos import as textures and Explorer items. A HEIC (the committed
// 96x64 fixture: red / green / blue / yellow quadrants) dropped on the Explorer becomes a JPEG
// Library item with a thumbnail, previews, textures a box on BOTH peers, shares to the peer as the
// decoded bytes — and the decoder (libheif's loader + wasm) is fetched ONLY by the page that
// decodes a HEIC, only once one arrives. A HEIC picked straight into a texture slot is decoded too,
// and a broken one is refused with a reason instead of a silent nothing.
//
// Counterfactual: on the 1.35.0 base the drop toasts "Unsupported: quadrants.heic" and no item lands.
// Run: APP_URL=https://theprototype.app:5463/ npm run e2e -- heic-import
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const HEIC = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'heic', 'quadrants.heic'));
/** the colour of each quadrant, as authored (HEVC is lossy: compare with a tolerance) */
const QUADRANTS = { tl: [220, 30, 30], tr: [30, 200, 40], bl: [30, 60, 220], br: [240, 210, 30] };
const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR4nGP8z8Dwn4EIwESMolGF+BUyMjAwMDIQBMQrJKgUvzt/EnIhAJTfBhFVsHRAAAAAAElFTkSuQmCC';
const DECODER = /libheif|heicDecode|heic\.worker/i;

const itemsOf = (p) =>
	p.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__tp.test.v1.explorer.explorerItems.subscribe((items) =>
					resolve(items.map((i) => ({ id: i.id, name: i.name, kind: i.kind, hash: i.hash, thumb: !!i.thumbnail, size: i.size })))
				)();
			})
	);

/** sample the four quadrant centres of an image source in the page (a blob of the item, or a data URL) */
const QUAD_SAMPLER = async (src) => {
	const blob = src.dataUrl ? await (await fetch(src.dataUrl)).blob() : await window.__tp.test.v1.explorer.itemBlob(src.id);
	const bmp = await createImageBitmap(blob);
	const c = document.createElement('canvas');
	c.width = bmp.width;
	c.height = bmp.height;
	const ctx = c.getContext('2d');
	ctx.drawImage(bmp, 0, 0);
	const at = (fx, fy) => Array.from(ctx.getImageData(Math.floor(bmp.width * fx), Math.floor(bmp.height * fy), 1, 1).data).slice(0, 3);
	return { w: bmp.width, h: bmp.height, type: blob.type, tl: at(0.25, 0.25), tr: at(0.75, 0.25), bl: at(0.25, 0.75), br: at(0.75, 0.75) };
};
/** poll until `predicate(value)`; PASS/FAIL like the helper's eventually, and RETURN the last value */
async function until(fn, predicate, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last)?.slice(0, 300));
	h.check(false, label);
	return last;
}
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const quadrantsMatch = (q) => Object.entries(QUADRANTS).every(([k, rgb]) => near(q[k], rgb));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	/** every request either page makes for the decoder */
	const asked = { A: [], B: [] };
	A.page.on('request', (r) => DECODER.test(r.url()) && asked.A.push(r.url()));
	B.page.on('request', (r) => DECODER.test(r.url()) && asked.B.push(r.url()));
	await h.connect(B, A, 8000);

	// 1. an ordinary image never touches the decoder
	await A.page.locator('#explorer-slot').click();
	await until(() => A.page.locator('#explorer-list').isVisible(), (v) => v, 'the Explorer opens');
	await A.page.evaluate((png) => {
		const dt = new DataTransfer();
		dt.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'tiny.png', { type: 'image/png' }));
		document.querySelector('#explorer-list').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, TINY_PNG);
	await until(() => itemsOf(A), (l) => l.some((i) => i.name === 'tiny.png'), 'a PNG imports');
	await A.page.waitForTimeout(800);
	const idle = await A.page.evaluate(() => (window.__tp.test.v1.heic?.heicDebug?.() ?? { workerStarted: false, decodes: 0, lastMs: 0 }));
	h.check(!idle.workerStarted && asked.A.length === 0, `a PNG import loads NO decoder (worker ${idle.workerStarted}, requests ${asked.A.length})`);

	// 2. the HEIC, dropped the way a browser hands one over: no MIME type at all
	await A.page.evaluate((bytes) => {
		const dt = new DataTransfer();
		dt.items.add(new File([new Uint8Array(bytes)], 'quadrants.heic', { type: '' }));
		document.querySelector('#explorer-list').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, Array.from(HEIC));
	const items = await until(() => itemsOf(A), (l) => l.some((i) => i.name === 'quadrants.jpg' && i.thumb), 'the HEIC lands in the Library as quadrants.jpg with a thumbnail', 30000);
	const photo = items?.find((i) => i.name === 'quadrants.jpg');
	h.check(!!photo && photo.kind === 'image' && photo.hash?.length === 64, `it is an image item with a content hash (${photo?.kind}, ${photo?.hash?.length})`);
	h.check(!items?.some((i) => /\.heic$/i.test(i.name)), 'no .heic item is kept (the Library holds the decoded photo)');
	const after = await A.page.evaluate(() => (window.__tp.test.v1.heic?.heicDebug?.() ?? { workerStarted: false, decodes: 0, lastMs: 0 }));
	h.check(after.workerStarted && after.decodes === 1, `the decoder ran once (decodes ${after.decodes}, ${after.lastMs} ms)`);
	h.check(asked.A.some((u) => /libheif.*\.wasm/i.test(u)), `the libheif wasm was fetched only now (${asked.A.length} decoder requests)`);
	const q = await A.page.evaluate(QUAD_SAMPLER, { id: photo.id });
	h.check(q.type === 'image/jpeg' && q.w === 96 && q.h === 64, `the stored bytes are a 96x64 JPEG (${q.type} ${q.w}x${q.h})`);
	h.check(quadrantsMatch(q), `the decoded pixels are the photo (tl ${q.tl} tr ${q.tr} bl ${q.bl} br ${q.br})`);

	// 3. it previews like any image
	await A.page.locator(`[data-card-id="${photo.id}"]`).dblclick();
	const preview = await until(
		() =>
			A.page.evaluate(() => {
				let t;
				window.__tp.test.v1.fileWindows.imagePreviewTarget.subscribe((v) => (t = v))();
				const img = document.querySelector('#image-preview-window img');
				return { title: t?.title ?? '', w: img?.naturalWidth ?? 0 };
			}),
		(v) => v.w === 96,
		'the preview window shows the photo'
	);
	h.check(/quadrants\.jpg/.test(preview?.title ?? ''), `the preview is titled with the photo (${preview?.title})`);
	await A.page.locator('#image-preview-window button[title="Close"]').click().catch(() => {});

	// 4. it textures a box, on both peers
	const box = await A.page.evaluate(async (id) => {
		window.__tp.test.v1.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		const group = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		const mesh = group.children[group.children.length - 1];
		const ok = await window.__tp.test.v1.explorerDrop.applyExplorerImage(mesh.uuid, { id });
		return { uuid: mesh.uuid, ok, dataUrl: mesh.material.userData.mapDataUrl ?? '' };
	}, photo.id);
	h.check(box.ok && box.dataUrl.startsWith('data:image/'), 'the photo textures the box on A');
	const mapOn = (p, uuid) =>
		p.page.evaluate(
			(uuid) =>
				new Promise((resolve) =>
					window.__tp.test.v1.objectsGroup.subscribe((g) => resolve(g.getObjectByProperty('uuid', uuid)?.material?.userData?.mapDataUrl ?? ''))()
				),
			uuid
		);
	const bMap = await until(() => mapOn(B, box.uuid), (v) => v.startsWith('data:image/'), 'the texture reaches B', 15000);
	const qb = bMap ? await B.page.evaluate(QUAD_SAMPLER, { dataUrl: bMap }) : null;
	h.check(!!qb && quadrantsMatch(qb), `B's texture is the photo's pixels (tl ${qb?.tl} br ${qb?.br})`);

	// 5. shared, the peer receives the DECODED bytes by content hash — and never the decoder
	await A.page.evaluate((id) => window.__tp.test.v1.sharedLibrary.shareItem(id), photo.id);
	const bItems = await until(
		async () => {
			const l = await itemsOf(B);
			if (!l.some((i) => i.hash === photo.hash)) await B.page.evaluate((hash) => window.__tp.test.v1.assetShare.requestAsset(hash), photo.hash);
			return l;
		},
		(l) => l.some((i) => i.hash === photo.hash),
		'the shared photo reaches B by its hash',
		25000
	);
	const bPhoto = bItems?.find((i) => i.hash === photo.hash);
	h.check(!!bPhoto && bPhoto.kind === 'image' && /\.jpg$/.test(bPhoto.name), `B holds it as an image (${bPhoto?.name})`);
	// the index row can land before the bytes: wait for B to HOLD them — the SAME bytes, by
	// hash (a received blob carries no MIME type, as for every file a peer pulls)
	const bHash = bPhoto
		? await until(
				() =>
					B.page.evaluate(async (id) => {
						const blob = await window.__tp.test.v1.explorer.itemBlob(id);
						if (!blob) return '';
						const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
						return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
					}, bPhoto.id),
				(v) => v === photo.hash,
				'B holds the decoded JPEG bytes (same SHA-256 as A)',
				20000
			)
		: '';
	const qb2 = bHash === photo.hash ? await B.page.evaluate(QUAD_SAMPLER, { id: bPhoto.id }) : null;
	h.check(!!qb2 && qb2.w === 96 && qb2.h === 64 && quadrantsMatch(qb2), `B's copy decodes to the photo (${qb2?.w}x${qb2?.h}, tl ${qb2?.tl})`);
	const bHeic = await B.page.evaluate(() => (window.__tp.test.v1.heic?.heicDebug?.() ?? { workerStarted: false, decodes: 0, lastMs: 0 }));
	h.check(!bHeic.workerStarted && asked.B.length === 0, `B never loaded the decoder (worker ${bHeic.workerStarted}, requests ${asked.B.length})`);

	// 6. a HEIC picked straight into a texture slot (the Inspector / UV editor door)
	const slot = await A.page.evaluate(async (bytes) => {
		window.__tp.test.v1.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		const group = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		const mesh = group.children[group.children.length - 1];
		const n = await window.__tp.test.v1.materialsHandler.setObjectsTexture([mesh.uuid], new File([new Uint8Array(bytes)], 'IMG_0001.HEIC', { type: 'image/heic' }));
		return { uuid: mesh.uuid, n, dataUrl: mesh.material.userData.mapDataUrl ?? '' };
	}, Array.from(HEIC));
	h.check(slot.n === 1 && slot.dataUrl.startsWith('data:image/'), 'a HEIC picked into a texture slot textures the box');
	const qs = await A.page.evaluate(QUAD_SAMPLER, { dataUrl: slot.dataUrl });
	h.check(quadrantsMatch(qs), `…with the photo's pixels (tl ${qs.tl})`);
	await until(() => mapOn(B, slot.uuid), (v) => v.startsWith('data:image/'), 'that texture reaches B too', 15000);

	// 7. a broken HEIC is refused with a reason, and nothing lands
	const before = (await itemsOf(A)).length;
	const toasts = await A.page.evaluate(async (bytes) => {
		await window.__tp.test.v1.explorer.importFiles([new File([new Uint8Array(bytes)], 'broken.heic', { type: 'image/heic' })], null);
		let list = [];
		window.__tp.test.v1.notifications.subscribe((v) => (list = v))();
		return list.map((n) => String(n.text ?? ''));
	}, Array.from(HEIC.subarray(0, 300)));
	await A.page.waitForTimeout(500);
	h.check((await itemsOf(A)).length === before, 'a truncated HEIC adds no item');
	h.check(toasts.some((t) => /Could not read broken\.heic/.test(t)), `…and says why (${toasts.find((t) => /broken/.test(t)) ?? 'no toast seen'})`);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors on either peer (${[...h.pageErrors(A), ...h.pageErrors(B)].join(' | ').slice(0, 200)})`);
	await h.finish(browser);
});
