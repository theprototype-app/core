// 102b-sound (row 1) — SOUND IN MOMENTS AND LIVE RECORDINGS: the scene's own Web Audio output (its music
// and sound effects), NEVER voices or a microphone, muxed into the file.
//
//   1. ZERO CHANGE: a scene that makes no sound — Play, Share a moment, MP4 — has no audio track and the
//      Scene sound row is not offered (Play makes an audio context anyway, so the ring may hear silence)
//   2. a scene playing a 440 Hz tone on the sfx bus AND a 1250 Hz tone on the VOICE bus: the moment buffer
//      keeps a sound ring beside the frames; a 3.0 s MP4 has an audio track ~3.0 s long; decoded, the
//      440 Hz tone is in it and the voice tone is NOT (the voice bus is never tapped)
//   3. "Scene sound" off = the MP4 has no audio track; GIF = the option is disabled with the reason
//   4. the LIVE recorder (a browser without WebCodecs): a 2 s turntable carries the same sound as an Opus
//      track (decoded: 440 Hz in, 1250 Hz out); the option off = no audio track
// Demux in node by Mediabunny; decode in the page by WebCodecs (AudioDecoder) / decodeAudioData.
// Evidence: SOUND_SHOTS=<dir> writes screenshots and the files there.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } = require('mediabunny');

const { check } = h;
const SHOTS = process.env.SOUND_SHOTS || '';
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

/** @param {any} page @param {boolean} v */
const setPlaying = (page, v) => page.evaluate((v) => /** @type {any} */ (window).__tp.test.v1.isLocked.set(v ? true : false), v);
const bufferState = (/** @type {any} */ page) => page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state() ?? null);

/** the two tones: 440 Hz on sfx (the scene), 1250 Hz on voice (a person) @param {any} page */
const startTones = (page) =>
	page.evaluate(() => {
		const eng = /** @type {any} */ (window).__tp.test.v1.audioEngine;
		const ctx = eng.ensureAudioContext();
		/** @type {any} */ (window).__tones?.forEach((/** @type {any} */ o) => o.stop());
		const make = (/** @type {number} */ f, /** @type {string} */ busName) => {
			const o = ctx.createOscillator();
			o.frequency.value = f;
			const g = ctx.createGain();
			g.gain.value = 0.3;
			o.connect(g).connect(eng.bus(busName));
			o.start();
			return o;
		};
		/** @type {any} */ (window).__tones = [make(440, 'sfx'), make(1250, 'voice')];
		return ctx.state;
	});
const stopTones = (/** @type {any} */ page) => page.evaluate(() => /** @type {any} */ (window).__tones?.forEach((/** @type {any} */ o) => o.stop()));

/** a blob URL in the page as bytes in node @param {any} page @param {string} selector */
async function fileOf(page, selector) {
	const b64 = await page.evaluate(async (sel) => {
		const el = /** @type {any} */ (document.querySelector(sel));
		if (!el) return null;
		const buf = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
		let b = '';
		for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return btoa(b);
	}, selector);
	return b64 ? new Uint8Array(Buffer.from(b64, 'base64')) : null;
}

/** the file's tracks, and its audio packets (to decode in the page) @param {Uint8Array} bytes */
async function demux(bytes) {
	const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const video = await input.getPrimaryVideoTrack();
	const audio = await input.getPrimaryAudioTrack();
	const out = { video: video ? await video.computeDuration() : 0, audio: null };
	if (audio) {
		const config = await audio.getDecoderConfig();
		const sink = new EncodedPacketSink(audio);
		/** @type {{ts: number, dur: number, key: boolean, data: string}[]} */
		const packets = [];
		for await (const p of sink.packets()) packets.push({ ts: p.timestamp, dur: p.duration, key: p.type === 'key', data: Buffer.from(p.data).toString('base64') });
		/** @type {any} */ (out).audio = {
			codec: audio.codec,
			duration: await audio.computeDuration(),
			channels: audio.numberOfChannels,
			rate: audio.sampleRate,
			config: config ? { ...config, description: config.description ? Buffer.from(/** @type {any} */ (config.description)).toString('base64') : undefined } : null,
			packets
		};
	}
	return out;
}

/** decode packets with WebCodecs in the page, then Goertzel power at the tones (440 scene, 1250 voice, 660 a
 * file's tone) over the middle of the file or the window `[from, to]` seconds @param {any} page @param {any} audio
 * @param {number[]} [win] */
const tonesIn = (page, audio, win) =>
	page.evaluate(async ({ a, win }) => {
		const b64 = (/** @type {string} */ s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
		/** @type {Float32Array[]} */
		const parts = [];
		const dec = new AudioDecoder({
			output: (d) => {
				const f = new Float32Array(d.numberOfFrames);
				d.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
				parts.push(f);
				d.close();
			},
			error: () => {}
		});
		dec.configure({ codec: a.config.codec, sampleRate: a.config.sampleRate, numberOfChannels: a.config.numberOfChannels, ...(a.config.description ? { description: b64(a.config.description) } : {}) });
		for (const p of a.packets) dec.decode(new EncodedAudioChunk({ type: p.key ? 'key' : 'delta', timestamp: Math.round(p.ts * 1e6), duration: Math.round(p.dur * 1e6), data: b64(p.data) }));
		await dec.flush();
		const n = parts.reduce((s, p) => s + p.length, 0);
		const pcm = new Float32Array(n);
		let o = 0;
		for (const p of parts) (pcm.set(p, o), (o += p.length));
		const rate = a.config.sampleRate;
		// skip the encoder's priming and the first fade-in: the middle of the file (or the asked window)
		const mid = win ? pcm.subarray(Math.floor(win[0] * a.config.sampleRate), Math.floor(win[1] * a.config.sampleRate)) : pcm.subarray(Math.floor(n * 0.2), Math.floor(n * 0.8));
		const g = (/** @type {number} */ f) => {
			const k = (2 * Math.cos((2 * Math.PI * f) / rate));
			let s1 = 0;
			let s2 = 0;
			for (let i = 0; i < mid.length; i++) {
				const s0 = mid[i] + k * s1 - s2;
				s2 = s1;
				s1 = s0;
			}
			return (s1 * s1 + s2 * s2 - k * s1 * s2) / (mid.length * mid.length);
		};
		let peak = 0;
		for (let i = 0; i < mid.length; i++) peak = Math.max(peak, Math.abs(mid[i]));
		return { frames: n, seconds: n / rate, scene: g(440), voice: g(1250), file: g(660), peak };
	}, { a: audio, win });

/** a 660 Hz WAV of `seconds`, imported into the Explorer; its content hash @param {any} page @param {number} seconds */
const importTone = (page, seconds) =>
	page.evaluate(async (seconds) => {
		const rate = 22050;
		const n = Math.round(seconds * rate);
		const buf = new ArrayBuffer(44 + n * 2);
		const v = new DataView(buf);
		const str = (/** @type {number} */ o, /** @type {string} */ t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
		str(0, 'RIFF');
		v.setUint32(4, 36 + n * 2, true);
		str(8, 'WAVE');
		str(12, 'fmt ');
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true);
		v.setUint16(22, 1, true);
		v.setUint32(24, rate, true);
		v.setUint32(28, rate * 2, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		str(36, 'data');
		v.setUint32(40, n * 2, true);
		for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 660 * i) / rate) * 12000, true);
		const created = await /** @type {any} */ (window).__tp.test.v1.explorer.importFiles([new File([buf], 'tone660.wav', { type: 'audio/wav' })], null);
		return created[0].hash;
	}, seconds);

/** a frame-exact export through the real export path; the file's bytes @param {any} page @param {any} prefs */
async function exportFile(page, prefs) {
	await page.evaluate((p) => /** @type {any} */ (window).__tp.test.v1.videoExport.startExport(p), prefs);
	await page.waitForFunction(
		() => {
			let s = /** @type {any} */ (null);
			/** @type {any} */ (window).__tp.test.v1.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
			return s.status === 'done' || s.status === 'error';
		},
		null,
		{ timeout: 120000 }
	);
	const r = await page.evaluate(async () => {
		let s = /** @type {any} */ (null);
		/** @type {any} */ (window).__tp.test.v1.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
		if (!s.result) return { error: s.error };
		const buf = new Uint8Array(await s.result.blob.arrayBuffer());
		let b = '';
		for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		const out = { sound: s.result.sound, note: s.result.savedNote, frames: s.result.frames, b64: btoa(b) };
		/** @type {any} */ (window).__tp.test.v1.recorder?.resetRecording?.();
		return out;
	});
	if (r.error) return { error: r.error };
	return { ...r, bytes: new Uint8Array(Buffer.from(r.b64, 'base64')) };
}

/** open Share a moment, trim to [2, 5], make `format`, wait for the result @param {any} page @param {'gif'|'mp4'} format @param {boolean} [sound] */
async function makeMoment(page, format, sound) {
	// closing a moment clears the buffer: let it hold the [2, 5] trim again first (slow on a loaded host)
	await page
		.waitForFunction(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state()?.span >= 5.5, null, { timeout: 40000 })
		.catch(() => {});
	await page.keyboard.press('F8');
	await page.waitForSelector('#moment-dialog[data-frames]', { timeout: 15000 });
	await page.waitForFunction(() => Number(document.querySelector('#moment-dialog')?.getAttribute('data-frames')) > 0, null, { timeout: 15000 });
	const held = await page.evaluate(() => ({ frames: document.querySelector('#moment-dialog')?.getAttribute('data-frames'), total: document.querySelector('#moment-dialog')?.getAttribute('data-total'), state: /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state() }));
	console.log('MOMENT-HELD ' + JSON.stringify({ frames: held.frames, total: held.total, slow: held.state?.slow, cost: held.state?.cost?.mean }));
	await page.locator('#moment-trim-start').fill('2');
	await page.locator('#moment-trim-end').fill('5');
	await page.locator(`#moment-format [data-value="${format}"]`).first().click();
	await page.waitForTimeout(150);
	const row = await page.evaluate(() => {
		const el = /** @type {HTMLInputElement | null} */ (document.querySelector('#moment-sound'));
		return el ? { checked: el.checked, disabled: el.disabled, title: el.closest('label')?.getAttribute('title') ?? '' } : null;
	});
	if (sound === false && row && row.checked) await page.click('#moment-sound');
	if (format === 'gif') return { row };
	await page.click('#moment-make');
	await page.waitForSelector('#moment-result, #moment-error', { timeout: 120000 });
	const card = await page.evaluate(() => {
		const c = /** @type {any} */ (document.querySelector('#moment-result'));
		return c ? { sound: c.dataset.sound, mime: c.dataset.mime, text: c.textContent, ms: Number(c.dataset.durationMs) } : { error: document.querySelector('#moment-error')?.textContent };
	});
	const bytes = await fileOf(page, '#moment-video');
	return { row, card, bytes };
}

const closeMoment = async (/** @type {any} */ page) => {
	await page.keyboard.press('Escape');
	await page.waitForSelector('#moment-dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
};

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });

	// ---------- 1. zero change: a scene that never made a sound ----------
	{
		const A = await h.setupPage(browser, 'A', { audio: true, context: { viewport: { width: 1280, height: 800 } } });
		const { page } = A;
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.commandsHandler.sceneCommand('/create box'));
		await setPlaying(page, true);
		await page.waitForFunction(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state().armed === true, null, { timeout: 30000 });
		await page.waitForTimeout(6500);
		const st = await bufferState(page);
		// Play makes the audio context even here, so the ring may listen: to silence
		console.log('SILENT-RING ' + JSON.stringify(st.audio));
		const m = await makeMoment(page, 'mp4');
		check(m.row === null, 'the Scene sound row is not offered for a silent moment');
		check(!!m.card && !m.card.sound && !/with sound/.test(m.card.text || ''), `the result says nothing about sound (${JSON.stringify(m.card?.sound)})`);
		const d = await demux(/** @type {Uint8Array} */ (m.bytes));
		check(d.video > 2.8 && d.audio === null, `the MP4 is picture only, as before this lane (video ${d.video.toFixed(2)} s, audio track ${d.audio ? 'yes' : 'none'})`);
		await closeMoment(page);
		await A.ctx.close();
	}

	// ---------- 2. the scene's sound in a moment, a voice not ----------
	{
		const A = await h.setupPage(browser, 'B', { audio: true, context: { viewport: { width: 1280, height: 800 } } });
		const { page } = A;
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.commandsHandler.sceneCommand('/create sphere'));
		const state = await startTones(page);
		check(state === 'running', `premise: the audio context runs (${state})`);
		await setPlaying(page, true);
		await page.waitForFunction(() => /** @type {any} */ (window).__tp.test.v1.momentBuffer?.state().audio?.listening === true, null, { timeout: 30000 });
		await page.waitForTimeout(7000);
		const st = await bufferState(page);
		console.log('SOUND-RING ' + JSON.stringify(st.audio));
		check(st.audio.listening && st.audio.span >= 6 && st.audio.span <= 12.5, `the sound ring runs beside the frames (${st.audio.path}, ${st.audio.span.toFixed(2)} s kept at ${st.audio.rate} Hz)`);
		check(st.cost.mean <= 1, `the frame cost stays in the 1 ms budget with sound on (${st.cost.mean.toFixed(3)} ms)`);
		const m = await makeMoment(page, 'mp4');
		await shot(page, 'moment-with-sound.png');
		check(!!m.row && m.row.checked && !m.row.disabled && /never voices/.test(m.row.title), `"Scene sound" is offered, on, and its tooltip says no voices (${JSON.stringify(m.row)})`);
		check(!!m.card?.sound && /with sound/.test(m.card.text || ''), `the result card says "with sound" (${m.card?.sound})`);
		keep('moment-with-sound.mp4', /** @type {Uint8Array} */ (m.bytes));
		const d = /** @type {any} */ (await demux(/** @type {Uint8Array} */ (m.bytes)));
		check(!!d.audio && Math.abs(d.audio.duration - 3) < 0.2 && Math.abs(d.video - 3) < 0.2, `the MP4 carries an audio track as long as the picture (${d.audio?.codec}, audio ${d.audio?.duration?.toFixed(2)} s, video ${d.video.toFixed(2)} s)`);
		if (d.audio) {
			const t = await tonesIn(page, d.audio);
			console.log('SOUND-TONES-MOMENT ' + JSON.stringify(t));
			check(t.scene > 1e-4 && t.peak > 0.05, `decoded, the scene's 440 Hz tone is in it (power ${t.scene.toExponential(2)}, peak ${t.peak.toFixed(2)})`);
			check(t.voice < t.scene / 100, `and the VOICE bus's 1250 Hz tone is not (power ${t.voice.toExponential(2)}, ${(t.scene / Math.max(t.voice, 1e-12)).toExponential(1)}x below the scene)`);
		}
		await closeMoment(page);
		await page.waitForTimeout(500);

		// ---------- 3. the option off, and GIF ----------
		const off = await makeMoment(page, 'mp4', false);
		const dOff = await demux(/** @type {Uint8Array} */ (off.bytes));
		check(dOff.video > 2.8 && dOff.audio === null && !off.card?.sound, `"Scene sound" off: the MP4 has no audio track (audio ${dOff.audio ? 'yes' : 'none'})`);
		await closeMoment(page);
		await page.waitForTimeout(500);
		const gif = await makeMoment(page, 'gif');
		check(!!gif.row && gif.row.disabled && /GIF has no sound/.test(gif.row.title), `GIF: the option is disabled with the reason (${gif.row?.title})`);
		await closeMoment(page);
		await stopTones(page);
		await setPlaying(page, false);
		await A.ctx.close();
	}

	// ---------- 4. the live recorder (no WebCodecs) ----------
	{
		const A = await h.setupPage(browser, 'C', {
			audio: true,
			context: { viewport: { width: 1280, height: 800 } },
			init: () => {
				delete (/** @type {any} */ (window).VideoEncoder);
				delete (/** @type {any} */ (window).VideoFrame);
			}
		});
		const { page } = A;
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.commandsHandler.sceneCommand('/create box'));
		await page.waitForTimeout(800);
		await startTones(page);
		/** record a 2 s turntable through the dialog @param {boolean} sound */
		const take = async (sound) => {
			await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.viewportMenu.set({ x: 200, y: 160, point: { x: 0, y: 0, z: 0 } }));
			await page.locator('[role="menuitem"]', { hasText: /^\s*Tools/ }).first().hover();
			await page.locator('[role="menuitem"]', { hasText: /^\s*Recording…\s*$/ }).first().click();
			await page.waitForSelector('#recording-dialog', { timeout: 10000 });
			if (await page.$('#recording-again')) {
				await page.click('#recording-again');
				await page.waitForSelector('#recording-start', { timeout: 5000 });
			}
			await page.click('#recording-mode-turntable');
			await page.selectOption('#recording-resolution', '480p');
			await page.fill('#recording-duration', '2');
			await page.locator('#recording-duration').dispatchEvent('change');
			const box = page.locator('#recording-sound');
			if ((await box.isChecked()) !== sound) await box.click();
			const title = await page.evaluate(() => document.querySelector('#recording-sound')?.closest('label')?.getAttribute('title') ?? '');
			if (sound) await shot(page, 'recording-dialog-sound.png');
			await page.click('#recording-start');
			await page.waitForSelector('#recording-result', { timeout: 60000 });
			const card = await page.evaluate(() => {
				const c = /** @type {any} */ (document.querySelector('#recording-result'));
				return { sound: c.dataset.sound, mime: c.dataset.mime, text: c.textContent };
			});
			return { title, card, bytes: await fileOf(page, '#recording-video') };
		};
		const on = await take(true);
		check(/never voices/.test(on.title), 'the Recording dialog\'s "Scene sound" tooltip says no voices or microphone');
		check(on.card.sound === 'opus' && /with sound/.test(on.card.text), `a live take with sound is WebM + Opus and says so (${on.card.mime}, ${on.card.sound})`);
		keep('live-with-sound.webm', /** @type {Uint8Array} */ (on.bytes));
		const dOn = /** @type {any} */ (await demux(/** @type {Uint8Array} */ (on.bytes)));
		check(!!dOn.audio && dOn.audio.codec === 'opus', `the webm has an Opus track (${dOn.audio?.codec}, ${dOn.audio?.duration?.toFixed(2)} s)`);
		if (dOn.audio) {
			const t = await tonesIn(page, dOn.audio);
			console.log('SOUND-TONES-LIVE ' + JSON.stringify(t));
			check(t.scene > 1e-4, `decoded, the scene's 440 Hz tone is in it (power ${t.scene.toExponential(2)})`);
			check(t.voice < t.scene / 100, `and the voice tone is not (${t.voice.toExponential(2)})`);
		}
		await page.click('#recording-again').catch(() => {});
		await page.keyboard.press('Escape').catch(() => {});
		await page.waitForTimeout(300);
		const off = await take(false);
		const dOff = await demux(/** @type {Uint8Array} */ (off.bytes));
		check(!off.card.sound && dOff.audio === null && /codecs=vp|webm/.test(off.card.mime), `the option off: no audio track (${off.card.mime})`);
		await stopTones(page);
		await A.ctx.close();
	}

	// ---------- 5. the frame-exact export (row 2): the timeline's sound on the file's clock ----------
	{
		const A = await h.setupPage(browser, 'D', { audio: true, context: { viewport: { width: 1280, height: 800 } } });
		const { page } = A;
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.commandsHandler.sceneCommand('/create box'));
		await page.waitForTimeout(800);
		// zero change first: a timeline with no sound exports a picture-only MP4
		const silentId = await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.sequences.createSequence('Quiet', { duration: 1 }));
		const quiet = await exportFile(page, { mode: 'timeline', sequence: silentId, format: 'mp4', resolution: '480p', fps: 30, duration: 1, sound: true });
		const dq = quiet.bytes ? await demux(quiet.bytes) : null;
		check(!!dq && dq.audio === null && !quiet.sound, `a timeline with no sound: the MP4 is picture only (${quiet.error || (dq?.audio ? 'audio track' : 'no audio track')})`);
		// a 3 s timeline whose audio track plays a 660 Hz clip from 1.0 to 2.0 s
		const hash = await importTone(page, 1.5);
		const id = await page.evaluate((hash) => {
			const sq = /** @type {any} */ (window).__tp.test.v1.sequences;
			const id = sq.createSequence('Beep', { duration: 3 });
			const track = sq.addTrack(id, 'audio');
			sq.addItem(id, track, { t: 1, dur: 1, sound: hash, name: 'tone', gain: 1 });
			return id;
		}, hash);
		const t0 = Date.now();
		const tl = await exportFile(page, { mode: 'timeline', sequence: id, format: 'mp4', resolution: '480p', fps: 30, duration: 3, sound: true });
		check(!tl.error && !!tl.sound, `the timeline exports with sound (${tl.sound || tl.error}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
		if (tl.bytes) {
			keep('timeline-with-sound.mp4', tl.bytes);
			const d = /** @type {any} */ (await demux(tl.bytes));
			const input = new Input({ source: new BufferSource(tl.bytes), formats: ALL_FORMATS });
			const stats = await (await input.getPrimaryVideoTrack())?.computePacketStats();
			check(stats?.packetCount === 90 && !!d.audio && Math.abs(d.audio.duration - 3) < 0.1, `still EXACTLY 90 frames, and an audio track as long (${stats?.packetCount} frames, ${d.audio?.codec} ${d.audio?.duration?.toFixed(2)} s)`);
			if (d.audio) {
				const before = await tonesIn(page, d.audio, [0.1, 0.9]);
				const during = await tonesIn(page, d.audio, [1.1, 1.9]);
				const after = await tonesIn(page, d.audio, [2.1, 2.9]);
				console.log('SOUND-TIMELINE ' + JSON.stringify({ before: before.file, during: during.file, after: after.file }));
				check(during.file > 1e-3 && during.file > before.file * 1000 && during.file > after.file * 1000, `the clip sounds exactly in its window, 1-2 s (power before ${before.file.toExponential(1)}, during ${during.file.toExponential(1)}, after ${after.file.toExponential(1)})`);
			}
		}
		// the option off: no track
		const off = await exportFile(page, { mode: 'timeline', sequence: id, format: 'mp4', resolution: '480p', fps: 30, duration: 3, sound: false });
		const doff = off.bytes ? await demux(off.bytes) : null;
		check(!!doff && doff.audio === null, `"Scene sound" off: the timeline MP4 has no audio track`);
		// the scene's music bed under a turntable
		await page.evaluate((hash) => /** @type {any} */ (window).__tp.test.v1.sceneMusic.setMusicTrack(hash, 'tone660.wav'), hash);
		await page.waitForTimeout(1500);
		const tt = await exportFile(page, { mode: 'turntable', target: 'scene', format: 'webm', resolution: '480p', fps: 30, duration: 2, sound: true });
		const dt = /** @type {any} */ (tt.bytes ? await demux(tt.bytes) : null);
		check(!!dt?.audio && dt.audio.codec === 'opus' && Math.abs(dt.audio.duration - 2) < 0.1, `a turntable WebM carries the scene's music (${dt?.audio?.codec} ${dt?.audio?.duration?.toFixed(2)} s) ${tt.error || ''}`);
		if (dt?.audio) {
			const t = await tonesIn(page, dt.audio);
			check(t.file > 1e-3, `decoded, the music is in it all the way (660 Hz power ${t.file.toExponential(1)})`);
		}
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.sceneMusic.setMusicTrack(null));
		await A.ctx.close();
	}
	await browser.close();
});
