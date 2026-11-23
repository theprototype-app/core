// 92 (GC1 / GC2 / GC5 / GC8) — A GAME'S MENUS, AS AUTHORED: the title screen, the pause rule, the save
// slots and "Auto-admit while playing". PURE (no stores, no DOM): scenePhysics normalizes the play
// block's `menus` with it, the panel, the connector and the unit test read the same rules.
//
//   where     scenePhysics.play.menus — the play block already holds the spawn, the banner and the touch
//             layout; an older app keeps unknown keys verbatim (withUnknown), so a scene saved here and
//             re-saved there keeps its menus. Present ONLY when authored: a scene that never used them
//             stays byte-identical (the old-scene rule).
//   version   `v` = MENUS_VERSION. A config from a NEWER app is kept verbatim (never trimmed to what this
//             app knows) and `menusNewer` says so once ("made with a newer version").
//   shape     {v, title: {on, title, subtitle, background, color, image, editor}, pause: {on},
//              saves: {on}, autoAdmit}
//             every field clamped; unknown keys inside a block are dropped (it ends up in a page an
//             exported game's player sees — the loadingConfig rule).

export const MENUS_VERSION = 1;
/** how many save slots a game has (GC5: three named slots) */
export const SAVE_SLOTS = 3;
/** what the title screen's background is */
export const TITLE_BACKGROUNDS = ['scene', 'color', 'image'];

/** @param {any} v @param {number} max */
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** @param {any} v */
const colour = (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : '');

/**
 * The title screen block. Absent / not an object = no title screen.
 * @param {any} raw
 */
export function normalizeTitle(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const background = TITLE_BACKGROUNDS.includes(raw.background) ? raw.background : 'scene';
	return {
		on: raw.on !== false,
		...(text(raw.title, 80) ? { title: text(raw.title, 80) } : {}),
		...(text(raw.subtitle, 140) ? { subtitle: text(raw.subtitle, 140) } : {}),
		background,
		...(colour(raw.color) ? { color: colour(raw.color) } : {}),
		...(text(raw.image, 200) ? { image: text(raw.image, 200) } : {}),
		// shown when the author presses Play in the editor too (default yes: what you test is what ships)
		editor: raw.editor !== false
	};
}

/**
 * ONE normalize for the authored menus. Returns null when nothing is authored (the field is then left
 * out of the scene). A newer version is kept verbatim.
 * @param {any} raw @returns {any | null}
 */
export function normalizeGameMenus(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const v = Number(raw.v);
	if (Number.isFinite(v) && v > MENUS_VERSION) {
		try {
			// a newer app's config: keep it whole (bounded), never re-shape it to what we know
			const json = JSON.stringify(raw);
			return json.length <= 8192 ? JSON.parse(json) : null;
		} catch {
			return null;
		}
	}
	const title = normalizeTitle(raw.title);
	const out = {
		v: MENUS_VERSION,
		...(title ? { title } : {}),
		...(raw.pause && typeof raw.pause === 'object' ? { pause: { on: raw.pause.on !== false } } : {}),
		...(raw.saves && typeof raw.saves === 'object' ? { saves: { on: raw.saves.on !== false } } : {}),
		...(raw.autoAdmit === true ? { autoAdmit: true } : {})
	};
	return Object.keys(out).length > 1 ? out : null;
}

/** was this config written by a newer app than this one? @param {any} menus */
export function menusNewer(menus) {
	const v = Number(menus?.v);
	return Number.isFinite(v) && v > MENUS_VERSION;
}

/**
 * The resolved rules the runtime reads (a newer config reads as the parts this app understands, so a
 * newer title screen still shows). Pure. @param {any} menus
 */
export function menusRules(menus) {
	const m = menus && typeof menus === 'object' ? menus : {};
	const title = normalizeTitle(m.title);
	return {
		title: title && title.on ? title : null,
		// the pause menu PAUSES in a game that has authored menus, unless the author said not to; a game
		// with NO menus block keeps 1.74's menu exactly (it never paused: QUESTIONS-92-menus Q6)
		pause: menus && typeof menus === 'object' ? m.pause?.on !== false : false,
		saves: m.saves?.on === true,
		autoAdmit: m.autoAdmit === true
	};
}
