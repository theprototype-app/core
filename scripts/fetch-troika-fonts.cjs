#!/usr/bin/env node
// 49 J4 — THE 3D LABELS' FONT DATA, SELF-HOSTED. troika-three-text (threlte's <Text>) draws
// every in-scene and VR label, and with no `font` set it resolves glyphs through
// unicode-font-resolver, whose data it fetched from cdn.jsdelivr.net at RUN TIME — so labels
// broke offline or behind a blocker, and a failed fetch surfaced as an uncaught page error
// (48 G1, R40 "Failed to fetch"). `src/lib/troikaFonts.js` points troika at this copy instead.
//
// What is copied: the Noto Sans 400 subsets for the scripts this app's labels and its users'
// names are mostly written in (FONTS below), their font-meta, and exactly the codepoint-index
// blocks those fonts cover. A glyph outside them (CJK, emoji, …) makes the resolver find a
// missing file here, log one console error and carry on from its own CDN for the rest of the
// session — what every label did before, now only for the rare glyph.
//
// 64 D2 — TEXT ON A PATH picks a family from a short list (src/lib/textPathCore.js TEXT_FONTS):
// the families the interface already ships, as WOFF copies under static/fonts/text/ (troika
// cannot read the interface's WOFF2). Same OFL licences as the WOFF2 beside them.
//
//   node scripts/fetch-troika-fonts.cjs      (rewrites static/fonts/unicode-font-resolver/ + static/fonts/text/)
const fs = require('fs');
const path = require('path');

/** the data release troika 0.52's bundled client reads (its own default dataUrl) */
const SOURCE = 'https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data';
const OUT = path.join(__dirname, '..', 'static', 'fonts', 'unicode-font-resolver');
/** latin/European text, plus symbols-2 for the VR panels' ✕ ✓ ✗ ▸ ▾ ● ▏ */
const FONTS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese', 'symbols-2'];
/** the only typeform troika asks for: no label sets a weight, a style or a category */
const FILE = 'sans-serif.normal.400.woff';

/** 64 D2: the text-on-a-path families (@fontsource, pinned) */
const TEXT_SOURCE = 'https://cdn.jsdelivr.net/npm';
const TEXT_OUT = path.join(__dirname, '..', 'static', 'fonts', 'text');
const TEXT_FONTS = [
	'@fontsource/ibm-plex-sans@5.1.0/files/ibm-plex-sans-latin-400-normal.woff',
	'@fontsource/ibm-plex-mono@5.1.0/files/ibm-plex-mono-latin-500-normal.woff',
	'@fontsource/press-start-2p@5.1.0/files/press-start-2p-latin-400-normal.woff'
];

/** @param {string} rel */
async function get(rel) {
	const res = await fetch(SOURCE + '/' + rel);
	if (!res.ok) throw new Error(rel + ': ' + res.status);
	return Buffer.from(await res.arrayBuffer());
}

/** @param {string} rel @param {Buffer} bytes */
function put(rel, bytes) {
	const file = path.join(OUT, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
}

/** the 256-codepoint index blocks a font-meta `ranges` string touches @param {string} ranges */
function blocksOf(ranges) {
	/** @type {Set<number>} */
	const blocks = new Set();
	for (const part of ranges.replace(/U\+/gi, '').split(/,+/)) {
		if (!part.trim()) continue;
		const [a, b = a] = part.split('-').map((x) => parseInt(x.trim(), 16));
		for (let start = a & ~255; start <= b; start += 256) blocks.add(start);
	}
	return blocks;
}

(async () => {
	fs.rmSync(OUT, { recursive: true, force: true });
	/** @type {Set<number>} */
	const blocks = new Set();
	let bytes = 0;
	for (const id of FONTS) {
		const metaBytes = await get('font-meta/' + id + '.json');
		const meta = JSON.parse(metaBytes.toString('utf8'))[1];
		if (!meta?.typeforms?.['sans-serif']?.normal?.includes(400)) throw new Error(id + ' has no sans-serif normal 400');
		put('font-meta/' + id + '.json', metaBytes);
		const woff = await get('font-files/' + id + '/' + FILE);
		put('font-files/' + id + '/' + FILE, woff);
		bytes += metaBytes.length + woff.length;
		for (const b of blocksOf(meta.ranges)) blocks.add(b);
	}
	for (const start of [...blocks].sort((x, y) => x - y)) {
		const rel = `codepoint-index/plane${start >> 16}/${start.toString(16)}-${(start + 255).toString(16)}.json`;
		const index = await get(rel);
		put(rel, index);
		bytes += index.length;
	}
	put('LICENSE-noto.txt', await get('font-files/LICENSE'));
	put('LICENSE-unicode-font-resolver.txt', await get('LICENSE'));
	console.log(`static/fonts/unicode-font-resolver: ${FONTS.length} fonts, ${blocks.size} index blocks, ${(bytes / 1024).toFixed(0)} KB`);
	fs.rmSync(TEXT_OUT, { recursive: true, force: true });
	fs.mkdirSync(TEXT_OUT, { recursive: true });
	let textBytes = 0;
	for (const rel of TEXT_FONTS) {
		const res = await fetch(TEXT_SOURCE + '/' + rel);
		if (!res.ok) throw new Error(rel + ': ' + res.status);
		const woff = Buffer.from(await res.arrayBuffer());
		fs.writeFileSync(path.join(TEXT_OUT, path.basename(rel)), woff);
		textBytes += woff.length;
	}
	console.log(`static/fonts/text: ${TEXT_FONTS.length} fonts, ${(textBytes / 1024).toFixed(0)} KB`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
