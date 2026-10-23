// 65 M7 — THE WEBSITE SECTION, as text: the one script (runtime + frames), the snippet a person pastes,
// the demo page and the size report. PURE (strings and numbers), so the suite pins what ships.
//
// The script is self-contained: `(function(s){var D=<data>; <runtime IIFE>; TPHero.mount(D,s)})
// (document.currentScript)`. `document.currentScript` is read synchronously as the script runs, which
// is the only moment it is set — classic, defer and async scripts alike.

/** a page-safe id from a name: lowercase letters, digits and dashes @param {string} name */
export function heroId(name) {
	const slug = String(name || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return 'tp-hero-' + (slug || 'section');
}

/** @param {string} s */
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The data the runtime reads. Frames are base64 (no data: prefix; the runtime adds it with `mime`).
 * @param {{id: string, label: string, w: number, h: number, fps: number, duration: number, trigger: string,
 *   ease: string, smooth: number, fit: string, mime: string, frames: string[]}} d
 */
export function heroData(d) {
	return {
		v: 1,
		id: d.id,
		label: String(d.label || '').slice(0, 200),
		w: d.w,
		h: d.h,
		fps: d.fps,
		duration: d.duration,
		trigger: d.trigger,
		ease: d.ease,
		smooth: d.smooth,
		fit: d.fit,
		mime: d.mime,
		frames: d.frames
	};
}

/** the licence banner every exported script starts with (anime.js is MIT: its notice travels with it) */
export const HERO_BANNER =
	'/*! Website section made with theprototype.app. Includes anime.js v4 (MIT License, (c) Julian Garnier, https://animejs.com) */';

/**
 * The exported script. `runtime` is the bundled IIFE (`var TPHero=...`).
 * @param {string} runtime @param {ReturnType<typeof heroData>} data
 */
export function heroScript(runtime, data) {
	// `</script` inside a JSON string can never occur in base64 or the fields we write, but a label
	// could hold one: escape `<` so the script is also safe to paste INLINE in a page
	const json = JSON.stringify(data).replace(/</g, '\\u003c');
	return `${HERO_BANNER}\n(function(s){var D=${json};\n${runtime.trim()}\n;TPHero.mount(D,s);})(document.currentScript);\n`;
}

/**
 * What a person pastes into their page.
 * @param {string} id @param {string} file the script's file name @param {{w: number, h: number, label: string, trigger: string}} o
 */
export function heroSnippet(id, file, o) {
	const canvas = `<canvas data-tp-hero="${escAttr(id)}" role="img" aria-label="${escAttr(o.label)}" style="display:block;width:100%;aspect-ratio:${o.w} / ${o.h}"></canvas>`;
	const script = `<script src="${escAttr(file)}" defer></script>`;
	if (o.trigger !== 'scroll') return `${canvas}\n${script}\n`;
	// the classic scroll hero: a tall track, the canvas stuck to the top while the track scrolls by
	return (
		`<section data-tp-hero-track style="height:300vh;position:relative">\n` +
		`  <div style="position:sticky;top:0;height:100vh;display:flex;align-items:center">\n` +
		`    ${canvas.replace('aspect-ratio', 'max-height:100vh;aspect-ratio')}\n` +
		`  </div>\n</section>\n${script}\n`
	);
}

/**
 * A plain HTML page showing the section the way a site would (a heading, the section, text after
 * it, enough page to scroll) — what the zip opens to.
 * @param {string} id @param {string} file @param {{w: number, h: number, label: string, trigger: string, title: string}} o
 */
export function heroDemoPage(id, file, o) {
	const how = o.trigger === 'scroll' ? 'Scroll down' : o.trigger === 'hover' ? 'Hover over (or focus) the picture' : 'Click (or press Enter on) the picture';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escAttr(o.title)}</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #0f1115; color: #e8eaed; }
  header, footer { max-width: 760px; margin: 0 auto; padding: 48px 16px; }
  .tp-hero-box { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
  @media (prefers-color-scheme: light) { body { background: #f6f7f9; color: #15171a; } }
</style>
</head>
<body>
<header><h1>${escAttr(o.title)}</h1><p>${how} to play the timeline.</p></header>
<div class="tp-hero-box">
${heroSnippet(id, file, o)}</div>
<footer><p>Made with theprototype.app. Paste the canvas and the script tag above into your own page; the script is the only file it needs.</p></footer>
</body>
</html>
`;
}

/**
 * The size report: what the section costs a visitor.
 * @param {{frameBytes: number[], runtimeBytes: number, scriptBytes: number, gzipBytes: number}} o
 */
export function heroSizeReport(o) {
	const frames = o.frameBytes.length;
	const framesTotal = o.frameBytes.reduce((s, b) => s + b, 0);
	return {
		frames,
		framesBytes: framesTotal,
		averageFrameBytes: frames ? Math.round(framesTotal / frames) : 0,
		largestFrameBytes: frames ? Math.max(...o.frameBytes) : 0,
		runtimeBytes: o.runtimeBytes,
		scriptBytes: o.scriptBytes,
		gzipBytes: o.gzipBytes
	};
}

/** the report as plain text (size-report.txt in the zip) @param {ReturnType<typeof heroSizeReport>} r @param {(b: number) => string} fmt */
export function heroSizeText(r, fmt) {
	return [
		`Script (one file): ${fmt(r.scriptBytes)} — about ${fmt(r.gzipBytes)} gzipped over the network`,
		`Frames: ${r.frames} — ${fmt(r.framesBytes)} in all, ${fmt(r.averageFrameBytes)} on average, ${fmt(r.largestFrameBytes)} the largest`,
		`Player code (with anime.js): ${fmt(r.runtimeBytes)}`,
		'',
		'Smaller: fewer frames (a lower frame rate or a shorter take), a smaller size, or a lower quality.'
	].join('\n');
}
