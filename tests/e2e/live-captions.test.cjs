// 77 C3 — LIVE SUBTITLES OF VOICE CHAT, two real peers.
//
//   A = a desktop that can transcribe (a stand-in LOCAL engine registered through the same
//       registry the Captions module uses; it answers "heard <n> s"), B = a speaker wearing a
//       headset (IWER, Quest 3) with no engine at all, talking through Chromium's fake mic.
//   1. election: both peers agree A transcribes (B volunteers nothing — no engine)
//   2. NO CONSENT, NO CAPTURE: B talks with consent off → A listens to nobody, no line anywhere
//   3. B allows it (the real Settings toggle) → the CC marker beside B in A's Users list, A
//      captures B's voice and relays lines: on A's screen ("B: heard …"), on B's own screen,
//      under B's avatar on A, and on B's head-locked VR caption strip (a live IWER session)
//   4. nobody can put words in a mouth: a line about A (who does not consent) sent by B is
//      dropped on A
//   5. B withdraws → A stops listening at once, B's line leaves both screens, no new ones come
// Counterfactual: on v1.43.2 there is no `livecap` message / liveCaptions store — step 1 fails.
// Run: e2e-slot --dev <lane> 5661 -- env APP_URL=https://localhost:5661/ npm run e2e -- live-captions
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const path = require('path');
const fs = require('fs');

const SHOTS = process.env.CAPTIONS_SHOTS || '';

async function until(fn, timeout = 10000, every = 300) {
	const t0 = Date.now();
	let v = null;
	while (Date.now() - t0 < timeout) {
		v = await fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, every));
	}
	return v;
}

const live = (page) => page.evaluate(() => window.__stores.liveCaptions.liveCaptionsDebug());
const capture = (page) => page.evaluate(() => window.__stores.liveCaptionCapture?.liveCaptureDebug() ?? null);
const screenLines = (page) => page.evaluate(() => [...document.querySelectorAll('#game-captions [data-caption-source="live"]')].map((p) => p.textContent.trim()));

h.run(async () => {
	const browser = await h.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...h.AUDIO_ARGS] });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1280, height: 800 } }, init: iwer.initScript() });
	await h.connect(B, A);
	const nameOf = async (page, id) => page.evaluate((id) => { let v; window.__stores.userdata.subscribe((x) => (v = x))(); return v.find((u) => u[0] === id)?.[1] ?? null; }, id);
	// the harness names nobody: the Users list, the overlay and the VR strip all say "Peer" then
	const bName = (await nameOf(A.page, B.id)) || 'Peer';

	// A gets a local engine (the Captions module's seam), B none
	await A.page.evaluate(() => {
		window.__liveJobs = [];
		window.__stores.captionEngines.registerCaptionEngine({
			id: 'test-local',
			label: 'Test engine',
			local: true,
			languages: ['en'],
			transcribe: async ({ audio, sampleRate }) => {
				window.__liveJobs.push(audio.length / sampleRate);
				return { segments: [{ start: 0, end: audio.length / sampleRate, text: `heard ${(audio.length / sampleRate).toFixed(1)} s` }] };
			}
		});
	});

	// ---------- 1. election ----------
	const el = await until(async () => {
		const [a, b] = [await live(A.page), await live(B.page)];
		return a.transcriber === A.id && b.transcriber === A.id ? { a, b } : null;
	}, 15000);
	h.check(!!el, `1.1 both peers elect A as the session's transcriber (A: ${JSON.stringify((await live(A.page)).transcriber)}, B: ${JSON.stringify((await live(B.page)).transcriber)}, A id ${A.id})`);
	h.check(el?.a.canTranscribe === true && el?.b.canTranscribe === false, '1.2 A can transcribe (desktop + a local engine); B cannot (no engine)');

	// ---------- 2. no consent, no capture ----------
	await B.page.mouse.click(5, 5);
	await B.page.evaluate(async () => {
		let on;
		window.__stores.voiceChat.micActive.subscribe((x) => (on = x))();
		if (!on) await window.__stores.voiceChat.toggleMic();
	});
	const gotStream = await until(() => A.page.evaluate((id) => { let v; window.__stores.voiceChat.remoteStreams.subscribe((x) => (v = x))(); return !!v[id]; }, B.id), 20000);
	h.check(!!gotStream, '2.0 A receives B\'s voice (fake mic)');
	await A.page.waitForTimeout(2500);
	const quiet = await capture(A.page);
	h.check(!quiet?.running && (quiet?.ears?.length ?? 0) === 0 && (await A.page.evaluate(() => window.__liveJobs.length)) === 0, `2.1 consent OFF: A listens to nobody and transcribes nothing (${JSON.stringify(quiet)})`);
	h.check((await screenLines(A.page)).length === 0 && (await screenLines(B.page)).length === 0, '2.2 … and no live line is on either screen');

	// ---------- 3. B allows it (the real toggle) ----------
	await B.page.evaluate(() => {
		const s = window.__stores;
		s.settingsOpen.set(false);
		s.settingsSection.set('accessibility');
		s.settingsOpen.set(true);
	});
	await B.page.waitForSelector('#live-caption-consent', { timeout: 15000 });
	await B.page.locator('#live-caption-consent').scrollIntoViewIfNeeded();
	if (SHOTS) {
		fs.mkdirSync(SHOTS, { recursive: true });
		for (const theme of ['dark', 'light']) {
			await B.page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
			await B.page.waitForTimeout(250);
			await B.page.locator('#row-live-consent').screenshot({ path: path.join(SHOTS, `06-live-settings-${theme}.png`) }).catch(() => {});
		}
		await B.page.evaluate(() => window.__stores.themes.theme.set('dark'));
	}
	await B.page.locator('#live-caption-consent').click();
	h.check((await live(B.page)).consent === true, '3.0 B presses "Let others caption my voice" in Settings ▸ Accessibility');
	await B.page.evaluate(() => window.__stores.settingsOpen.set(false));
	const cc = await until(async () => {
		await A.page.evaluate(() => document.querySelector('#peers-popover') || document.querySelector('#peers-trigger')?.click());
		await A.page.waitForTimeout(300);
		// A does not consent, so exactly one row — B's — carries the marker
		return A.page.evaluate(() => {
			const rows = [...document.querySelectorAll('#peers-popover .peers-row')];
			const marked = rows.filter((r) => !!r.querySelector('.peer-cc'));
			return marked.length === 1 && !marked[0].textContent.includes('(you)') ? rows.length : null;
		});
	}, 10000, 800);
	h.check(!!cc, `3.1 A's Users list shows CC beside B's row only (${cc} rows)`);
	if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '05-live-cc-marker.png') });
	await A.page.keyboard.press('Escape');
	const heardA = await until(async () => {
		const lines = await screenLines(A.page);
		return lines.find((t) => t.startsWith(bName + ': heard')) ?? null;
	}, 30000, 500);
	const capOn = await capture(A.page);
	h.check(!!heardA, `3.2 A captures B's voice and shows "${heardA}" (${JSON.stringify(capOn)})`);
	const heardB = await until(async () => (await screenLines(B.page)).find((t) => / heard /.test(' ' + t)) ?? null, 15000, 500);
	h.check(!!heardB, `3.3 the relayed line reaches B's own screen ("${heardB}")`);
	const under = await until(() => A.page.evaluate((id) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const g = scene?.getObjectByName(id + '-caption');
		const t = g?.children?.find((c) => typeof c.text === 'string');
		return g ? { text: t?.text ?? null } : null;
	}, B.id), 10000);
	h.check(!!under && /^heard /.test(under.text ?? ''), `3.4 the line hangs at B's avatar in A's world (${JSON.stringify(under)})`);
	const label = await A.page.evaluate((id) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const g = scene?.getObjectByName(id + '-label');
		return g?.children?.find((c) => typeof c.text === 'string')?.text ?? null;
	}, B.id);
	h.check(label === null || /CC$/.test(label), `3.5 B's name label carries the CC marker (${JSON.stringify(label)})`);
	// B in a headset: the live IWER session draws the head-locked strip
	await iwer.enter(B.page);
	const strip = await until(async () => {
		await iwer.frames(B.page, 4);
		return B.page.evaluate(() => {
			const s = window.__stores.gameKit.vrGamePanel.vrGameSurface('vr-game-captions');
			const caps = window.__stores.gameKit.vrGamePanel.vrGamePanelFrame({ hands: [null, null] }).captions;
			return s?.mesh.visible && caps.some((c) => / heard /.test(' ' + c)) ? caps : null;
		});
	}, 15000, 500);
	h.check(!!strip, `3.6 B's VR caption strip (IWER Quest 3, presenting) shows the line (${JSON.stringify(strip)})`);
	await iwer.exit(B.page);

	// ---------- 4. no words in anybody's mouth ----------
	const spoof = await B.page.evaluate((aid) => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		p.send({ type: 'livecap', op: 'line', speaker: aid, text: 'spoofed words', id: 99 });
		return true;
	}, A.id);
	await A.page.waitForTimeout(800);
	h.check(spoof && !(await live(A.page)).lines.some((l) => l.text === 'spoofed words'), '4.1 a line about A (who does not consent) from B is dropped on A');

	// ---------- 5. withdrawal ----------
	await B.page.evaluate(() => window.__stores.liveCaptions.liveCaptionConsent.set(false));
	const stopped = await until(async () => {
		const c = await capture(A.page);
		return c && !c.running && c.ears.length === 0 ? c : null;
	}, 8000);
	h.check(!!stopped, `5.1 A stops listening to B at once (${JSON.stringify(stopped)})`);
	const cleared = await until(async () => ((await screenLines(A.page)).length === 0 && (await screenLines(B.page)).length === 0 ? true : null), 5000);
	h.check(!!cleared, '5.2 B\'s line leaves both screens');
	const jobs = await A.page.evaluate(() => window.__liveJobs.length);
	await A.page.waitForTimeout(3000);
	h.check((await A.page.evaluate(() => window.__liveJobs.length)) === jobs && (await screenLines(A.page)).length === 0, '5.3 nothing new is transcribed or shown afterwards');

	await h.finish(browser);
});
