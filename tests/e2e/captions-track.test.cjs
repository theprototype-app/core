// 77 C1 — CAPTIONS CORE: a caption track in the Timeline, on screen, in files, in a recording.
//
//   1. a Captions track + a cue through the REAL UI (the empty-state button, a double-click on the
//      lane, the inspector's text + speaker fields)
//   2. SCRUB into the cue: #game-captions shows "Speaker: text" in the editor (subtitles are content,
//      no Captions switch needed); outside it, nothing; a muted track shows nothing
//   3. the peer gets the cue (sequence data replicates) and sees it when IT scrubs there
//   4. PREVIEW play: the line comes up when the playhead enters the cue and goes when it leaves
//   5. .vtt IMPORT through the sequence menu ▸ Captions (a real file chooser) → cues on a track named
//      after the file; EXPORT .vtt / .srt hand over files whose cues match
//   6. VR: the head-locked caption strip carries the subtitle (vrGamePanelFrame, synthetic head)
//   7. CAPTION THE SPEECH: an audio clip on the timeline + a (mocked) self-hosted speech server answering
//      verbose_json → a new "Auto captions" track whose cues sit at clip start + segment start; the
//      request carried a 16 kHz WAV, verbose_json and segment timestamps; ONE undo removes the track
//   8. BURN-IN: a short recording with a parked cue paints it into the frames (captionBurnDebug),
//      and with "Burn in captions" off paints nothing
//   9. the phone layout (N6 folded 412 px + unfolded 770 px): the subtitle sits above the touch controls, inside the screen
// Counterfactual: on v1.43.2 there is no caption track kind — step 1 fails (no #timeline-add-caption).
// Run: e2e-slot --dev <lane> 5661 -- env APP_URL=https://localhost:5661/ npm run e2e -- captions-track
// Evidence: CAPTIONS_SHOTS=<dir> writes screenshots.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.CAPTIONS_SHOTS || '';
const shot = async (page, name) => {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
};

const seqs = (page) =>
	page.evaluate(() => {
		let m;
		let a;
		window.__stores.sequences.sequences.subscribe((v) => (m = v))();
		window.__stores.sequences.activeSequence.subscribe((v) => (a = v))();
		return { all: m, active: a };
	});
/** poll `fn` until it returns something truthy (or the time runs out); resolves the last value */
async function until(fn, timeout = 10000) {
	const t0 = Date.now();
	let v = null;
	while (Date.now() - t0 < timeout) {
		v = await fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 300));
	}
	return v;
}
const capText = (page) => page.evaluate(() => [...document.querySelectorAll('#game-captions .caption-sub')].map((e) => e.textContent.trim()));
const capDbg = (page) => page.evaluate(() => window.__stores.captions.captionsDebug());

/** client point of time t on the first lane of `kind` */
async function pointAt(page, t, kind) {
	return page.evaluate(
		({ t, kind }) => {
			const ruler = document.querySelector('#timeline-ruler');
			const r = ruler.getBoundingClientRect();
			const [vs, ve] = ruler.getAttribute('data-view').split(',').map(Number);
			const x = r.left + ((t - vs) / (ve - vs)) * r.width;
			const row = kind ? document.querySelector(`.tl-lane[data-track-kind="${kind}"]`).getBoundingClientRect() : r;
			return { x, y: row.top + row.height / 2 };
		},
		{ t, kind }
	);
}

const VTT = `WEBVTT

00:00:00.500 --> 00:00:01.500
<v Bo>Imported one

00:00:02.000 --> 00:00:03.000
Imported two
`;

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 }, acceptDownloads: true } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await h.connect(A, B);
	const pa = A.page;
	const pb = B.page;

	// ---------- 1. a caption track + a cue through the real UI ----------
	await pa.mouse.click(700, 450);
	await pa.keyboard.press('Escape');
	await pa.keyboard.press('Alt+T');
	await pa.locator('.tl-root').first().waitFor({ state: 'visible', timeout: 10000 });
	await pa.getByRole('button', { name: 'New sequence' }).click();
	let st = await seqs(pa);
	const id = st.active;
	await pa.evaluate((sid) => window.__stores.sequences.updateSequence(sid, { duration: 6 }), id);
	const addBtn = pa.locator('#timeline-add-caption');
	h.check((await addBtn.count()) === 1, '1.1 the empty sequence offers a Captions track');
	await addBtn.click();
	await pa.locator('#timeline-fit').click();
	let p = await pointAt(pa, 1, 'caption');
	await pa.mouse.dblclick(p.x, p.y);
	await pa.waitForTimeout(200);
	await pa.locator('#timeline-item-cue').fill('Hello from the timeline');
	await pa.locator('#timeline-item-cue').press('Enter');
	await pa.locator('#timeline-item-speaker').fill('Ana');
	await pa.locator('#timeline-item-speaker').press('Enter');
	await pa.waitForTimeout(200);
	st = await seqs(pa);
	const capTrack = st.all[id].tracks.find((t) => t.kind === 'caption');
	const cue = capTrack?.items?.[0];
	h.check(!!cue && cue.text === 'Hello from the timeline' && cue.speaker === 'Ana' && Math.abs(cue.t - 1) < 0.1 && cue.dur === 2, `1.2 the cue holds text + speaker at ~1 s for 2 s (${JSON.stringify(cue)})`);
	await pa.evaluate(({ sid, iid }) => window.__stores.sequences.updateItem(sid, iid, { t: 1, dur: 2 }), { sid: id, iid: cue.id });

	// ---------- 2. scrub into the cue ----------
	await pa.evaluate((sid) => window.__stores.sequencePlayer.scrubSequence(sid, 1.5), id);
	await pa.waitForTimeout(300);
	let lines = await capText(pa);
	h.check(lines.length === 1 && lines[0] === 'Ana: Hello from the timeline', `2.1 a scrub into the cue shows "Ana: …" in the editor (${JSON.stringify(lines)})`);
	h.check((await capDbg(pa)).shown === false, '2.2 … with the Accessibility Captions switch OFF (subtitles are content)');
	await shot(pa, '01-subtitle-scrub-dark.png');
	if (SHOTS) {
		await pa.evaluate(() => window.__stores.themes.theme.set('light'));
		await pa.waitForTimeout(300);
		await shot(pa, '01-subtitle-scrub-light.png');
		await pa.evaluate(() => window.__stores.themes.theme.set('dark'));
	}
	await pa.evaluate((sid) => window.__stores.sequencePlayer.scrubSequence(sid, 3.2), id);
	await pa.waitForTimeout(200);
	h.check((await capText(pa)).length === 0, '2.3 outside the cue (3.2 s, end exclusive at 3.0) nothing shows');
	await pa.evaluate(({ sid, tid }) => window.__stores.sequences.updateTrack(sid, tid, { muted: true }), { sid: id, tid: capTrack.id });
	await pa.evaluate((sid) => window.__stores.sequencePlayer.scrubSequence(sid, 1.5), id);
	await pa.waitForTimeout(200);
	h.check((await capText(pa)).length === 0, '2.4 a muted caption track shows nothing');
	await pa.evaluate(({ sid, tid }) => window.__stores.sequences.updateTrack(sid, tid, { muted: false }), { sid: id, tid: capTrack.id });
	await pa.waitForTimeout(200);
	lines = await capText(pa);
	h.check(lines.length === 1, `2.5 unmuting re-reads the parked playhead (no new scrub) (${JSON.stringify(lines)})`);
	// a typed edit under a parked playhead shows at once
	await pa.evaluate(({ sid, iid }) => window.__stores.sequences.updateItem(sid, iid, { text: 'Hello again' }), { sid: id, iid: cue.id });
	await pa.waitForTimeout(200);
	h.check((await capText(pa))[0] === 'Ana: Hello again', '2.6 editing the cue under the parked playhead updates the line');

	// ---------- 3. the peer ----------
	const seen = await until(async () => {
		const sb = await seqs(pb);
		const tr = sb.all[id]?.tracks?.find((t) => t.kind === 'caption');
		return tr?.items?.[0]?.text === 'Hello again' ? tr.items[0] : null;
	}, 10000);
	h.check(!!seen && seen.speaker === 'Ana', '3.1 the peer receives the caption track and its cue');
	await pb.evaluate((sid) => window.__stores.sequencePlayer.scrubSequence(sid, 2), id);
	await pb.waitForTimeout(300);
	lines = await capText(pb);
	h.check(lines[0] === 'Ana: Hello again', `3.2 the peer's own scrub shows it (${JSON.stringify(lines)})`);
	await pb.evaluate(() => window.__stores.sequencePlayer.releaseScrub());

	// ---------- 4. preview play ----------
	await pa.evaluate(() => window.__stores.sequencePlayer.releaseScrub());
	await pa.waitForTimeout(150);
	h.check((await capText(pa)).length === 0, '4.1 releasing the scrub takes the line down');
	await pa.evaluate((sid) => window.__stores.sequencePlayer.playSequence(sid, { mode: 'preview', from: 0 }), id);
	const samples = [];
	const t0 = Date.now();
	while (Date.now() - t0 < 4200) {
		const s = await pa.evaluate((sid) => {
			let m;
			window.__stores.sequencePlayer.seqTransport.subscribe((v) => (m = v))();
			return { t: m[sid]?.t ?? -1, lines: [...document.querySelectorAll('#game-captions .caption-sub')].length };
		}, id);
		samples.push(s);
		await pa.waitForTimeout(100);
	}
	const wrong = samples.filter((s) => s.t > 0.05 && Math.abs(s.t - 1) > 0.15 && Math.abs(s.t - 3) > 0.15 && (s.t >= 1 && s.t < 3 ? s.lines !== 1 : s.lines !== 0));
	h.check(samples.some((s) => s.lines === 1) && samples.some((s) => s.t > 3.2 && s.lines === 0) && wrong.length === 0, `4.2 preview: the line shows exactly while the playhead is inside [1, 3) (${samples.length} samples, ${wrong.length} wrong)`);
	await pa.evaluate((sid) => window.__stores.sequencePlayer.stopSequence(sid), id);

	// ---------- 5. .vtt import + export through the menu ----------
	const openCaptionsMenu = async () => {
			await pa.locator('#timeline-seq-menu').click();
		await pa.locator('[role="menuitem"]', { hasText: /^\s*Captions/ }).first().hover();
		await pa.waitForTimeout(250);
	};
	await openCaptionsMenu();
	const [chooser] = await Promise.all([pa.waitForEvent('filechooser', { timeout: 10000 }), pa.locator('[role="menuitem"]', { hasText: 'Import .srt / .vtt…' }).last().click()]);
	await chooser.setFiles({ name: 'interview.vtt', mimeType: 'text/vtt', buffer: Buffer.from(VTT) });
	const imported = await until(async () => {
		const s = await seqs(pa);
		return s.all[id].tracks.find((t) => t.kind === 'caption' && t.name === 'interview') ?? null;
	}, 8000);
	h.check(!!imported && imported.items.length === 2 && imported.items[0].speaker === 'Bo' && imported.items[0].text === 'Imported one' && imported.items[1].t === 2 && imported.items[1].dur === 1, `5.1 the .vtt lands on a caption track named after the file (${JSON.stringify(imported?.items?.map((i) => [i.t, i.dur, i.text, i.speaker ?? '']))})`);
	await openCaptionsMenu();
	const [dl] = await Promise.all([pa.waitForEvent('download', { timeout: 10000 }), pa.locator('[role="menuitem"]', { hasText: 'Export .vtt' }).last().click()]);
	const vttOut = fs.readFileSync(await dl.path(), 'utf8');
	const parsed = await pa.evaluate((text) => window.__stores.subtitleFormat.parseSubtitles(text), vttOut);
	h.check(dl.suggestedFilename() === 'Sequence.vtt' && vttOut.startsWith('WEBVTT') && parsed.cues.length === 3 && parsed.cues[0].t === 0.5 && parsed.cues[1].speaker === 'Ana' && parsed.cues[1].text === 'Hello again', `5.2 Export .vtt hands over the three cues in time order (${dl.suggestedFilename()}, ${parsed.cues.length})`);
	await openCaptionsMenu();
	const [dl2] = await Promise.all([pa.waitForEvent('download', { timeout: 10000 }), pa.locator('[role="menuitem"]', { hasText: 'Export .srt' }).last().click()]);
	const srtOut = fs.readFileSync(await dl2.path(), 'utf8');
	h.check(/^1\n00:00:00,500 --> 00:00:01,500\nBo: Imported one\n/.test(srtOut) && srtOut.includes('Ana: Hello again'), '5.3 Export .srt numbers the cues with comma timestamps and "Speaker:" lines');

	// ---------- 6. the VR strip ----------
	await pa.evaluate((sid) => window.__stores.sequencePlayer.scrubSequence(sid, 2.5), id);
	await pa.waitForTimeout(200);
	const vr = await pa.evaluate(() => {
		const s = window.__stores;
		const head = { position: new s.THREE.Vector3(0, 1.6, 0), quaternion: new s.THREE.Quaternion() };
		return s.gameKit.vrGamePanel.vrGamePanelFrame({ head, hands: [null, null], force: true }).captions;
	});
	h.check(Array.isArray(vr) && vr.some((l) => l.includes('Hello again')) && vr.some((l) => l.includes('Imported two')), `6.1 the head-locked VR strip carries both live subtitles (${JSON.stringify(vr)})`);
	await pa.evaluate(() => window.__stores.sequencePlayer.releaseScrub());

	// ---------- 7. caption the speech (mocked self-hosted server) ----------
	const sound = await pa.evaluate(async () => {
		const S = window.__stores;
		const rate = 8000;
		const n = 16000; // 2 s
		const buf = new ArrayBuffer(44 + n * 2);
		const v = new DataView(buf);
		const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
		w(0, 'RIFF');
		v.setUint32(4, 36 + n * 2, true);
		w(8, 'WAVE');
		w(12, 'fmt ');
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true);
		v.setUint16(22, 1, true);
		v.setUint32(24, rate, true);
		v.setUint32(28, rate * 2, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		w(36, 'data');
		v.setUint32(40, n * 2, true);
		for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 9000), true);
		const item = await S.explorer.addItemFromBytes(buf, 'line.wav');
		return item.hash;
	});
	/** @type {{fields: Record<string, string>, fileType: string, bytes: number}[]} */
	const calls = [];
	await pa.route('https://stt.test/v1/audio/transcriptions', async (route) => {
		const req = route.request();
		const body = req.postDataBuffer()?.toString('latin1') ?? '';
		const fields = {};
		for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) fields[m[1]] = m[2];
		const fileType = /name="file"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)/.exec(body);
		calls.push({ fields, fileType: fileType ? fileType[1] + ' ' + fileType[2] : '', bytes: body.length, wavRate: body.includes('RIFF') ? body.charCodeAt(body.indexOf('RIFF') + 24) | (body.charCodeAt(body.indexOf('RIFF') + 25) << 8) : 0 });
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*' },
			body: JSON.stringify({ text: 'Open the gate. Now!', language: 'english', segments: [{ start: 0.2, end: 1.1, text: ' Open the gate.' }, { start: 1.3, end: 1.9, text: ' Now!' }] })
		});
	});
	await pa.evaluate(
		async ({ sid, hash }) => {
			const S = window.__stores;
			S.aiStt.setSttConfig({ preset: 'custom', baseUrl: 'https://stt.test/v1', apiKey: '', model: 'whisper-1' });
			const tr = S.sequences.addTrack(sid, 'audio');
			S.sequences.addItem(sid, tr, { t: 4, dur: 2, sound: hash, name: 'line.wav' });
			S.sequences.sequenceSelection.set([]);
		},
		{ sid: id, hash: sound }
	);
	await openCaptionsMenu();
	await pa.locator('[role="menuitem"]', { hasText: 'Caption the speech in audio clips' }).last().click();
	const auto = await until(async () => {
		const s = await seqs(pa);
		return s.all[id].tracks.find((t) => t.kind === 'caption' && t.name === 'Auto captions') ?? null;
	}, 20000);
	h.check(!!auto && auto.items.length === 2 && Math.abs(auto.items[0].t - 4.2) < 0.01 && Math.abs(auto.items[0].dur - 0.9) < 0.01 && auto.items[0].text === 'Open the gate.' && auto.items[1].text === 'Now!' && Math.abs(auto.items[1].t - 5.3) < 0.01, `7.1 an "Auto captions" track with the segments at clip start + segment start (${JSON.stringify(auto?.items?.map((i) => [i.t, i.dur, i.text]))})`);
	const call = calls[0];
	h.check(calls.length === 1 && call.fields.response_format === 'verbose_json' && call.fields['timestamp_granularities[]'] === 'segment' && call.fields.model === 'whisper-1' && /speech\.wav audio\/wav/.test(call.fileType) && call.wavRate === 16000, `7.2 one request: verbose_json + segment timestamps + a 16 kHz WAV (${JSON.stringify(call?.fields)} ${call?.fileType} ${call?.wavRate})`);
	await pa.evaluate(() => window.__stores.history.undo());
	await pa.waitForTimeout(300);
	st = await seqs(pa);
	h.check(!st.all[id].tracks.some((t) => t.name === 'Auto captions'), '7.3 one undo removes the whole auto-caption track');
	const onB = await until(async () => !(await seqs(pb)).all[id].tracks.some((t) => t.name === 'Auto captions'), 8000);
	h.check(onB, '7.4 … on the peer too');

	// ---------- 8. burn-in ----------
	await pa.evaluate((sid) => window.__stores.sequencePlayer.scrubSequence(sid, 1.5), id);
	await pa.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await pa.waitForTimeout(600);
	const rec = async (captions) => {
		const started = await pa.evaluate(async (captions) => {
			const S = window.__stores;
			window.__burnBefore = S.captionBurn.captionBurnDebug().frames;
			return S.recording.startRecording({ mode: 'turntable', target: 'scene', resolution: '720p', fps: 30, duration: 1, captions, hideHelpers: true, frame: false });
		}, captions);
		if (!started) console.log('  recording did not start: ' + JSON.stringify(await pa.evaluate(() => { let v; window.__stores.recordingStores.recordingState.subscribe((x) => (v = x))(); return v.error; })));
		await until(() => pa.evaluate(() => !window.__stores.recording.isRecording()), 20000);
		return pa.evaluate(() => ({ ...window.__stores.captionBurn.captionBurnDebug(), before: window.__burnBefore }));
	};
	const on = await rec(true);
	h.check(on.frames - on.before >= 10 && on.rows.join(' ').includes('Ana: Hello again'), `8.1 a 1-s recording burns the parked cue into its frames (${on.frames - on.before} frames, ${JSON.stringify(on.rows)})`);
	const off = await rec(false);
	h.check(off.frames - off.before === 0, `8.2 with "Burn in captions" off nothing is painted (${off.frames - off.before})`);
	// the painted pixels: bright text on a dark backing in the lower band of a black frame
	const px = await pa.evaluate(() => {
		const c = document.createElement('canvas');
		c.width = 1280;
		c.height = 720;
		const g = c.getContext('2d');
		g.fillStyle = '#ff00ff';
		g.fillRect(0, 0, 1280, 720);
		window.__stores.captionBurn.drawCaptionsOnto(g, 1280, 720, ['Burned line']);
		const band = g.getImageData(400, 560, 480, 100).data;
		let white = 0;
		let dark = 0;
		for (let i = 0; i < band.length; i += 4) {
			if (band[i] > 230 && band[i + 1] > 230 && band[i + 2] > 230) white++;
			// the backing is 86 % opaque, so over magenta it reads ~(44, 10, 51)
			if (band[i] < 80 && band[i + 1] < 40 && band[i + 2] < 80) dark++;
		}
		return { white, dark, top: [...g.getImageData(640, 100, 1, 1).data] };
	});
	h.check(px.white > 200 && px.dark > 2000 && px.top[0] === 255 && px.top[1] === 0, `8.3 drawCaptionsOnto paints white text on a dark backing low in the frame, nothing at the top (${px.white} white, ${px.dark} dark)`);
	await pa.evaluate(() => window.__stores.sequencePlayer.releaseScrub());

	// ---------- 9. the phone layout (N6 folded + unfolded) ----------
	// B's work is done; a third booting page on a loaded slot takes 50-90 s, so free it first
	await h.closePeer(B);
	const P = await h.setupPageQuiet(browser, 'P', [A], { context: { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6 } });
	await h.answerRestore(P).catch(() => false);
	await P.page.evaluate(() => {
		const S = window.__stores;
		const id = S.sequences.createSequence('Phone');
		const tr = S.sequences.addTrack(id, 'caption');
		S.sequences.addItem(id, tr, { t: 0, dur: 5, text: 'A fairly long subtitle line that has to wrap on a folded phone screen', speaker: 'Ana' });
		S.sequencePlayer.scrubSequence(id, 1);
	});
	for (const [label, vp, n] of [['folded', { width: 412, height: 915 }, '9.1'], ['unfolded', { width: 770, height: 850 }, '9.2']]) {
		await P.page.setViewportSize(vp);
		await P.page.waitForTimeout(400);
		const box = await P.page.evaluate(() => {
			const el = document.querySelector('#game-captions');
			const r = el?.getBoundingClientRect();
			return r ? { left: r.left, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth } : null;
		});
		h.check(!!box && box.left >= 0 && box.right <= box.w && box.bottom <= box.h - 100 && box.scroll <= box.w, `${n} phone ${label} (${vp.width} px): the subtitle wraps inside the screen, clear of the bottom controls (${JSON.stringify(box)})`);
		await shot(P.page, `02-subtitle-phone-${label}.png`);
	}

	await h.finish(browser);
});
