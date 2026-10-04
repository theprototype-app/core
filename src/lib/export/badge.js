// 36-export (E1) — the "Made with ThePrototype" badge's link. A LEAF (no imports) so the
// component, the exporter's tests and the docs all spell it one way.
//
// A1 (folded add-on, user-approved 2026-10-04): the link carries `?ref=export&g=<id>` — the
// published scene id for a play link / embed, the export's own id for a downloaded build — so
// the community Worker can COUNT visits per game (a number per game + a total, nothing about
// the visitor). That count is the "people arrive from games made here" signal the
// credits-monetization plan is gated on.

export const BADGE_ORIGIN = 'https://theprototype.app';
export const BADGE_TEXT = 'Made with ThePrototype';

/** an id as the counter accepts it: the Worker's own pattern, anything else dropped */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The badge's href. `id` is the published scene id or the export id; an id the Worker
 * would refuse is left out rather than sent mangled.
 * @param {string} [id]
 * @returns {string}
 */
export function badgeHref(id = '') {
	const u = new URL(BADGE_ORIGIN + '/');
	u.searchParams.set('ref', 'export');
	if (ID_RE.test(String(id))) u.searchParams.set('g', String(id));
	return u.toString();
}
