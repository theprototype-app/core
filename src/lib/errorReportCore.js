// 48 O1 — ERROR REPORTS, the pure half (a LEAF: imports nothing). What a crash report may
// say about the person who had it is decided HERE, in functions a unit test can hold to the
// rule, so the runtime half (errorReports.js) only gathers and sends.
//
// THE RULE (roadmap 48 decisions, "On, with opt-out"): anonymous — no IP (the Worker never
// stores one), no account id, no peer id, no scene content. A report carries a SCRUBBED
// message, the top frames of OUR OWN code, the release, a device class, the browser and OS
// family + major version, the graphics API, the app area and the kind. Nothing else.
//
// Scrubbing is a DENY-BY-SHAPE pass, not an allow-list of messages: anything that looks like
// a URL, a path, an email, an id, a long number or a quoted phrase is replaced by a token, so
// a scene name, a file name or a peer id inside an error message never leaves the device. A
// quoted IDENTIFIER survives (`reading 'position'` is what makes a TypeError useful); a quoted
// phrase with a space or punctuation does not ("My house" becomes '…').

/** the kinds a report can be */
export const ERROR_KINDS = /** @type {const} */ (['error', 'rejection', 'webgl', 'oom', 'crash']);
/** at most this many reports leave one tab session */
export const MAX_PER_SESSION = 5;
/** the scrubbed message is cut to this */
export const MAX_MESSAGE = 200;
/** at most this many of our own frames ride a report */
export const MAX_FRAMES = 5;
/** the serialized report is never larger than this (the Worker refuses anything bigger) */
export const MAX_REPORT_BYTES = 2048;

/** messages that are noise, not bugs (the browser's own benign warnings, aborted media) */
const IGNORE = [
	/^ResizeObserver loop/i,
	/^Script error\.?$/i,
	/The play\(\) request was interrupted/i,
	/The operation was aborted/i,
	/^AbortError\b/i
];

/** `true` when the message is noise we never report @param {string} message */
export function ignoredMessage(message) {
	const m = String(message ?? '').trim();
	return !m || IGNORE.some((re) => re.test(m));
}

/** an out-of-memory failure, whatever the engine calls it @param {string} message */
export function looksLikeOom(message) {
	return /out of memory|allocation failed|Array buffer allocation|Cannot allocate|insufficient memory|GL_OUT_OF_MEMORY|OOM\b/i.test(String(message ?? ''));
}

/**
 * Scrub a message down to its SHAPE. Pure.
 * @param {string} message @returns {string}
 */
export function scrubMessage(message) {
	let m = String(message ?? '');
	// URLs (any scheme, incl. blob:/data:) before paths, so a URL's path is not tokenised twice
	m = m.replace(/\b(?:[a-z][a-z0-9+.-]*:)\/\/[^\s'"`)<>]+/gi, '<url>');
	m = m.replace(/\b(?:blob|data):[^\s'"`)<>]+/gi, '<url>');
	m = m.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>');
	// file paths: /a/b, C:\a\b, ~/a
	m = m.replace(/(?:[A-Za-z]:\\|~\/|\/)(?:[^\s'"`/\\]+[/\\])+[^\s'"`/\\)]*/g, '<path>');
	// uuids and long hex/base36 ids (peer ids, hashes, record ids)
	m = m.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
	// a lowercase token of 12+ with 3+ digits (PocketBase / base36 ids) — `Float32Array` survives
	m = m.replace(/\b(?=(?:[a-z]*\d){3})[a-z0-9]{12,}\b/g, '<id>');
	m = m.replace(/\b[0-9a-f]{8,}\b/gi, '<id>');
	// quoted text: an identifier survives, anything else is someone's words
	// (one quote character at a time: an apostrophe INSIDE a double-quoted name must not end it)
	for (const q of ['"', '`', "'"]) {
		m = m.replace(new RegExp(q + '([^' + q + ']*)' + q, 'g'), (_all, inner) => (/^[A-Za-z_$][\w$.-]{0,40}$/.test(inner) ? q + inner + q : q + '…' + q));
	}
	// numbers with 3+ digits (sizes, counts, coordinates — they split one bug into many)
	m = m.replace(/\b\d{3,}(?:\.\d+)?\b/g, '<n>');
	m = m.replace(/\s+/g, ' ').trim();
	return m.length > MAX_MESSAGE ? m.slice(0, MAX_MESSAGE - 1) + '…' : m;
}

/**
 * The frames of OUR code in a stack, top first, as `fn@/path:line:col` with the origin and any
 * query stripped. A frame from another origin (an extension, a CDN script) is left out — it is
 * neither ours to fix nor ours to send. Pure.
 * @param {string | undefined} stack @param {string} origin e.g. `https://theprototype.app`
 * @returns {string[]}
 */
export function ownFrames(stack, origin) {
	if (!stack) return [];
	/** @type {string[]} */
	const out = [];
	const o = String(origin || '');
	for (const raw of String(stack).split('\n')) {
		const line = raw.trim();
		// V8 "at fn (url:l:c)" / "at url:l:c" · SpiderMonkey/JSC "fn@url:l:c"
		const m = line.match(/^(?:at\s+)?(?:(.*?)\s*\(|(.*?)@)?((?:https?|blob):\/\/[^\s)]+?|\/[^\s)]+?):(\d+):(\d+)\)?$/);
		if (!m) continue;
		let url = m[3];
		if (url.startsWith('blob:')) continue; // a module loaded from a blob is user code, not ours
		if (/^https?:\/\//.test(url)) {
			if (!o || !url.startsWith(o + '/')) continue;
			url = url.slice(o.length);
		}
		url = url.replace(/[?#].*$/, '');
		const fn = String(m[1] ?? m[2] ?? '').replace(/^async\s+/, '').replace(/[^\w$.<>]/g, '').slice(0, 40);
		out.push((fn ? fn + '@' : '') + url + ':' + m[4] + ':' + m[5]);
		if (out.length >= MAX_FRAMES) break;
	}
	return out;
}

/** FNV-1a, 32 bit, as 8 hex digits — stable across engines @param {string} s */
export function fnv1a(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * The grouping key: kind + scrubbed message + the top frame with its column dropped (a
 * minified line can shift columns between builds of one release; the line and file do not).
 * @param {{kind: string, msg: string, frames: string[]}} r
 */
export function signatureOf(r) {
	const top = (r.frames[0] || '').replace(/:\d+$/, '');
	return fnv1a(r.kind + '|' + r.msg + '|' + top);
}

/**
 * Browser + OS family and MAJOR version from a user agent (and, when the browser gives them,
 * the UA-CH brands). Never the full string. Pure.
 * @param {string} ua @param {{brand: string, version: string}[]} [brands]
 * @returns {{browser: string, os: string}}
 */
export function browserOf(ua, brands) {
	const u = String(ua || '');
	/** @param {RegExp} re */
	const major = (re) => {
		const m = u.match(re);
		return m ? m[1] : '';
	};
	let browser = 'other';
	if (/OculusBrowser\//.test(u)) browser = 'oculus ' + major(/OculusBrowser\/(\d+)/);
	else if (/SamsungBrowser\//.test(u)) browser = 'samsung ' + major(/SamsungBrowser\/(\d+)/);
	else if (/Edg\//.test(u)) browser = 'edge ' + major(/Edg\/(\d+)/);
	else if (/Firefox\//.test(u)) browser = 'firefox ' + major(/Firefox\/(\d+)/);
	else if (/(?:Chrome|CriOS)\//.test(u)) browser = 'chrome ' + major(/(?:Chrome|CriOS)\/(\d+)/);
	else if (/Version\/\d+.*Safari\//.test(u)) browser = 'safari ' + major(/Version\/(\d+)/);
	if (browser === 'other' && Array.isArray(brands)) {
		const b = brands.find((x) => /Chrom|Edge|Opera/i.test(x?.brand ?? '') && !/Not.?A.?Brand/i.test(x.brand));
		if (b) browser = String(b.brand).toLowerCase().replace(/^google /, '').replace(/\s+/g, '-') + ' ' + String(b.version).split('.')[0];
	}
	let os = 'other';
	if (/Android/.test(u)) os = 'android ' + major(/Android (\d+)/);
	else if (/iPhone|iPad|iPod/.test(u)) os = 'ios ' + major(/OS (\d+)_/);
	else if (/CrOS/.test(u)) os = 'chromeos';
	else if (/Windows/.test(u)) os = 'windows';
	else if (/Mac OS X|Macintosh/.test(u)) os = 'macos';
	else if (/Linux/.test(u)) os = 'linux';
	return { browser: browser.trim(), os: os.trim() };
}

/**
 * The device class: headset, phone, tablet or desktop. Pure.
 * @param {{ua: string, coarse: boolean, minSide: number}} d
 * @returns {'headset' | 'phone' | 'tablet' | 'desktop'}
 */
export function deviceClassOf(d) {
	const ua = String(d?.ua || '');
	if (/OculusBrowser|Quest|Pico|VRShell|Wolvic|Vive/i.test(ua)) return 'headset';
	if (/iPad/.test(ua)) return 'tablet';
	if (d?.coarse || /Mobi|Android|iPhone/.test(ua)) {
		const side = Number(d?.minSide) || 0;
		return side > 0 && side >= 600 && !/Mobi|iPhone/.test(ua) ? 'tablet' : 'phone';
	}
	return 'desktop';
}

/**
 * Where a page is served: the production host, a preview deployment or a developer's machine.
 * Staff look at production by default; previews are counted apart so a release candidate's
 * errors never read as the live app's. Pure.
 * @param {string} hostname @returns {'prod' | 'preview' | 'dev'}
 */
export function envOf(hostname) {
	const h = String(hostname || '').toLowerCase();
	if (h === 'theprototype.app' || h === 'www.theprototype.app' || h === 'theprototype.pages.dev') return 'prod';
	if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return 'dev';
	return 'preview';
}

/**
 * Build one report from what was caught. Returns null when it is not ours to report (noise,
 * another origin's error with none of our frames). Pure.
 * @param {{kind: string, message: string, stack?: string, filename?: string}} caught
 * @param {{origin: string, release: string, build: string, device: string, browser: string, os: string, gpu: string, area: string, env: string}} ctx
 */
export function buildReport(caught, ctx) {
	let kind = ERROR_KINDS.includes(/** @type {any} */ (caught.kind)) ? caught.kind : 'error';
	const raw = String(caught.message ?? '');
	if ((kind === 'error' || kind === 'rejection') && ignoredMessage(raw)) return null;
	if ((kind === 'error' || kind === 'rejection') && looksLikeOom(raw)) kind = 'oom';
	const frames = ownFrames(caught.stack, ctx.origin);
	// an uncaught error thrown from another origin's script (an extension) with none of ours in it
	if (kind === 'error' && !frames.length && caught.filename && ctx.origin && !String(caught.filename).startsWith(ctx.origin)) return null;
	const msg = scrubMessage(raw) || kind;
	const report = {
		v: 1,
		kind,
		msg,
		frames,
		sig: '',
		release: String(ctx.release || '').slice(0, 24),
		build: String(ctx.build || '').slice(0, 12),
		device: ctx.device,
		browser: String(ctx.browser || '').slice(0, 32),
		os: String(ctx.os || '').slice(0, 24),
		gpu: ctx.gpu,
		area: String(ctx.area || '').slice(0, 24),
		env: ctx.env
	};
	report.sig = signatureOf(report);
	// keep under the size cap by dropping frames from the bottom (the top frame is the signal)
	while (JSON.stringify(report).length > MAX_REPORT_BYTES && report.frames.length > 1) report.frames.pop();
	return report;
}
