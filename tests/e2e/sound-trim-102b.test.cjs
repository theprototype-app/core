// 102b-sound (row 3) — TRIM, FADE AND NORMALISE A SOUND in the audio player window, non-destructively.
//
//   1. the window: a library sound's preview has "Trim and fade" (E opens it): a waveform, Start / End,
//      fades, Normalise, Reset. Setting them stores ONE edit on the sound for the scene; the player
//      plays the edit (its duration is the trimmed length); I / O set start / end at the playhead; each
//      change is one undo step; the library file is never changed (same hash, same bytes)
//   2. applied in play and export: the edited buffer is what the scene plays (normalised peak -1 dB),
//      and a timeline export of a clip with the edit has the sound only in the trimmed length
//   3. two peers + reload: B joins and has the edit (handshake), sees A's next change live, and after a
//      reload has it again; the edit rides the scene save (`soundEdits`), an OLD scene (no field) loads
//      unchanged and clears it, and the lane-saved scene is written out for the base-release check
// Evidence: TRIM_SHOTS=<dir> writes screenshots, the export and lane-saved.json there.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } = require('mediabunny');

const { check } = h;
const SHOTS = process.env.TRIM_SHOTS || '';
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
}
/** @param {string} name @param {Uint8Array | string} bytes */
function keep(name, bytes) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	fs.writeFileSync(path.join(SHOTS, name), bytes);
}

/** a `seconds` 660 Hz mono WAV at 22050 Hz, amplitude 0.25 */
function wav(seconds) {
	const rate = 22050;
	const n = Math.round(seconds * rate);
	const buf = Buffer.alloc(44 + n * 2);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write('WAVEfmt ', 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24);
	buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * 8192), 44 + i * 2);
	return [...buf];
}

/** the scene's edit for a sound @param {any} page @param {string} hash */
const editOf = (page, hash) =>
	page.evaluate((hash) => {
		let v = /** @type {any} */ (null);
		/** @type {any} */ (window).__tp.test.v1.soundEdits.soundEdits.subscribe((/** @type {any} */ s) => (v = s))();
		return v.edits[hash] ?? null;
	}, hash);

/** @param {any} page @param {string} id @param {string} value */
async function setField(page, id, value) {
	await page.locator('#' + id).fill(value);
	await page.locator('#' + id).dispatchEvent('change');
	await page.waitForTimeout(250);
}

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true, context: { viewport: { width: 1440, height: 900 } } });
	const { page } = A;
	await page.waitForFunction(() => !!window.__tp?.test.v1?.explorer && !!window.__tp.test.v1.soundEdits, null, { timeout: 30000 });

	// ---------- 1. the window ----------
	const seeded = await page.evaluate(async (bytes) => {
		const e = /** @type {any} */ (window).__tp.test.v1.explorer;
		await e.loadExplorer();
		const item = await e.addItemFromBytes(new Uint8Array(bytes).buffer, 'tone-2s.wav', null);
		const blob = await e.itemBlob(item.id);
		return { id: item.id, hash: item.hash, size: blob.size };
	}, wav(2));
	await page.waitForTimeout(600);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);
	await page.locator(`[data-card-id="${seeded.id}"]`).dblclick();
	await page.waitForSelector('#sound-edit-toggle', { timeout: 10000 });
	const toggleTitle = await page.locator('#sound-edit-toggle').getAttribute('title');
	check(/\(E\)/.test(toggleTitle || '') && /file stays/.test(toggleTitle || ''), `the audio window offers "Trim and fade", with its key and the promise (${toggleTitle})`);
	// E opens it (the window owns its keys)
	// the window takes focus once it has opened and the player has its file: press E after that
	await page
		.waitForFunction(() => /** @type {any} */ (document.querySelector('#image-preview-window audio'))?.duration > 0, null, { timeout: 15000 })
		.catch(() => {});
	await page.waitForTimeout(300);
	await page.locator('#audio-toggle').focus();
	await page.keyboard.press('e');
	const opened = await page
		.waitForSelector('#sound-edit-wave', { timeout: 15000 })
		.then(() => true)
		.catch(() => false);
	if (!opened)
		console.log(
			'TRIM-DIAG ' +
				JSON.stringify(
					await page.evaluate(() => ({
						pressed: document.querySelector('#sound-edit-toggle')?.getAttribute('aria-pressed'),
						panel: /** @type {any} */ (document.querySelector('#sound-edit, .pv-audio-edit'))?.innerText?.slice(0, 200) ?? null,
						active: document.activeElement?.id,
						duration: /** @type {any} */ (document.querySelector('#image-preview-window audio'))?.duration
					}))
				)
		);
	check(opened, 'E opens the trim editor');
	if (!opened) {
		await page.click('#sound-edit-toggle');
		await page.waitForSelector('#sound-edit-wave', { timeout: 15000 });
	}
	await setField(page, 'sound-edit-start', '0.5');
	await setField(page, 'sound-edit-end', '1.5');
	await setField(page, 'sound-edit-fade-in', '0.2');
	await page.click('#sound-edit-normalize');
	await page.waitForTimeout(300);
	const e1 = await editOf(page, seeded.hash);
	check(!!e1 && e1.start === 0.5 && e1.end === 1.5 && e1.fadeIn === 0.2 && e1.normalize === true, `the edit is stored on the sound for the scene (${JSON.stringify(e1)})`);
	await h.eventually(
		() => page.evaluate(() => /** @type {any} */ (document.querySelector('#image-preview-window audio'))?.duration ?? 0),
		(d) => Math.abs(d - 1) < 0.05,
		'the player plays the EDIT: its length is the trimmed 1.0 s',
		10000
	);
	await shot(page, 'trim-editor.png');
	// I / O at the playhead
	await page.evaluate(() => {
		const el = /** @type {any} */ (document.querySelector('#image-preview-window audio'));
		el.currentTime = 0.25;
	});
	await page.locator('#audio-toggle').focus();
	await page.keyboard.press('o');
	await page.waitForTimeout(300);
	const e2 = await editOf(page, seeded.hash);
	// the player plays the edit, so its clock is 0.25 s into the edit = 0.75 s into the file
	check(!!e2 && Math.abs(e2.end - 0.75) < 0.06, `O sets the end at the playhead, in file time (${JSON.stringify(e2)})`);
	// one change = one undo step
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.history.undo());
	await page.waitForTimeout(300);
	const e3 = await editOf(page, seeded.hash);
	check(!!e3 && e3.end === 1.5, `undo takes that one change back (${JSON.stringify(e3)})`);
	const untouched = await page.evaluate(async (s) => {
		const e = /** @type {any} */ (window).__tp.test.v1.explorer;
		const item = e.itemByHash(s.hash);
		const blob = item ? await e.itemBlob(item.id) : null;
		return { same: !!item && item.id === s.id, size: blob?.size ?? 0 };
	}, seeded);
	check(untouched.same && untouched.size === seeded.size, `the library file is untouched: same item, same ${seeded.size} bytes`);

	// ---------- 2. applied in play and export ----------
	const played = await page.evaluate(async (hash) => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		const raw = await S.soundRuntime.sampleBuffer(hash);
		const ed = S.soundEdits.editedBuffer(hash, raw);
		let peak = 0;
		const d = ed.getChannelData(0);
		for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
		return { raw: raw.duration, edited: ed.duration, peak, first: Math.abs(d[0]) };
	}, seeded.hash);
	check(Math.abs(played.raw - 2) < 0.01 && Math.abs(played.edited - 1) < 0.01, `what the scene plays is the edit (${played.raw.toFixed(2)} s file -> ${played.edited.toFixed(2)} s)`);
	check(Math.abs(played.peak - 0.891) < 0.01 && played.first < 0.01, `normalised to -1 dB (peak ${played.peak.toFixed(3)}) and faded in from silence (${played.first.toFixed(4)})`);
	const id = await page.evaluate((hash) => {
		const sq = /** @type {any} */ (window).__tp.test.v1.sequences;
		const id = sq.createSequence('Trimmed', { duration: 2 });
		sq.addItem(id, sq.addTrack(id, 'audio'), { t: 0, dur: 2, sound: hash, name: 'tone' });
		return id;
	}, seeded.hash);
	await page.evaluate((id) => /** @type {any} */ (window).__tp.test.v1.videoExport.startExport({ mode: 'timeline', sequence: id, format: 'webm', resolution: '480p', fps: 30, duration: 2, sound: true }), id);
	await page.waitForFunction(
		() => {
			let s = /** @type {any} */ (null);
			/** @type {any} */ (window).__tp.test.v1.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
			return s.status === 'done' || s.status === 'error';
		},
		null,
		{ timeout: 120000 }
	);
	const file = await page.evaluate(async () => {
		let s = /** @type {any} */ (null);
		/** @type {any} */ (window).__tp.test.v1.recordingStores.recordingState.subscribe((/** @type {any} */ v) => (s = v))();
		if (!s.result) return { error: s.error };
		const buf = new Uint8Array(await s.result.blob.arrayBuffer());
		let b = '';
		for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { b64: btoa(b) };
	});
	check(!file.error, `the timeline exports (${file.error || 'ok'})`);
	if (file.b64) {
		const bytes = new Uint8Array(Buffer.from(file.b64, 'base64'));
		keep('trimmed-export.webm', bytes);
		const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const at = await input.getPrimaryAudioTrack();
		/** @type {any[]} */
		const packets = [];
		if (at) for await (const p of new EncodedPacketSink(at).packets()) packets.push({ ts: p.timestamp, dur: p.duration, key: p.type === 'key', data: Buffer.from(p.data).toString('base64') });
		const cfg = at ? await at.getDecoderConfig() : null;
		const power = at
			? await page.evaluate(
					async ({ packets, cfg }) => {
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
						dec.configure({ codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels, ...(cfg.description ? { description: b64(cfg.description) } : {}) });
						for (const p of packets) dec.decode(new EncodedAudioChunk({ type: p.key ? 'key' : 'delta', timestamp: Math.round(p.ts * 1e6), duration: Math.round(p.dur * 1e6), data: b64(p.data) }));
						await dec.flush();
						const n = parts.reduce((s, p) => s + p.length, 0);
						const pcm = new Float32Array(n);
						let o = 0;
						for (const p of parts) (pcm.set(p, o), (o += p.length));
						const rms = (/** @type {number} */ a, /** @type {number} */ b) => {
							let s = 0;
							const from = Math.floor(a * cfg.sampleRate);
							const to = Math.floor(b * cfg.sampleRate);
							for (let i = from; i < to; i++) s += pcm[i] * pcm[i];
							return Math.sqrt(s / Math.max(1, to - from));
						};
						return { early: rms(0.02, 0.08), body: rms(0.4, 0.9), after: rms(1.15, 1.9) };
					},
					{ packets, cfg: cfg ? { ...cfg, description: cfg.description ? Buffer.from(/** @type {any} */ (cfg.description)).toString('base64') : undefined } : null }
				)
			: null;
		console.log('TRIM-EXPORT ' + JSON.stringify(power));
		check(!!power && power.body > 0.1 && power.after < power.body / 100, `the export plays the edit: sound for the trimmed 1 s, silence after it (rms ${power?.body.toFixed(3)} then ${power?.after.toExponential(1)})`);
		check(!!power && power.early < power.body / 2, `and it fades in (rms ${power?.early.toFixed(3)} in the first 0.1 s)`);
	}

	// ---------- 3. two peers + reload, saves, an old scene ----------
	const B = await h.setupPage(browser, 'B', { audio: true });
	await h.connect(B, A);
	await h.eventually(() => editOf(B.page, seeded.hash), (e) => !!e && e.end === 1.5 && e.normalize === true, 'B joins and has the edit (handshake)', 20000);
	await page.evaluate((hash) => /** @type {any} */ (window).__tp.test.v1.soundEdits.setSoundEdit(hash, { fadeOut: 0.3 }), seeded.hash);
	await h.eventually(() => editOf(B.page, seeded.hash), (e) => !!e && e.fadeOut === 0.3, "B hears A's next change live", 10000);
	await h.freshReload(B);
	await h.answerRestore(B, 'dismiss');
	await h.connect(B, A).catch(() => {});
	await h.eventually(() => editOf(B.page, seeded.hash), (e) => !!e && e.fadeOut === 0.3 && e.start === 0.5, 'after a reload B has the edit again', 30000);
	const saved = await page.evaluate(() => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		S.commandsHandler.sceneCommand('/create box');
		return S.sessions.buildSessionPayload('Trim test');
	});
	check(!!saved.soundEdits && saved.soundEdits[seeded.hash]?.end === 1.5, 'a save carries the edit as `soundEdits`');
	keep('lane-saved.json', JSON.stringify(saved));
	// an OLD scene: no `soundEdits` field
	const old = { ...saved };
	delete old.soundEdits;
	const afterOld = await page.evaluate(async (payload) => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		await S.sessions.applySession(payload, { backup: false });
		let v = /** @type {any} */ (null);
		S.soundEdits.soundEdits.subscribe((/** @type {any} */ s) => (v = s))();
		const again = S.sessions.buildSessionPayload('again');
		return { edits: Object.keys(v.edits).length, field: 'soundEdits' in again, objects: again.objects?.length ?? 0 };
	}, old);
	check(afterOld.edits === 0 && !afterOld.field, `an old scene (no field) loads, clears the edits, and saves without the field (${JSON.stringify(afterOld)})`);
	await h.eventually(() => editOf(B.page, seeded.hash), (e) => e === null, 'and the room follows the load', 15000);
	const back = await page.evaluate(async (payload) => {
		const S = /** @type {any} */ (window).__tp.test.v1;
		await S.sessions.applySession(payload, { backup: false });
		let v = /** @type {any} */ (null);
		S.soundEdits.soundEdits.subscribe((/** @type {any} */ s) => (v = s))();
		return v.edits;
	}, saved);
	check(back[seeded.hash]?.fadeOut === 0.3, 'loading the lane-saved scene brings the edit back');
	await browser.close();
});
