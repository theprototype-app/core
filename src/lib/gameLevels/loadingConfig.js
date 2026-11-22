// 93 LP2 — the loading screen's CONFIG, a leaf (table.js normalizes the Levels table's `loading` with it;
// loading.js runs the screen). Unknown keys are dropped: it ends up in a page an exported game's player sees.

export const LOADING_PRESETS = ['fade', 'bar', 'logo', 'image', 'item'];
export const BAR_STYLES = ['thin', 'thick'];
/** @param {any} v @param {number} max */
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** @param {any} v */
const colour = (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : '');

/**
 * ONE normalize for a loading-screen config (the table's, a portal's, the export's play.js). Unknown keys are
 * dropped (it ends up in a page an exported game's player sees). @param {any} raw
 */
export function normalizeLoading(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const preset = LOADING_PRESETS.includes(r.preset) ? r.preset : 'bar';
	const tips = (Array.isArray(r.tips) ? r.tips : []).map((/** @type {any} */ t) => text(t, 140)).filter(Boolean).slice(0, 20);
	const bar = r.bar && typeof r.bar === 'object' ? r.bar : {};
	return {
		preset,
		...(colour(r.background) ? { background: colour(r.background) } : {}),
		...(text(r.image, 200) ? { image: text(r.image, 200) } : {}),
		...(text(r.logo, 200) ? { logo: text(r.logo, 200) } : {}),
		...(colour(r.textColor) ? { textColor: colour(r.textColor) } : {}),
		bar: { style: BAR_STYLES.includes(bar.style) ? bar.style : 'thin', ...(colour(bar.color) ? { color: colour(bar.color) } : {}) },
		...(tips.length ? { tips } : {}),
		...(text(r.item, 120) ? { item: text(r.item, 120) } : {}),
		...(text(r.title, 80) ? { title: text(r.title, 80) } : {})
	};
}
