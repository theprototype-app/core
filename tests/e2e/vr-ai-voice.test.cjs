// 36-vr-ai (plan F2): voice typing for the AI assistant. Settings ▸ AI ▸ Voice typing (three presets,
// persisted); a MOCKED OpenAI-compatible /audio/transcriptions (the multipart shape asserted); the desktop
// AI window's mic puts the transcript in the input WITHOUT sending; the VR panel's mic (a trigger HOLD) and
// the talk binding (36-vr's bindings map) SEND it; voice chat's microphone is shared, not reopened, and
// survives a dictation. Chromium's fake capture device stands in for a microphone; a real one, and the
// feel of holding the button in a headset, are the user's check.
const h = require('./helpers.cjs');

const ev = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const answer = (text) =>
	ev({ choices: [{ delta: { content: text } }] }) + ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';

const store = (page, path) =>
	page.evaluate((p) => {
		let node = window.__stores;
		for (const k of p.split('.')) node = node[k];
		let v;
		node.subscribe((x) => (v = x))();
		return v;
	}, path);

h.run(async () => {
	const browser = await h.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
	const A = await h.setupPage(browser, 'A');
	const origin = new URL(A.page.url()).origin;

	/** every transcription request, as the server saw it */
	const sttCalls = [];
	let sttStatus = 200;
	await A.page.route('**/mock-stt/v1/audio/transcriptions', async (route) => {
		const req = route.request();
		const body = req.postDataBuffer()?.toString('latin1') ?? '';
		sttCalls.push({
			auth: req.headers()['authorization'] ?? null,
			type: req.headers()['content-type'] ?? '',
			fileField: /name="file"; filename="speech\.(webm|ogg|m4a|wav)"/.test(body),
			model: (body.match(/name="model"\r\n\r\n([^\r]*)/) || [])[1] ?? null,
			bytes: body.length
		});
		if (sttStatus !== 200) return route.fulfill({ status: sttStatus, body: 'nope' });
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'make a red cube' }) });
	});
	await A.page.route('**/mock-ai/v1/chat/completions', (route) =>
		route.fulfill({ status: 200, contentType: 'text/event-stream', body: answer('On it.') })
	);
	await A.page.evaluate((o) => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: o + '/mock-ai/v1', apiKey: 'k', model: 'mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	}, origin);

	// --- 1. Settings ▸ AI ▸ Voice typing: the rows, the presets, persistence ---
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('ai');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForSelector('#ai-stt-preset', { state: 'visible', timeout: 10000 });
	const presets = await A.page.$$eval('#ai-stt-preset option', (o) => o.map((x) => x.value));
	h.check(presets.join(',') === 'openai,groq,custom', `three presets, OpenAI first (${presets})`);
	h.check((await A.page.locator('#ai-stt-status').textContent()).includes('Needs an API key'), 'an OpenAI preset with no key says it needs one');
	await A.page.selectOption('#ai-stt-preset', 'groq');
	await A.page.waitForTimeout(200);
	const groq = await A.page.evaluate(() => {
		let v;
		window.__stores.aiStt.sttConfig.subscribe((x) => (v = x))();
		return { cfg: v, saved: JSON.parse(localStorage.getItem('aiStt') || 'null') };
	});
	h.check(groq.cfg.baseUrl === 'https://api.groq.com/openai/v1' && groq.cfg.model === 'whisper-large-v3', 'Groq fills its URL and model');
	h.check(groq.saved?.preset === 'groq', 'the choice is persisted');
	// self-hosted at the mock
	await A.page.selectOption('#ai-stt-preset', 'custom');
	await A.page.fill('#ai-stt-base', origin + '/mock-stt/v1');
	await A.page.locator('#ai-stt-base').dispatchEvent('change');
	await A.page.fill('#ai-stt-key', 'stt-key');
	await A.page.locator('#ai-stt-key').dispatchEvent('change');
	await A.page.waitForTimeout(150);
	h.check((await A.page.locator('#ai-stt-status').textContent()).includes('Ready'), 'self-hosted with a URL reads Ready');
	await A.page.click('#ai-stt-test');
	await A.page.waitForSelector('#ai-stt-test-result', { timeout: 10000 });
	h.check((await A.page.locator('#ai-stt-test-result').textContent()).includes('Connected'), 'Test connection reaches the server');
	const testCall = sttCalls[sttCalls.length - 1];
	h.check(testCall?.fileField && testCall?.model === 'whisper-1' && testCall?.auth === 'Bearer stt-key', `the request is multipart file + model with the bearer key (${JSON.stringify(testCall)})`);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(300);

	// --- 2. the desktop AI window's mic: the transcript lands in the input, nothing is sent ---
	await A.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	await A.page.waitForSelector('#ai-mic', { state: 'visible' });
	const before = (await store(A.page, 'aiAssistant.aiMessages')).length;
	await A.page.click('#ai-mic');
	await A.page.waitForFunction(() => {
		let v;
		window.__stores.sttCapture.dictation.subscribe((x) => (v = x))();
		return v.state === 'recording';
	}, null, { timeout: 8000 });
	h.check((await A.page.getAttribute('#ai-mic', 'aria-pressed')) === 'true', 'the mic shows it is listening');
	await A.page.waitForTimeout(900);
	await A.page.click('#ai-mic');
	await A.page.waitForFunction(() => document.querySelector('#ai-assistant-window input[type=text]')?.value === 'make a red cube', null, { timeout: 10000 });
	h.check(true, 'the transcript lands in the AI window input');
	h.check((await store(A.page, 'aiAssistant.aiMessages')).length === before, 'desktop voice typing does not send (the input stays editable)');
	h.check(sttCalls[sttCalls.length - 1].bytes > 500, `a real recording was uploaded (${sttCalls[sttCalls.length - 1].bytes} bytes)`);
	await A.page.evaluate(() => window.__stores.aiAssistantHidden.set('hidden'));

	// --- 3. VR: the mic button is a trigger HOLD that sends ---
	const pose = () =>
		A.page.evaluate(() => {
			const s = window.__stores;
			const THREE = s.THREE;
			let scene, r;
			s.globalScene.subscribe((v) => (scene = v))();
			s.globalRenderer.subscribe((v) => (r = v))();
			const panel = scene.getObjectByName('vr-ai-panel');
			panel.updateMatrixWorld(true);
			const at = panel.getObjectByName('vrai-mic').getWorldPosition(new THREE.Vector3());
			const c = r.xr.getController(0);
			c.matrixAutoUpdate = true;
			c.position.set(at.x, at.y, at.z + 0.5);
			c.quaternion.identity();
			c.updateMatrixWorld(true);
			return s.vrAiPanel.raycastAi(0);
		});
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('ai'));
	await A.page.waitForTimeout(400);
	h.check((await pose()) === 'ai:mic', 'the ray finds the mic button');
	const vrSent = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const count = get(s.aiAssistant.aiMessages).length;
		const took = s.vrControls.vrModuleTriggerStart(0);
		await new Promise((r) => setTimeout(r, 300));
		const recording = get(s.sttCapture.dictation).state;
		await new Promise((r) => setTimeout(r, 700));
		s.vrControls.vrModuleTriggerEnd(0);
		for (let i = 0; i < 60; i++) {
			if (get(s.aiAssistant.aiMessages).length > count) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		return { took, recording, sent: get(s.aiAssistant.aiMessages).slice(count)[0] };
	});
	h.check(vrSent.took && vrSent.recording === 'recording', 'pressing the mic starts listening');
	h.check(vrSent.sent?.role === 'user' && vrSent.sent?.content === 'make a red cube', `releasing it SENDS the transcript (${vrSent.sent?.content})`);

	// a tap is not speech: nothing is uploaded, nothing sent
	await A.page.waitForFunction(() => {
		let v;
		window.__stores.aiAssistant.aiBusy.subscribe((x) => (v = x))();
		return !v;
	}, null, { timeout: 10000 });
	const tap = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const count = get(s.aiAssistant.aiMessages).length;
		const t0 = performance.now();
		window.__dictLog = [];
		window.__dictOff = s.sttCapture.dictation.subscribe((d) => window.__dictLog.push(Math.round(performance.now() - t0) + ' ' + d.state + ' ' + d.source));
		// press and release in ONE task: a page busy opening the fake mic stretches a 60 ms timer to ~800 ms,
		// which made the "tap" a real hold (measured: held 773 ms)
		const took = s.vrControls.vrModuleTriggerStart(0);
		const ended = s.vrControls.vrModuleTriggerEnd(0);
		for (let i = 0; i < 80; i++) {
			if (get(s.sttCapture.dictation).state === 'idle') break;
			await new Promise((r) => setTimeout(r, 100));
		}
		await new Promise((r) => setTimeout(r, 300));
		return { took, ended, sent: get(s.aiAssistant.aiMessages).length - count, state: get(s.sttCapture.dictation).state, log: window.__dictLog.slice() };
	});
	const callsBeforeTalk = sttCalls.length;
	h.check(tap.sent === 0 && tap.state === 'idle', `a quick tap on the mic sends nothing (${JSON.stringify(tap)})`);

	// --- 4. the talk binding (A by default) dictates while the panel is up; peers hear nothing ---
	const talk = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const count = get(s.aiAssistant.aiMessages).length;
		const label = s.vrAiPanel.talkBindingLabel();
		const claimed = s.vrAiPanel.aiTalkHold(true);
		await new Promise((r) => setTimeout(r, 900));
		const ptt = get(s.voiceChat.pttActive);
		const released = s.vrAiPanel.aiTalkHold(false);
		for (let i = 0; i < 60; i++) {
			if (get(s.aiAssistant.aiMessages).length > count) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const log = window.__dictLog.slice().concat(s.sttCapture.dictationTrace);
		window.__dictOff?.();
		return { label, claimed, released, ptt, sent: get(s.aiAssistant.aiMessages).slice(count)[0]?.content, dictation: get(s.sttCapture.dictation), busy: get(s.aiAssistant.aiBusy), log };
	});
	h.check(talk.claimed && talk.released && talk.sent === 'make a red cube', `holding the talk binding (${talk.label}) dictates and sends (${JSON.stringify(talk)})`);
	h.check(talk.ptt === false, 'push-to-talk to peers stays off while you talk to the AI');
	h.check(sttCalls.length === callsBeforeTalk + 1, 'one dictation = one upload');

	// --- 5. voice chat's mic is shared: dictating borrows it and leaves it running ---
	await A.page.waitForFunction(() => {
		let v;
		window.__stores.aiAssistant.aiBusy.subscribe((x) => (v = x))();
		return !v;
	}, null, { timeout: 10000 });
	const shared = await A.page.evaluate(async () => {
		const s = window.__stores;
		await s.voiceChat.toggleMic(); // open voice chat's own stream
		const opened = s.voiceChat.voiceDebug();
		s.vrAiPanel.aiTalkHold(true);
		await new Promise((r) => setTimeout(r, 700));
		s.vrAiPanel.aiTalkHold(false);
		await new Promise((r) => setTimeout(r, 1500));
		const after = s.voiceChat.voiceDebug();
		await s.voiceChat.toggleMic(); // and give it back
		return { opened, after };
	});
	h.check(shared.opened.stream && shared.after.stream && shared.after.live === shared.opened.live, `voice chat's stream survives a dictation (${JSON.stringify(shared.after)})`);

	// --- 6. no speech provider: the mic says where to set it up and does not listen ---
	const unset = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.aiStt.setSttConfig({ preset: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' });
		const took = s.vrControls.vrModuleTriggerStart(0);
		const state = get(s.sttCapture.dictation).state;
		s.vrControls.vrModuleTriggerEnd(0);
		return { took, state, notice: get(s.vrAiPanel.vrAiNotice), claimed: s.vrAiPanel.aiTalkHold(true) };
	});
	h.check(unset.took && unset.state === 'idle' && /Voice typing/.test(unset.notice), `unconfigured: the press is taken, nothing listens, a note says where (${unset.notice})`);
	h.check(unset.claimed === false, 'unconfigured: the talk binding stays push-to-talk');

	// --- 7. a server refusal is said on the panel ---
	sttStatus = 401;
	const refused = await A.page.evaluate(async (o) => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.aiStt.setSttConfig({ preset: 'custom', baseUrl: o + '/mock-stt/v1', apiKey: 'bad' });
		s.vrAiPanel.vrAiNotice.set(''); // the previous step's note must not answer for this one
		s.vrControls.vrModuleTriggerStart(0);
		await new Promise((r) => setTimeout(r, 700));
		s.vrControls.vrModuleTriggerEnd(0);
		for (let i = 0; i < 40 && !get(s.vrAiPanel.vrAiNotice); i++) await new Promise((r) => setTimeout(r, 100));
		return get(s.vrAiPanel.vrAiNotice);
	}, origin);
	h.check(/Invalid API key/.test(refused), `a 401 from the speech server is shown (${refused})`);

	// --- 8. closing the panel mid-recording drops it (nothing uploaded) ---
	sttStatus = 200;
	const callsBeforeDrop = sttCalls.length;
	const dropped = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.vrAiPanel.aiTalkHold(true);
		await new Promise((r) => setTimeout(r, 500));
		s.vrAiPanelOpen.set(false);
		const state = get(s.sttCapture.dictation).state;
		s.vrAiPanel.aiTalkHold(false);
		await new Promise((r) => setTimeout(r, 600));
		return { state };
	});
	await A.page.waitForTimeout(300);
	h.check(dropped.state === 'idle' && sttCalls.length === callsBeforeDrop, 'closing the panel mid-recording drops it');

	await h.finish(browser);
});
