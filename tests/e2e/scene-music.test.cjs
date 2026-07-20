// M-1: scene music singleton — a shared background track syncs latest-wins as a
// separate `music` message, late joiners pull the bytes by hash and converge on
// the same startedAt (synced phase), and stop replicates. Audible output isn't
// asserted headlessly; state + graph flags are.
const h = require('./helpers.cjs');

// a valid 1s mono 16-bit 8kHz WAV of silence (decodeAudioData can parse it)
function wav() {
	const rate = 8000, secs = 1, n = rate * secs;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
	buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
	buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
	return Array.from(new Uint8Array(buf));
}

const musicOf = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.sceneMusic.music.subscribe((m) => r(m))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// A stores a track in its Explorer library and sets it as the scene music
	const hash = await A.page.evaluate(async (bytes) => {
		const buf = new Uint8Array(bytes).buffer;
		const item = await window.__stores.explorer.addItemFromBytes(buf, 'loop.wav', null);
		window.__stores.sceneMusic.setMusicTrack(item.hash, 'loop.wav');
		return item.hash;
	}, wav());
	h.check(!!hash, 'A stored a track and set it as scene music');

	// the music state replicates to B (hash/playing/startedAt)
	await h.eventually(() => musicOf(B.page), (m) => m.hash === hash && m.playing === true, 'music state replicated to B');
	const a = await musicOf(A.page);
	const b = await musicOf(B.page);
	h.check(a.startedAt === b.startedAt && a.startedAt > 0, `both peers share the startedAt phase anchor (${a.startedAt})`);

	// B pulls the bytes by hash into the Shared folder (assetShare) and decodes
	await B.page.waitForTimeout(2500);
	const bPulled = await B.page.evaluate(
		(hash) =>
			new Promise((r) =>
				window.__stores.explorer.explorerItems.subscribe((list) => r(list.some((i) => i.hash === hash)))()
			),
		hash
	);
	h.check(bPulled === true, 'B pulled the shared track by hash');
	const bDebug = await B.page.evaluate(() => window.__stores.sceneMusic.musicDebug());
	h.check(bDebug.buffered === true, 'B decoded the track (playback graph built)');
	h.check(bDebug.offset >= 0 && bDebug.offset < 1.001, `B computes a synced-clock loop offset (${bDebug.offset.toFixed(3)})`);

	// local mute/volume are per-device and don't touch the shared state
	await B.page.evaluate(() => window.__stores.sceneMusic.musicMuted.set(true));
	const afterMute = await musicOf(A.page);
	h.check(afterMute.playing === true, "B's local mute does not stop A's shared playback");

	// stop on A replicates to B
	await A.page.evaluate(() => window.__stores.sceneMusic.setMusicPlaying(false));
	await h.eventually(() => musicOf(B.page), (m) => m.playing === false, 'stop replicated to B');

	await h.finish(browser);
});
