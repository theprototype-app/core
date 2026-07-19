// M-2: audio packs + sound-node polish. A .zip pack carrying audio imports
// through the kind-agnostic pack path (stored as an 'audio' Explorer item), the
// default-list `zip` install helper exists, and the Sound node gains a rolloff
// param (default 1).
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');

// a minimal fake WAV (kindOf keys off the .wav extension, not the bytes)
function wavBytes() {
	const b = new Uint8Array(64);
	b.set(strToU8('RIFF'), 0);
	b.set(strToU8('WAVE'), 8);
	return b;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// build a pack .zip (manifest + one audio asset) in Node, import it in-page
	const zip = zipSync({
		'manifest.json': strToU8(
			JSON.stringify({
				id: 'test-audio-pack',
				name: 'Test Audio',
				license: 'CC0-1.0',
				items: [{ file: 'assets/beep.wav', name: 'Beep', license: 'CC0-1.0' }]
			})
		),
		'assets/beep.wav': wavBytes()
	});

	const result = await A.page.evaluate(async (bytes) => {
		const file = new File([new Uint8Array(bytes)], 'test-audio-pack.zip');
		const pack = await window.__stores.packs.importPackZip(file);
		let audioItems = [];
		window.__stores.explorer.explorerItems.subscribe((list) => {
			audioItems = list.filter((i) => i.kind === 'audio').map((i) => i.name);
		})();
		return { packName: pack.name, packSource: pack.source, itemKind: pack.items[0]?.kind, audioItems };
	}, Array.from(zip));

	h.check(result.packName === 'test-audio-pack', `audio pack imported (${result.packName})`);
	h.check(result.itemKind === 'audio', `pack item stored as audio kind (${result.itemKind})`);
	h.check(result.audioItems.includes('beep.wav'), `audio asset landed in the Explorer library (${result.audioItems.join(',')})`);

	// the default-list zip install helper exists (used by the Explorer Install action)
	const helper = await A.page.evaluate(() => typeof window.__stores.packs.installDefaultPackZip);
	h.check(helper === 'function', 'installDefaultPackZip helper is available');

	// Sound node gains a rolloff param, default 1 (used when the palette adds one)
	const rolloff = await A.page.evaluate(
		() => window.__stores.nodeCatalog.findNodeSpec('sound')?.defaults?.rolloff
	);
	h.check(rolloff === 1, `Sound node default rolloff is 1 (${rolloff})`);

	await h.finish(browser);
});
