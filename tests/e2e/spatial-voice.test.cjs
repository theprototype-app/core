// Phase 41: spatial voice — panner chain per remote stream, tracks the avatar, toggleable.
const h = require('./helpers.cjs');

const spatial = (page) => page.evaluate(() => window.__stores.voiceChat.spatialDebug());

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
	});
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// B talks (fake mic) -> A receives a stream and builds a spatial chain
	await B.page.evaluate(() => window.__stores.voiceChat.toggleMic());
	await h.eventually(
		() => spatial(A.page),
		(map) => map && Object.keys(map).includes(B.id),
		'spatial chain built for the incoming voice'
	);

	// hidden audio element is the WebAudio feeder: attached but silent
	const volume = await A.page.evaluate(() => document.querySelector('audio')?.volume);
	h.check(volume === 0, `audio element silent in spatial mode (volume ${volume})`);

	// panner follows the peer avatar
	await B.page.evaluate((id) =>
		new Promise((resolve) => {
			window.__stores.peers.subscribe((peer) => {
				peer.send({ type: 'camera', peerId: id, position: [30, 2, 5], rotation: [0, 0, 0] });
				resolve();
			})();
		}),
		B.id
	);
	await h.eventually(
		() => spatial(A.page),
		(map) => map?.[B.id] && Math.abs(map[B.id][0] - 30) < 0.5 && Math.abs(map[B.id][2] - 5) < 0.5,
		'panner tracks the peer avatar position'
	);

	// toggle off -> chain drops, element audible again; toggle on -> rebuilt
	await A.page.evaluate(() => window.__stores.voiceChat.spatialVoice.set(false));
	await h.eventually(
		() => spatial(A.page),
		(map) => Object.keys(map ?? {}).length === 0,
		'disabling spatial voice drops the chains'
	);
	const volumeOff = await A.page.evaluate(() => document.querySelector('audio')?.volume);
	h.check(volumeOff === 1, `audio element audible again (volume ${volumeOff})`);
	await A.page.evaluate(() => window.__stores.voiceChat.spatialVoice.set(true));
	await h.eventually(
		() => spatial(A.page),
		(map) => map && Object.keys(map).includes(B.id),
		're-enabling rebuilds the chain from live streams'
	);

	await h.finish(browser);
});
