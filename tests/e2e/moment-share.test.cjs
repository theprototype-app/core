// 95 SM1-SM3 — SHARE A MOMENT: the last 10 s of Play, kept in a rolling buffer, trimmed and written
// to a GIF or an MP4 through the 68-V9 encoders.
//
//   1. NOTHING BEFORE PLAY: the buffer module is not even loaded and the Play bar has no button
//   2. 10 s OF PLAY: the buffer holds ~10 s (never more), frames are real JPEGs of the game view, the
//      Play bar shows the button; the frame cost is read (SM3 numbers, printed as MOMENT-COST)
//   3. F8 opens the preview: the buffer freezes, the pointer is freed (the menu substate), the trim
//      clamps to 3-10 s; a 3.0 s trim → a GIF of EXACTLY 45 frames lasting 3.0 s (ImageDecoder), and
//      → an MP4 of 45 frames, 3.0 s (demuxed in node by Mediabunny)
//   4. Escape closes the preview WITHOUT leaving Play, and the frames go back to the buffer
//   5. leaving Play forgets everything; the setting off = nothing is buffered in Play
//   6. SM3 PRIVACY: a published game's player (`?embed=1`) — no button and nothing buffered while
//      the scene does not allow moments; the author's switch (play.moments) turns both on
//   7. VR: the buffer stands down and the button goes
// Counterfactual (base v1.67.1): no `momentStores` hook, no #moment-share — section 1 is red there.
// Evidence: MOMENT_SHOTS=<dir> writes screenshots and the two files there.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { Input, BufferSource, ALL_FORMATS } = require('mediabunny');

const { check } = h;
const SHOTS = process.env.MOMENT_SHOTS || '';
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

/** a store's value @param {any} page @param {string} hook @param {string} name */
const storeOf = (page, hook, name) =>
	page.evaluate(
		({ hook, name }) => {
			const S = /** @type {any} */ (window).__tp.test.v1;
			const st = hook ? S[hook]?.[name] : S[name];
			if (!st) return undefined;
			let v;
			st.subscribe((/** @type {any} */ x) => (v = x))();
			return v;
		},
		{ hook, name }
	);
/** the buffer's debug state (null before the first Play loads it) @param {any} page */
const bufferState = (page) => page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state() ?? null);
/** @param {any} page @param {boolean} v */
const setPlaying = (page, v) => page.evaluate((v) => /** @type {any} */ (window).__tp.test.v1.isLocked.set(v ? true : false), v);

/** the result file as base64 @param {any} page */
const resultFile = (page) =>
	page.evaluate(async () => {
		const el = /** @type {any} */ (document.querySelector('#moment-image, #moment-video'));
		const card = /** @type {any} */ (document.querySelector('#moment-result'));
		if (!el || !card) return null;
		const buf = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
		let b = '';
		for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { mime: card.dataset.mime, frames: Number(card.dataset.frames), fps: Number(card.dataset.fps), ms: Number(card.dataset.durationMs), b64: btoa(b) };
	});

/** set a trim handle like a person dragging it @param {any} page @param {string} id @param {number} v */
async function setRange(page, id, v) {
	await page.locator('#' + id).fill(String(v));
	await page.waitForTimeout(100);
}

/** Make the file in `format` from the open preview, return it @param {any} page @param {'gif'|'mp4'} format */
async function make(page, format) {
	await page.locator(`#moment-format [data-value="${format}"]`).first().click();
	await page.click('#moment-make');
	await page.waitForSelector('#moment-result, #moment-error', { timeout: 120000 });
	const err = await page.$('#moment-error');
	if (err) return { error: await err.textContent() };
	return resultFile(page);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 }, acceptDownloads: true } });
	const { page } = A;
	// something on screen that changes: a box spun by a flow node is overkill — a sphere + a box will do,
	// the encoders do not care what they encode; the frames must be the GAME VIEW (non-blank JPEGs)
	await page.evaluate(async () => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		S.commandsHandler.sceneCommand('/create box');
		S.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 300));
	});

	// ---------- 1. nothing before Play ----------
	const pre = await storeOf(page, 'momentStores', 'momentStatus');
	check(!!pre && pre.loaded === false && pre.on === false, `before Play the buffer is not loaded (${JSON.stringify(pre)})`);
	check((await bufferState(page)) === null, 'and its module is not on the page');
	check(!(await page.$('#moment-share')), 'no Share a moment button outside Play');

	// ---------- 2. 10 s of Play ----------
	await setPlaying(page, true);
	await page.waitForFunction(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state().armed === true, null, { timeout: 30000 });
	const t0 = Date.now();
	await page.waitForTimeout(11000);
	const st = await bufferState(page);
	console.log('MOMENT-STATE ' + JSON.stringify(st));
	check(st.reason === '' && st.armed, `in Play the buffer records (${st.reason || 'armed'}, path ${st.path})`);
	check(st.frames >= 10 && st.span >= 9 && st.span <= 10.01, `it holds the last ~10 s and never more (${st.frames} frames over ${st.span.toFixed(2)} s after ${((Date.now() - t0) / 1000).toFixed(1)} s of Play)`);
	check(st.size.w <= 640 && st.size.h <= 640 && st.bytes / st.frames > 1500, `frames are small JPEGs of the view (${st.size.w} × ${st.size.h}, ${Math.round(st.bytes / st.frames)} B each, ${(st.bytes / 1048576).toFixed(2)} MB kept)`);
	check(st.failures === 0, `no capture failed (${st.failures} ${st.lastError})`);
	console.log(`MOMENT-COST path=${st.path} perFrame mean=${st.cost.mean.toFixed(3)} p95=${st.cost.p95.toFixed(3)} max=${st.cost.max.toFixed(3)} ms · capture mean=${st.captureCost.mean.toFixed(3)} p95=${st.captureCost.p95.toFixed(3)} max=${st.captureCost.max.toFixed(3)} ms (${st.captureCost.samples} captures)`);
	check(st.cost.mean <= 1, `the buffer's mean main-thread cost per frame is within the 1 ms desktop budget (${st.cost.mean.toFixed(3)} ms)`);
	// a kept frame is a real picture of the game view (not a blank buffer)
	const variance = await page.evaluate(async () => {
		const api = /** @type {any} */ (window).__tp.test.v1.momentBuffer;
		const taken = api.takeMoment();
		const f = taken.frames[taken.frames.length - 1];
		const bmp = await createImageBitmap(f.data);
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 36;
		const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		ctx.drawImage(bmp, 0, 0, 64, 36);
		const d = ctx.getImageData(0, 0, 64, 36).data;
		const lum = [];
		for (let i = 0; i < d.length; i += 4) lum.push(d[i] + d[i + 1] + d[i + 2]);
		const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
		api.returnMoment(taken.frames);
		return { mean, var: lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length, type: f.data.type };
	});
	check(variance.type === 'image/jpeg' && variance.var > 20, `the newest frame is a JPEG with a picture in it (luma variance ${variance.var.toFixed(0)}, mean ${variance.mean.toFixed(0)})`);
	await page.waitForSelector('#moment-share', { timeout: 5000 });
	check(!!(await page.$('#play-banner #moment-share')), 'the Play bar carries the Share a moment button');
	await shot(page, '01-play-bar.png');

	// ---------- 3. F8 → the preview → GIF and MP4 of the trimmed length ----------
	await page.keyboard.press('F8');
	await page.waitForSelector('#moment-dialog[data-phase="trim"] #moment-preview', { timeout: 20000 });
	const frozen = await bufferState(page);
	const free = await storeOf(page, '', 'playPointerFree');
	check(!frozen.armed && frozen.frames === 0, `the buffer is frozen while the preview is open (armed ${frozen.armed}, ${frozen.frames} frames left in it)`);
	check(free === true, 'the preview is a menu in Play: the pointer is free');
	check((await storeOf(page, '', 'isLocked')) === true, 'and Play goes on underneath');
	const total = Number(await page.getAttribute('#moment-dialog', 'data-total'));
	check(total >= 9 && total <= 10.01, `the preview offers the last ${total} s`);
	// the trim clamps: an end pulled to 1 s past the start pushes the start back to keep 3 s
	await setRange(page, 'moment-trim-start', 4);
	await setRange(page, 'moment-trim-end', 5);
	const clamped = { s: Number(await page.getAttribute('#moment-dialog', 'data-start')), e: Number(await page.getAttribute('#moment-dialog', 'data-end')) };
	check(Math.abs(clamped.e - clamped.s - 3) < 0.01, `a 1 s trim is held at the 3 s minimum (${clamped.s}-${clamped.e})`);
	await setRange(page, 'moment-trim-start', 0);
	await setRange(page, 'moment-trim-end', 10);
	const wide = { s: Number(await page.getAttribute('#moment-dialog', 'data-start')), e: Number(await page.getAttribute('#moment-dialog', 'data-end')) };
	check(wide.e - wide.s <= 10.001, `and never longer than 10 s (${wide.s}-${wide.e})`);
	await setRange(page, 'moment-trim-start', 2);
	await setRange(page, 'moment-trim-end', 5);
	const trim = { s: Number(await page.getAttribute('#moment-dialog', 'data-start')), e: Number(await page.getAttribute('#moment-dialog', 'data-end')) };
	check(Math.abs(trim.e - trim.s - 3) < 0.01, `the trim is 3.0 s (${trim.s}-${trim.e})`);
	await shot(page, '02-preview.png');

	const gif = await make(page, 'gif');
	check(!!gif && !gif.error && gif.mime === 'image/gif', `the GIF is made (${gif?.error || gif?.mime})`);
	if (gif?.b64) {
		keep('moment.gif', Buffer.from(gif.b64, 'base64'));
		const dec = await page.evaluate(async (b64) => {
			const bin = atob(b64);
			const u = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
			const d = new /** @type {any} */ (window).ImageDecoder({ data: u, type: 'image/gif' });
			await d.tracks.ready;
			const count = d.tracks.selectedTrack.frameCount;
			let us = 0;
			for (let i = 0; i < count; i++) {
				const { image } = await d.decode({ frameIndex: i });
				us += image.duration ?? 0;
				image.close();
			}
			return { count, seconds: us / 1e6 };
		}, gif.b64);
		check(dec.count === 45, `the GIF has EXACTLY 45 frames = 3 s × 15 fps (decoded: ${dec.count})`);
		check(Math.abs(dec.seconds - 3) < 0.05, `and plays for 3.0 s (${dec.seconds.toFixed(3)} s)`);
	}
	await shot(page, '03-result-gif.png');
	await page.click('#moment-again');
	await page.waitForSelector('#moment-make');
	const mp4 = await make(page, 'mp4');
	check(!!mp4 && !mp4.error && mp4.mime === 'video/mp4', `the MP4 is made (${mp4?.error || mp4?.mime})`);
	if (mp4?.b64) {
		const bytes = new Uint8Array(Buffer.from(mp4.b64, 'base64'));
		keep('moment.mp4', bytes);
		const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const vt = await input.getPrimaryVideoTrack();
		const stats = vt ? await vt.computePacketStats() : null;
		const dur = await input.computeDuration();
		check(!!stats && stats.packetCount === 45, `the MP4 has EXACTLY 45 frames (demuxed: ${stats?.packetCount})`);
		check(Math.abs(dur - 3) < 0.05, `and lasts 3.0 s (${dur.toFixed(3)} s)`);
	}
	await shot(page, '04-result-mp4.png');
	const savedNote = (await page.textContent('#moment-note').catch(() => '')) || '';
	check(/Explorer/.test(savedNote), `in the editor the file is kept in Explorer ▸ Recordings too (${savedNote.trim()})`);

	// ---------- 4. Escape closes the preview, not Play; the frames go back ----------
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => !document.querySelector('#moment-dialog'), null, { timeout: 10000 });
	check((await storeOf(page, '', 'isLocked')) === true, 'Escape closed the preview and Play goes on');
	await page.waitForTimeout(600);
	const back = await bufferState(page);
	check(back.armed && back.frames >= 10, `the buffer records again with the moment given back (${back.frames} frames)`);

	// ---------- 5. leaving Play forgets everything; the setting off records nothing ----------
	await setPlaying(page, false);
	await page.waitForTimeout(700);
	const out = await bufferState(page);
	check(!out.armed && out.frames === 0 && out.reason === 'idle', `out of Play nothing is buffered (${out.frames} frames, ${out.reason})`);
	check(!(await page.$('#moment-share')), 'and the button is gone');
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.momentStores.momentRecording.set(false));
	await setPlaying(page, true);
	await page.waitForTimeout(2500);
	const off = await bufferState(page);
	check(!off.armed && off.frames === 0 && off.reason === 'setting', `with "Recording the last 10 s" off, Play records nothing (${off.frames} frames, ${off.reason})`);
	check(!(await page.$('#moment-share')), 'and shows no button');
	await page.keyboard.press('F8');
	await page.waitForTimeout(500);
	check(!(await page.$('#moment-dialog')), 'F8 opens nothing');
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.momentStores.momentRecording.set(true));

	// ---------- 7. VR: off, no button ----------
	await page.waitForFunction(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state().armed === true, null, { timeout: 10000 });
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.isVRMode.set(true));
	await page.waitForTimeout(700);
	const vr = await bufferState(page);
	check(!vr.armed && vr.frames === 0 && vr.reason === 'vr', `in VR the buffer stands down and forgets (${vr.frames} frames, ${vr.reason})`);
	check(!(await page.$('#moment-share')), 'and there is no button');
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.isVRMode.set(false));
	await setPlaying(page, false);

	// ---------- 6. a published game's player ----------
	const E = await h.setupPage(browser, 'E', { hash: '?embed=1', context: { viewport: { width: 1280, height: 800 } } });
	const ep = E.page;
	await setPlaying(ep, true);
	await ep.waitForFunction(() => !!(/** @type {any} */ (window).__tp.test.v1.momentBuffer), null, { timeout: 30000 });
	await ep.waitForTimeout(3000);
	const pl = await bufferState(ep);
	check(!pl.armed && pl.frames === 0 && pl.reason === 'player', `a published game's player buffers nothing by default (${pl.frames} frames, ${pl.reason})`);
	check(!(await ep.$('#embed-moment')) && !(await ep.$('#moment-share')), 'and sees no Share a moment button');
	await ep.keyboard.press('F8');
	await ep.waitForTimeout(500);
	check(!(await ep.$('#moment-dialog')), 'F8 opens nothing for them');
	await shot(ep, '05-player-default.png');
	// the author allows it (Configure Scene ▸ Play): the play runtime honours the scene setting
	await ep.evaluate(() => /** @type {any} */ (window).__tp.test.v1.scenePhysics.setScenePhysics({ play: { moments: true } }));
	await ep.waitForFunction(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state().armed === true, null, { timeout: 10000 });
	await ep.waitForSelector('#embed-moment', { timeout: 10000 });
	await ep.waitForTimeout(2500);
	const al = await bufferState(ep);
	check(al.armed && al.frames > 0, `with the author's switch on, the player records (${al.frames} frames)`);
	await shot(ep, '06-player-allowed.png');

	await h.finish(browser);
});
