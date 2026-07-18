// Phase 54: VR push-to-talk logic (headless, fake mic): A-button hold path
// transmits to a peer, mic mode cycles PTT -> Open -> Off, off blocks PTT.
const h = require('./helpers.cjs');

const voice = (page, key) =>
	page.evaluate(
		(key) => new Promise((r) => window.__stores.voiceChat[key].subscribe(r)()),
		key
	);

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
	});
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// A-button hold (setPttHeld is the exact handler the VR loop calls)
	await A.page.evaluate(() => window.__stores.voiceChat.setPttHeld(true));
	await h.eventually(() => voice(A.page, 'pttActive'), (v) => v === true, 'PTT hold transmits');
	await h.eventually(
		() =>
			B.page.evaluate(
				() =>
					new Promise((r) =>
						window.__stores.voiceChat.remoteStreams.subscribe((m) => r(Object.keys(m).length))()
					)
			),
		(n) => n >= 1,
		'peer receives the voice stream'
	);
	await A.page.evaluate(() => window.__stores.voiceChat.setPttHeld(false));
	await h.eventually(() => voice(A.page, 'pttActive'), (v) => v === false, 'release stops transmitting');

	// mode cycle: ptt -> open (mic on)
	await A.page.evaluate(() => window.__stores.voiceChat.cycleMicMode());
	await h.eventually(() => voice(A.page, 'vrMicMode'), (m) => m === 'open', 'cycle to Open');
	await h.eventually(() => voice(A.page, 'micActive'), (v) => v === true, 'Open turns the mic on');

	// open -> off (mic off, PTT blocked)
	await A.page.evaluate(() => window.__stores.voiceChat.cycleMicMode());
	await h.eventually(() => voice(A.page, 'vrMicMode'), (m) => m === 'off', 'cycle to Off');
	await h.eventually(() => voice(A.page, 'micActive'), (v) => v === false, 'Off turns the mic off');
	await A.page.evaluate(() => window.__stores.voiceChat.setPttHeld(true));
	await A.page.waitForTimeout(400);
	h.check((await voice(A.page, 'pttActive')) === false, 'PTT blocked while Off');

	// off -> ptt restores the hold behavior
	await A.page.evaluate(() => window.__stores.voiceChat.cycleMicMode());
	await h.eventually(() => voice(A.page, 'vrMicMode'), (m) => m === 'ptt', 'cycle back to PTT');
	await A.page.evaluate(() => window.__stores.voiceChat.setPttHeld(true));
	await h.eventually(() => voice(A.page, 'pttActive'), (v) => v === true, 'PTT works again');
	await A.page.evaluate(() => window.__stores.voiceChat.setPttHeld(false));

	await h.finish(browser);
});
