// 65 M4 + M7 — THE FRAME-EXACT EXPORT and THE WEBSITE SECTION, through the real Recording dialog.
//
//   1. a TIMELINE (a 48 sequence: one camera shot gliding from camera A to camera B) exported to MP4
//      at 854×480, 30 fps, 2 s: the file's video track has EXACTLY 60 frames (demuxed in node by
//      Mediabunny — an independent reader), 2.0 s long, 854×480; the camera really glided (the first
//      and last decoded frames differ); the editor camera and the timeline are restored afterwards
//   2. the same timeline as a GIF loop and an animated WebP loop: 60 frames each (ImageDecoder), and
//      their FIRST FRAMES MATCH each other and the MP4's first frame (mean abs diff per channel)
//   3. a TURNTABLE as a PNG sequence with a transparent background: the .zip holds exactly N PNGs,
//      a corner pixel is transparent and the object's pixels are opaque
//   4. a WEBSITE SECTION (scroll): the result shows the size report + snippet; the script, pasted
//      into a PLAIN page (no app), scrubs its frames by page scroll (top → frame 0, the end of the
//      track → the last frame, half-way → the middle), is responsive (a phone-width viewport resizes
//      the drawing buffer), jumps without gliding under reduced motion, and the same data with
//      trigger "click" plays to the end and back on two clicks
//   5. Cancel mid-export saves nothing and puts the camera back
// Evidence: VIDEO_EXPORT_SHOTS=<dir> writes screenshots and the exported files there.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { Input, BufferSource, ALL_FORMATS } = require('mediabunny');

const SHOTS = process.env.VIDEO_EXPORT_SHOTS || '';
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
}
/** @param {string} name @param {Uint8Array} bytes */
function keep(name, bytes) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	fs.writeFileSync(path.join(SHOTS, name), bytes);
}

/** the finished result, its bytes as base64 @param {any} page */
const resultOf = (page) =>
	page.evaluate(async () => {
		let s = /** @type {any} */ (null);
		window.__stores.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
		const r = s.result;
		if (!r) return { status: s.status, error: s.error };
		const buf = new Uint8Array(await r.blob.arrayBuffer());
		let b = '';
		for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { status: s.status, error: s.error, name: r.name, mime: r.mime, frames: r.frames, w: r.width, h: r.height, fps: r.fps, bytes: r.bytes, b64: btoa(b), report: r.report, snippet: r.snippet, script: r.script, itemId: r.itemId, encoder: r.encoder };
	});

/** camera position + controls target @param {any} page */
const camState = (page) =>
	page.evaluate(() => {
		let cam = /** @type {any} */ (null);
		let ctl = /** @type {any} */ (null);
		window.__stores.globalCamera.subscribe((/** @type {any} */ c) => (cam = c))();
		window.__stores.orbitControls.subscribe((/** @type {any} */ c) => (ctl = c))();
		return { pos: cam.position.toArray(), target: ctl.target.toArray() };
	});

/** the dialog, opened from the viewport menu like a person would @param {any} page */
async function openDialog(page) {
	await page.evaluate(() => window.__stores.viewportMenu.set({ x: 200, y: 160, point: { x: 0, y: 0, z: 0 } }));
	await page.locator('[role="menuitem"]', { hasText: /^\s*Tools/ }).first().hover();
	await page.locator('[role="menuitem"]', { hasText: /^\s*Recording…\s*$/ }).first().click();
	await page.waitForSelector('#recording-dialog', { timeout: 10000 });
}

/** @param {any} page @param {Record<string, string>} sel select id -> value @param {Record<string, string>} [num] */
async function setOptions(page, sel, num = {}) {
	for (const [id, v] of Object.entries(sel)) await page.selectOption('#' + id, v);
	for (const [id, v] of Object.entries(num)) {
		await page.fill('#' + id, v);
		await page.locator('#' + id).dispatchEvent('change');
	}
	await page.waitForTimeout(150);
}

/** press Export, wait for the result card @param {any} page @param {number} [timeout] */
async function exportNow(page, timeout = 120000) {
	await page.click('#recording-start');
	await page.waitForSelector('#recording-result, #recording-error', { timeout });
	return resultOf(page);
}

/** mean abs difference per channel of two RGBA arrays (same size) @param {number[]} a @param {number[]} b */
function meanDiff(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i]);
	return s / ((a.length * 3) / 4);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 }, acceptDownloads: true } });
	const { page } = A;

	// ---------- the scene: a box, a sphere, two cameras, a timeline gliding A → B ----------
	const made = await page.evaluate(async () => {
		const S = window.__stores;
		let g = /** @type {any} */ (null);
		S.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		S.commandsHandler.sceneCommand('/create box');
		S.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 300));
		const sphere = g.children.find((/** @type {any} */ o) => /sphere/i.test(o.name));
		if (sphere) {
			sphere.position.set(1.6, 0.5, 0);
			sphere.updateMatrix();
		}
		/** @param {string} name @param {number[]} p */
		const makeCam = async (name, p) => {
			const before = new Set(g.children.map((/** @type {any} */ o) => o.uuid));
			S.commandsHandler.sceneCommand('/create Camera');
			await new Promise((r) => setTimeout(r, 400));
			const cam = g.children.find((/** @type {any} */ o) => !before.has(o.uuid));
			cam.name = name;
			cam.position.set(p[0], p[1], p[2]);
			cam.lookAt(0, 0.5, 0);
			cam.updateMatrix();
			cam.updateMatrixWorld(true);
			return cam.uuid;
		};
		const a = await makeCam('Cam A', [0, 2.5, 7]);
		const b = await makeCam('Cam B', [6, 1.5, 3]);
		const sq = S.sequences;
		const id = sq.createSequence('Glide', { duration: 2 });
		const track = sq.addTrack(id, 'camera');
		sq.addItem(id, track, { t: 0, dur: 2, camera: a, to: b });
		return { id, a, b };
	});
	h.check(!!made.id && !!made.a && !!made.b, 'a timeline with one shot gliding from camera A to camera B');
	await page.waitForTimeout(800);

	// ---------- 1. MP4: exactly duration × fps frames ----------
	await openDialog(page);
	await page.click('#recording-mode-timeline');
	await page.waitForTimeout(200);
	await setOptions(page, { 'recording-sequence': made.id, 'recording-format': 'mp4', 'recording-resolution': '480p', 'recording-fps': '30' }, { 'recording-duration': '2' });
	const est = await page.evaluate(() => {
		const e = /** @type {HTMLElement} */ (document.querySelector('#recording-estimate'));
		return { frames: Number(e.dataset.frames), path: e.dataset.path, text: e.textContent?.trim(), blocked: document.querySelector('#recording-blocked')?.textContent ?? '' };
	});
	h.check(est.frames === 60 && est.path === 'webcodecs', `the dialog plans 60 frames through WebCodecs (${est.text}) ${est.blocked}`);
	await shot(page, '01-dialog-timeline-mp4.png');
	const camBefore = await camState(page);
	await page.click('#recording-start');
	await page.waitForSelector('#recording-bar', { timeout: 5000 });
	let sawFrameCounter = '';
	for (let i = 0; i < 40 && !sawFrameCounter; i++) {
		sawFrameCounter = await page.evaluate(() => {
			const t = document.querySelector('#recording-time');
			return t && /frame \d+ \/ 60/.test(t.textContent || '') ? t.textContent || '' : '';
		});
		if (!sawFrameCounter) await page.waitForTimeout(100);
	}
	h.check(!!sawFrameCounter, `the progress pill counts frames (${sawFrameCounter.trim()})`);
	await shot(page, '02-rendering-bar.png');
	await page.waitForSelector('#recording-result, #recording-error', { timeout: 120000 });
	const mp4 = await resultOf(page);
	h.check(mp4.status === 'done' && mp4.mime === 'video/mp4', `the MP4 is done (${mp4.status} ${mp4.error || ''} · ${mp4.encoder})`);
	await shot(page, '03-result-mp4.png');
	const mp4Bytes = new Uint8Array(Buffer.from(mp4.b64 || '', 'base64'));
	keep('timeline.mp4', mp4Bytes);
	const input = new Input({ source: new BufferSource(mp4Bytes), formats: ALL_FORMATS });
	const vt = await input.getPrimaryVideoTrack();
	const stats = vt ? await vt.computePacketStats() : null;
	const dur = await input.computeDuration();
	h.check(!!stats && stats.packetCount === 60, `the MP4's video track has EXACTLY 60 frames = 2 s × 30 fps (demuxed: ${stats?.packetCount})`);
	h.check(Math.abs(dur - 2) < 0.02, `and lasts 2.0 s (${dur.toFixed(3)} s)`);
	h.check(vt?.displayWidth === 854 && vt?.displayHeight === 480, `at 854 × 480 (${vt?.displayWidth} × ${vt?.displayHeight})`);
	const camAfter = await camState(page);
	const moved = Math.hypot(...camAfter.pos.map((v, i) => v - camBefore.pos[i]));
	h.check(moved < 1e-3, `the editor camera is back where it was (${moved.toExponential(1)})`);
	const restored = await page.evaluate(() => {
		let pv = /** @type {any} */ (null);
		window.__stores.cameraPreview.cameraPreview.subscribe((/** @type {any} */ v) => (pv = v))();
		return { preview: pv?.uuid ?? null, debug: window.__stores.videoExport.exportDebug() };
	});
	h.check(!restored.preview && restored.debug === null, `the shot's camera view is released and the export is gone (${restored.preview})`);

	// first / last frames of the MP4, decoded by the browser
	/** @param {string} b64 @param {string} mime @param {'first'|'last'} which */
	const videoFrame = (b64, mime, which) =>
		page.evaluate(
			async ({ b64, mime, which }) => {
				const bin = atob(b64);
				const u = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
				const v = document.createElement('video');
				v.muted = true;
				v.src = URL.createObjectURL(new Blob([u], { type: mime }));
				await new Promise((r, j) => ((v.onloadeddata = r), (v.onerror = j)));
				v.currentTime = which === 'first' ? 0 : Math.max(0, v.duration - 0.02);
				await new Promise((r) => (v.onseeked = r));
				const c = document.createElement('canvas');
				c.width = 64;
				c.height = 36;
				const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
				ctx.drawImage(v, 0, 0, 64, 36);
				return Array.from(ctx.getImageData(0, 0, 64, 36).data);
			},
			{ b64, mime, which }
		);
	const mp4First = await videoFrame(mp4.b64, 'video/mp4', 'first');
	const mp4Last = await videoFrame(mp4.b64, 'video/mp4', 'last');
	const glide = meanDiff(mp4First, mp4Last);
	h.check(glide > 6, `the camera glided A → B during the take (first vs last frame differ by ${glide.toFixed(1)})`);

	// ---------- 2. GIF + WebP loops: same frame count, same first frame ----------
	/** decode an animated image's frame count + first frame @param {string} b64 @param {string} mime */
	const imageFrames = (b64, mime) =>
		page.evaluate(
			async ({ b64, mime }) => {
				const bin = atob(b64);
				const u = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
				const dec = new /** @type {any} */ (window).ImageDecoder({ data: u, type: mime });
				await dec.tracks.ready;
				const count = dec.tracks.selectedTrack.frameCount;
				const { image } = await dec.decode({ frameIndex: 0 });
				const c = document.createElement('canvas');
				c.width = 64;
				c.height = 36;
				const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
				ctx.drawImage(image, 0, 0, 64, 36);
				return { count, w: image.displayWidth, h: image.displayHeight, px: Array.from(ctx.getImageData(0, 0, 64, 36).data) };
			},
			{ b64, mime }
		);
	await page.click('#recording-again');
	await page.waitForSelector('#recording-start');
	await setOptions(page, { 'recording-format': 'gif' });
	const gif = await exportNow(page);
	h.check(gif.status === 'done' && gif.mime === 'image/gif', `the GIF loop is done (${gif.status} ${gif.error || ''}, ${Math.round((gif.bytes || 0) / 1024)} KB)`);
	keep('timeline.gif', new Uint8Array(Buffer.from(gif.b64 || '', 'base64')));
	await shot(page, '04-result-gif.png');
	const gifDec = await imageFrames(gif.b64, 'image/gif');
	h.check(gifDec.count === 60 && gifDec.w === 854, `the GIF has 60 frames at 854 px (${gifDec.count}, ${gifDec.w})`);

	await page.click('#recording-again');
	await page.waitForSelector('#recording-start');
	await setOptions(page, { 'recording-format': 'webp' });
	const webp = await exportNow(page);
	h.check(webp.status === 'done' && webp.mime === 'image/webp', `the animated WebP is done (${webp.status} ${webp.error || ''}, ${Math.round((webp.bytes || 0) / 1024)} KB)`);
	keep('timeline.webp', new Uint8Array(Buffer.from(webp.b64 || '', 'base64')));
	const webpDec = await imageFrames(webp.b64, 'image/webp');
	h.check(webpDec.count === 60 && webpDec.w === 854, `the WebP has 60 frames at 854 px (${webpDec.count}, ${webpDec.w})`);
	const gw = meanDiff(gifDec.px, webpDec.px);
	const gm = meanDiff(gifDec.px, mp4First);
	const wm = meanDiff(webpDec.px, mp4First);
	h.check(gw < 6 && gm < 8 && wm < 8, `the first frames MATCH: GIF↔WebP ${gw.toFixed(2)}, GIF↔MP4 ${gm.toFixed(2)}, WebP↔MP4 ${wm.toFixed(2)}`);
	h.check(meanDiff(gifDec.px, mp4Last) > gw + 3, 'and the match is not trivial (the first frame differs from the last one)');

	// ---------- 3. PNG sequence with a transparent background (a turntable) ----------
	await page.click('#recording-again');
	await page.waitForSelector('#recording-start');
	await page.click('#recording-mode-turntable');
	await setOptions(page, { 'recording-format': 'png', 'recording-resolution': 'square480', 'recording-fps': '12', 'recording-target': 'scene' }, { 'recording-duration': '1' });
	await page.check('#recording-transparent');
	await page.waitForTimeout(150);
	await shot(page, '05-dialog-png-transparent.png');
	const png = await exportNow(page);
	h.check(png.status === 'done' && png.mime === 'application/zip', `the PNG sequence is done (${png.status} ${png.error || ''})`);
	const pngZip = unzipSync(new Uint8Array(Buffer.from(png.b64 || '', 'base64')));
	const pngNames = Object.keys(pngZip).filter((n) => n.endsWith('.png')).sort();
	h.check(pngNames.length === 12, `the .zip holds exactly 12 PNGs = 1 s × 12 fps (${pngNames.length}: ${pngNames[0]} … ${pngNames[pngNames.length - 1]})`);
	if (pngNames.length) keep('turntable_frame0.png', pngZip[pngNames[0]]);
	const alpha = await page.evaluate(async (b64) => {
		const bin = atob(b64);
		const u = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
		const bmp = await createImageBitmap(new Blob([u], { type: 'image/png' }));
		const c = document.createElement('canvas');
		c.width = bmp.width;
		c.height = bmp.height;
		const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		ctx.drawImage(bmp, 0, 0);
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		let opaque = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i] === 255) opaque++;
		return { w: c.width, corner: d[3], opaqueShare: opaque / (d.length / 4) };
	}, pngNames.length ? Buffer.from(pngZip[pngNames[0]]).toString('base64') : '');
	h.check(alpha.w === 480 && alpha.corner === 0, `frame 0 is 480 px with a TRANSPARENT background (corner alpha ${alpha.corner})`);
	h.check(alpha.opaqueShare > 0.01 && alpha.opaqueShare < 0.9, `and the objects are opaque (${(alpha.opaqueShare * 100).toFixed(1)}% opaque pixels)`);
	const skyBack = await page.evaluate(() => {
		let sc = /** @type {any} */ (null);
		window.__stores.globalScene.subscribe((/** @type {any} */ s) => (sc = s))();
		return !!sc.background;
	});
	h.check(skyBack, 'the sky is back after the transparent export');

	// ---------- 4. the website section ----------
	await page.click('#recording-again');
	await page.waitForSelector('#recording-start');
	await page.click('#recording-mode-timeline');
	await page.uncheck('#recording-transparent').catch(() => {});
	await setOptions(page, { 'recording-sequence': made.id, 'recording-format': 'hero', 'recording-resolution': '480p', 'recording-fps': '12' }, { 'recording-duration': '2' });
	await page.waitForSelector('#recording-hero-options');
	await setOptions(page, { 'recording-hero-trigger': 'scroll', 'recording-hero-ease': 'outQuad' }, { 'recording-hero-smooth': '200' });
	await shot(page, '06-dialog-website-section.png');
	const hero = await exportNow(page);
	h.check(hero.status === 'done' && hero.mime === 'application/zip' && hero.frames === 24, `the website section is done: 24 frames (${hero.status} ${hero.error || ''} ${hero.frames})`);
	const ui = await page.evaluate(() => ({
		report: !!document.querySelector('#recording-size-report'),
		snippet: /** @type {HTMLTextAreaElement} */ (document.querySelector('#recording-snippet'))?.value ?? '',
		scriptBytes: Number(/** @type {HTMLElement} */ (document.querySelector('#recording-size-report'))?.dataset.scriptBytes)
	}));
	h.check(ui.report && /data-tp-hero-track/.test(ui.snippet) && /<script src="tp-hero-glide\.js" defer><\/script>/.test(ui.snippet), 'the result shows the size report and a paste-in snippet (sticky scroll track + one script tag)');
	h.check(hero.report && hero.report.gzipBytes < hero.report.scriptBytes && hero.report.frames === 24, `size report: script ${Math.round(hero.report?.scriptBytes / 1024)} KB, ~${Math.round(hero.report?.gzipBytes / 1024)} KB gzipped, player ${Math.round(hero.report?.runtimeBytes / 1024)} KB`);
	await shot(page, '07-result-website-section.png');
	const heroZip = unzipSync(new Uint8Array(Buffer.from(hero.b64 || '', 'base64')));
	const heroFiles = Object.keys(heroZip).map((n) => n.split('/').pop());
	h.check(['index.html', 'tp-hero-glide.js', 'size-report.txt'].every((f) => heroFiles.includes(f)), `the .zip holds the demo page, the script and the size report (${heroFiles.join(', ')})`);
	const scriptName = Object.keys(heroZip).find((n) => n.endsWith('tp-hero-glide.js')) || '';
	const script = strFromU8(heroZip[scriptName]);
	h.check(script === hero.script && /anime\.js v4 \(MIT/.test(script), 'the zipped script is the one shown, with the anime.js licence banner');
	const indexName = Object.keys(heroZip).find((n) => n.endsWith('index.html')) || '';
	const pageHtml = strFromU8(heroZip[indexName]);
	if (SHOTS) for (const [n, b] of Object.entries(heroZip)) keep('section-' + n.split('/').pop(), b);

	// the script on a PLAIN page — no app, nothing else loaded
	const plainCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const plain = await plainCtx.newPage();
	const inline = pageHtml.replace(/<script src="tp-hero-glide\.js" defer><\/script>/, () => `<script>${script}</script>`);
	h.check(inline !== pageHtml, 'the demo page references the script by one tag (inlined here for the plain page)');
	await plain.setContent(inline, { waitUntil: 'load' });
	await plain.waitForFunction(() => document.querySelector('canvas[data-tp-hero]')?.getAttribute('data-ready') === '1', null, { timeout: 15000 });
	const frameNow = () => plain.evaluate(() => Number(document.querySelector('canvas[data-tp-hero]')?.getAttribute('data-frame')));
	/** scroll to a share of the track and wait for the glide to settle @param {number} share */
	const scrollTo = async (share) => {
		await plain.evaluate((s) => {
			const track = /** @type {HTMLElement} */ (document.querySelector('[data-tp-hero-track]'));
			const top = track.getBoundingClientRect().top + window.scrollY;
			window.scrollTo(0, top + s * (track.offsetHeight - window.innerHeight));
		}, share);
		await plain.waitForTimeout(700);
		return frameNow();
	};
	const f0 = await scrollTo(0);
	const fHalf = await scrollTo(0.5);
	const fEnd = await scrollTo(1);
	const fBack = await scrollTo(0.25);
	h.check(f0 === 0 && fEnd === 23 && Math.abs(fHalf - 11.5) <= 1 && Math.abs(fBack - 5.75) <= 1, `page scroll scrubs the timeline: top ${f0}, half ${fHalf}, end ${fEnd}, back to a quarter ${fBack}`);
	await scrollTo(0.5);
	if (SHOTS) await plain.screenshot({ path: path.join(SHOTS, '08-plain-page-scrolled.png') });
	const wide = await plain.evaluate(() => /** @type {HTMLCanvasElement} */ (document.querySelector('canvas[data-tp-hero]')).width);
	await plain.setViewportSize({ width: 390, height: 844 });
	await plain.waitForTimeout(400);
	const narrow = await plain.evaluate(() => /** @type {HTMLCanvasElement} */ (document.querySelector('canvas[data-tp-hero]')).width);
	h.check(narrow < wide && narrow > 0, `responsive: the drawing buffer follows the box (${wide} px → ${narrow} px at phone width)`);
	if (SHOTS) await plain.screenshot({ path: path.join(SHOTS, '09-plain-page-phone.png') });

	// reduced motion: no glide — the frame lands at once
	await plain.setViewportSize({ width: 1280, height: 800 });
	await plain.emulateMedia({ reducedMotion: 'reduce' });
	await plain.setContent(inline.replace('"smooth":200', '"smooth":1500'), { waitUntil: 'load' });
	await plain.waitForFunction(() => document.querySelector('canvas[data-tp-hero]')?.getAttribute('data-ready') === '1', null, { timeout: 15000 });
	await plain.evaluate(() => {
		const track = /** @type {HTMLElement} */ (document.querySelector('[data-tp-hero-track]'));
		window.scrollTo(0, track.getBoundingClientRect().top + window.scrollY + (track.offsetHeight - window.innerHeight));
	});
	await plain.waitForTimeout(120);
	const reduced = await frameNow();
	h.check(reduced === 23, `reduced motion: the scrub jumps (frame ${reduced} 120 ms after the scroll, with 1.5 s smoothing set)`);
	await plain.emulateMedia({ reducedMotion: 'no-preference' });

	// the same data with trigger "click": plays to the end, a second click plays back
	const clickHtml = inline.replace('"trigger":"scroll"', '"trigger":"click"');
	await plain.setContent(clickHtml, { waitUntil: 'load' });
	await plain.waitForFunction(() => document.querySelector('canvas[data-tp-hero]')?.getAttribute('data-ready') === '1', null, { timeout: 15000 });
	const c0 = await frameNow();
	await plain.locator('canvas[data-tp-hero]').scrollIntoViewIfNeeded();
	await plain.click('canvas[data-tp-hero]');
	await plain.waitForTimeout(2500);
	const c1 = await frameNow();
	await plain.click('canvas[data-tp-hero]');
	await plain.waitForTimeout(2500);
	const c2 = await frameNow();
	const pressed = await plain.evaluate(() => document.querySelector('canvas[data-tp-hero]')?.getAttribute('aria-pressed'));
	h.check(c0 === 0 && c1 === 23 && c2 === 0 && pressed === 'false', `click plays to the end and back: ${c0} → ${c1} → ${c2} (aria-pressed ${pressed})`);
	await plainCtx.close();

	// ---------- 5. cancel mid-export ----------
	await page.click('#recording-again');
	await page.waitForSelector('#recording-start');
	await page.click('#recording-mode-turntable');
	await setOptions(page, { 'recording-format': 'mp4', 'recording-resolution': '1080p', 'recording-fps': '60' }, { 'recording-duration': '20' });
	const camC = await camState(page);
	await page.click('#recording-start');
	await page.waitForFunction(() => /frame [1-9]\d* \//.test(document.querySelector('#recording-time')?.textContent || ''), null, { timeout: 30000 });
	await page.click('#recording-cancel');
	await page.waitForTimeout(500);
	const cancelled = await page.evaluate(() => {
		let s = /** @type {any} */ (null);
		window.__stores.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
		return { status: s.status, result: !!s.result, bar: !!document.querySelector('#recording-bar'), debug: window.__stores.videoExport.exportDebug(), canvas: !!document.querySelector('#recording-canvas') };
	});
	const camC2 = await camState(page);
	const movedC = Math.hypot(...camC2.pos.map((v, i) => v - camC.pos[i]));
	h.check(cancelled.status === 'idle' && !cancelled.result && !cancelled.bar && !cancelled.debug && !cancelled.canvas, `Cancel stops it, saves nothing, leaves no canvas (${JSON.stringify(cancelled)})`);
	h.check(movedC < 1e-3, `and puts the camera back (${movedC.toExponential(1)})`);

	await browser.close();
});
