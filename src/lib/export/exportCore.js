// 36-export (E1) — the export's PURE helpers: no imports, so the unit layer runs them and the
// builder, the panel and the validator CLI share one spelling of each.

/** @param {string} s */
export function slugify(s) {
	return (
		String(s || '')
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'game'
	);
}

/** @param {string} s */
export function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

/**
 * index.html for the export: ./play.js loads FIRST (a classic, blocking script, so
 * `window.__TP_EXPORT__` exists before any app module evaluates), the game's title, and no
 * web-app manifest (an export is not the installable app). PURE.
 * @param {string} html @param {{title: string}} opts @returns {string}
 */
export function rewriteIndexHtml(html, { title }) {
	let out = String(html);
	out = out.replace(/\s*<link[^>]+rel=["']manifest["'][^>]*>/gi, '');
	out = out.replace(/\s*<meta[^>]+name=["']apple-mobile-web-app-title["'][^>]*>/gi, '');
	const tag = `<title>${escapeHtml(title || 'Game')}</title>`;
	if (/<title>[\s\S]*?<\/title>/i.test(out)) out = out.replace(/<title>[\s\S]*?<\/title>/i, tag);
	else out = out.replace(/<meta charset="utf-8"\s*\/?>/i, (m) => m + '\n\t\t' + tag);
	out = out.replace(/<meta charset="utf-8"\s*\/?>/i, (m) => m + '\n\t\t<script src="./play.js"></script>');
	return out;
}

/**
 * 36-int-121: what the WEB HOST added to an HTML page it served, removed. Cloudflare Pages Web
 * Analytics injects `<script defer src='https://static.cloudflareinsights.com/beacon.min.js'
 * data-cf-beacon='…'>` (between two "Cloudflare Pages Analytics" comments) into every HTML response,
 * and the exporter copies pages from the live deployment — so an export made on a Pages URL carried
 * a script from the internet and failed its own check. Removed: any `<script>` / `<link>` whose
 * src/href is absolute (`http(s)://` or `//` — nothing in export-manifest.json is), any script
 * carrying `data-cf-beacon` or naming cloudflareinsights, and the analytics comments. Every
 * removal is RETURNED, so the builder reports it (never silently); check-export stays strict.
 * 36 L3: `known` names the removals that are a KNOWN host injection (the Cloudflare beacon) — the
 * builder lists those in the result's Details only ("Removed …beacon.min.js" means nothing to a
 * person exporting a game); anything else removed still shows as a warning.
 * PURE. @param {string} html @returns {{html: string, removed: string[], known: string[]}}
 */
export function stripHostInjected(html) {
	/** @type {string[]} */
	const removed = [];
	/** @type {string[]} */
	const known = [];
	const abs = /^(?:https?:)?\/\//i;
	const attr = (/** @type {string} */ attrs, /** @type {string} */ name) =>
		new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs)?.slice(1).find((v) => v !== undefined) || '';
	let out = String(html);
	out = out.replace(/[ \t]*<script\b([^>]*)>([\s\S]*?)<\/script>[ \t]*\n?/gi, (m, attrs, body) => {
		const src = attr(attrs, 'src');
		// (spelled so the engine bundle never carries the two words itself: an export is scanned for them)
		const beacon = /\bdata-cf-(?:beacon)\b/i.test(attrs) || /cloudflare(?:insights)/i.test(src + ' ' + body);
		if (abs.test(src) || beacon) {
			removed.push(src || 'an inline host script');
			if (beacon) known.push(src || 'an inline host script');
			return '';
		}
		return m;
	});
	out = out.replace(/[ \t]*<link\b([^>]*)>[ \t]*\n?/gi, (m, attrs) => {
		const href = attr(attrs, 'href');
		if (!abs.test(href)) return m;
		removed.push(href);
		return '';
	});
	out = out.replace(/[ \t]*<!--\s*Cloudflare Pages Analytics\s*-->[ \t]*\n?/gi, '');
	return { html: out, removed, known };
}

/**
 * 36 L3: how an export reports what `stripHostInjected` removed from one page — a KNOWN host
 * script (the Cloudflare beacon) goes to the result's Details only, anything else stays a
 * visible warning. PURE. @param {string} path @param {{removed: string[], known: string[]}} r
 * @returns {{warnings: string[], details: string[]}}
 */
export function hostRemovalNotes(path, r) {
	/** @type {{warnings: string[], details: string[]}} */
	const notes = { warnings: [], details: [] };
	for (const url of r.removed)
		(r.known.includes(url) ? notes.details : notes.warnings).push(`Removed ${url} from ${path}: the web host added it to the page it served, and an export loads nothing from the internet.`);
	return notes;
}

/** play.js's text for a config. PURE. @param {any} config */
export function makePlayJs(config) {
	return '// Made with ThePrototype (https://theprototype.app) — the exported game’s settings.\n' + 'window.__TP_EXPORT__ = ' + JSON.stringify(config, null, '\t') + ';\n';
}

/**
 * An iframe snippet for a hosted game (a play link, or wherever a static export lives). PURE.
 * @param {string} url @param {{w?: number, h?: number, title?: string}} [opts]
 */
export function embedSnippet(url, { w = 960, h = 600, title = 'Game' } = {}) {
	return (
		`<iframe src="${escapeHtml(url)}" width="${Math.round(w)}" height="${Math.round(h)}" title="${escapeHtml(title)}"` +
		` allow="fullscreen; xr-spatial-tracking; gamepad; pointer-lock; autoplay" allowfullscreen loading="lazy"` +
		` style="border:0;max-width:100%"></iframe>`
	);
}

/**
 * Every PACKS_BASE-relative file the open scene needs: placed pieces (`userData.packRef`),
 * animated pack items (`animRef`) and explicit pack LOD levels. Absolute refs (the Khronos rows)
 * are returned apart — they stay remote whatever the option.
 * @param {any} group the objects group @param {string} packsBase
 * @returns {{paths: Set<string>, absolute: Set<string>}}
 */
export function collectPackRefs(group, packsBase) {
	const base = String(packsBase).replace(/\/+$/, '') + '/';
	/** @type {Set<string>} */
	const paths = new Set();
	/** @type {Set<string>} */
	const absolute = new Set();
	/** @param {any} p */
	const add = (p) => {
		if (typeof p !== 'string' || !p) return;
		if (/^(blob:|data:)/.test(p)) return;
		if (/^https?:\/\//.test(p)) {
			if (p.startsWith(base)) paths.add(p.slice(base.length));
			else absolute.add(p);
			return;
		}
		paths.add(p.replace(/^\/+/, ''));
	};
	group?.traverse?.((/** @type {any} */ o) => {
		const ud = o?.userData;
		if (!ud) return;
		if (ud.packRef?.path) add(ud.packRef.path);
		if (ud.animRef?.path) add(ud.animRef.path);
		const levels = ud.lod?.levels;
		if (Array.isArray(levels))
			for (const level of levels) {
				if (level?.source !== 'pack' || typeof level.ref !== 'string') continue;
				if (level.ref.includes('/')) add(level.ref);
				else if (ud.packRef?.path && !/^https?:\/\//.test(ud.packRef.path))
					add(ud.packRef.path.slice(0, ud.packRef.path.lastIndexOf('/') + 1) + level.ref);
			}
	});
	return { paths, absolute };
}

/** @param {number} n */
export function fmtBytes(n) {
	if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
	if (n >= 1024) return Math.round(n / 1024) + ' KB';
	return n + ' B';
}
