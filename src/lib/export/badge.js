// 36-export (E1) — the "Made with ThePrototype" badge's link. A LEAF (no imports) so the
// component, the exporter's tests and the docs all spell it one way.
//
// A1 (folded add-on, user-approved 2026-10-04): the link carries `?ref=export&g=<game>&b=<build>
// &src=<source>` (36-community C4: `g` is the game's permanent id, so every export and the play
// link of one game count as ONE game) so the community Worker can COUNT visits per game (a
// number per game + a total, nothing about the visitor). That count is the "people arrive from games made here" signal the
// credits-monetization plan is gated on.

export const BADGE_ORIGIN = 'https://theprototype.app';
export const BADGE_TEXT = 'Made with ThePrototype';

/** an id as the counter accepts it: the Worker's own pattern, anything else dropped */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** the visit sources the Worker counts */
export const BADGE_SOURCES = ['play', 'itch', 'static', 'embed'];

/**
 * The badge's href. 36-community (C4): `{g, b, src}` — `g` the game's PERMANENT id (the scene
 * file's `gameId`; the published scene id or the export id for anything made before game ids),
 * `b` the build (an export's own id, `v<n>` for a published version), `src` where the visit came
 * from (play | itch | static | embed). A bare string is the pre-36 call: `g` only. Anything the
 * Worker would refuse is left out rather than sent mangled.
 * @param {string | {g?: string, b?: string, src?: string}} [ref]
 * @returns {string}
 */
export function badgeHref(ref = '') {
	const r = typeof ref === 'string' ? { g: ref } : ref || {};
	const u = new URL(BADGE_ORIGIN + '/');
	u.searchParams.set('ref', 'export');
	if (ID_RE.test(String(r.g ?? ''))) u.searchParams.set('g', String(r.g));
	if (ID_RE.test(String(r.b ?? ''))) u.searchParams.set('b', String(r.b));
	if (BADGE_SOURCES.includes(String(r.src ?? ''))) u.searchParams.set('src', String(r.src));
	return u.toString();
}

/**
 * What the badge counts on THIS page: an export says it all in its config (an export made before
 * game ids counts by its own id, with no build); a play link / embed counts the game the open
 * scene IS (its file's game id, else the published id the frame was opened with), the published
 * build and the source the frame named.
 * @param {{ exportConfig: {id?: string, gameId?: string, preset?: string} | null, gameId: string,
 *   sceneId: string, source: string, build: string }} page
 * @returns {{g: string, b: string, src: string}}
 */
export function badgeRefFor({ exportConfig, gameId, sceneId, source, build }) {
	if (exportConfig) {
		const g = exportConfig.gameId || exportConfig.id || '';
		return { g, b: exportConfig.gameId ? exportConfig.id || '' : '', src: exportConfig.preset === 'itch' ? 'itch' : 'static' };
	}
	return { g: gameId || sceneId || '', b: build || '', src: source === 'embed' ? 'embed' : 'play' };
}
