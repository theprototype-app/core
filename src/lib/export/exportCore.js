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
