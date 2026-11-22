// phone-polish (owner ruling 2026-11-05): TOUCH TARGETS WITHOUT A NEW LOOK. A small control keeps its size on
// screen and gets an INVISIBLE tap area that reaches TARGET px, but never into a neighbour's: where two controls
// sit closer than their slop wants, each side takes half the gap. Pure arithmetic over rects — no DOM — so the
// rule is unit-tested (tests/unit/hitSlop.test.js); $lib/ui/hitSlop.js measures the page and applies it.
//
// An item: { r: {l, t, r, b}, small: boolean, nested: boolean }. `small` = it wants slop (narrower or shorter than
// TARGET); a large control wants none but still BLOCKS its neighbours' slop. `nested` = it sits inside another
// control (a tab's ✕): its slop would take taps meant for the control around it, so it gets none.

export const TARGET = 44;

/**
 * @typedef {{ l: number, t: number, r: number, b: number }} Rect
 * @typedef {{ r: Rect, small?: boolean, nested?: boolean }} Item
 * @typedef {{ t: number, r: number, b: number, l: number }} Slop
 */

/** @param {Rect} a @param {Slop} s @returns {Rect} */
const grow = (a, s) => ({ l: a.l - s.l, t: a.t - s.t, r: a.r + s.r, b: a.b + s.b });
/** @param {Rect} a @param {Rect} b */
const meets = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

/**
 * @param {Item[]} items
 * @param {number} [target]
 * @returns {Slop[]} one slop per item (all zero for a large or nested one)
 */
export function planSlop(items, target = TARGET) {
	const slop = items.map((it) => {
		if (!it.small || it.nested) return { t: 0, r: 0, b: 0, l: 0 };
		const w = it.r.r - it.r.l;
		const h = it.r.b - it.r.t;
		const x = Math.max(0, (target - w) / 2);
		const y = Math.max(0, (target - h) / 2);
		return { t: y, r: x, b: y, l: x };
	});
	// every pair whose grown boxes meet gives each side half the gap between the two real boxes, on the axis that
	// separates them; two boxes that already overlap (a badge on a button) cannot share a gap — neither grows toward
	// the other's side at all
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const A = items[i].r;
			const B = items[j].r;
			const sa = slop[i];
			const sb = slop[j];
			if (!meets(grow(A, sa), grow(B, sb))) continue;
			const half = (/** @type {number} */ g) => Math.max(0, g / 2);
			if (A.r <= B.l) {
				const g = half(B.l - A.r);
				sa.r = Math.min(sa.r, g);
				sb.l = Math.min(sb.l, g);
			} else if (B.r <= A.l) {
				const g = half(A.l - B.r);
				sb.r = Math.min(sb.r, g);
				sa.l = Math.min(sa.l, g);
			} else if (A.b <= B.t) {
				const g = half(B.t - A.b);
				sa.b = Math.min(sa.b, g);
				sb.t = Math.min(sb.t, g);
			} else if (B.b <= A.t) {
				const g = half(A.t - B.b);
				sb.b = Math.min(sb.b, g);
				sa.t = Math.min(sa.t, g);
			} else {
				// the real boxes already overlap (a corner button laid over a window's ✕ by a few px): neither may reach
				// further into the other — the sides that FACE each other get nothing, on the axis they overlap least;
				// one box wholly inside the other (a badge on a button) gets nothing at all
				const inside = (/** @type {Rect} */ p, /** @type {Rect} */ q) => p.l >= q.l && p.r <= q.r && p.t >= q.t && p.b <= q.b;
				if (inside(A, B) || inside(B, A)) {
					slop[i] = { t: 0, r: 0, b: 0, l: 0 };
					slop[j] = { t: 0, r: 0, b: 0, l: 0 };
					continue;
				}
				const ox = Math.min(A.r, B.r) - Math.max(A.l, B.l);
				const oy = Math.min(A.b, B.b) - Math.max(A.t, B.t);
				const aFirstX = A.l + A.r < B.l + B.r;
				const aFirstY = A.t + A.b < B.t + B.b;
				if (oy <= ox) {
					if (aFirstY) (sa.b = 0), (sb.t = 0);
					else (sa.t = 0), (sb.b = 0);
					// and the cross axis: they share a band, so neither grows sideways past the other's near edge
					if (aFirstX) (sa.r = Math.min(sa.r, 0)), (sb.l = Math.min(sb.l, 0));
					else (sa.l = Math.min(sa.l, 0)), (sb.r = Math.min(sb.r, 0));
				} else {
					if (aFirstX) (sa.r = 0), (sb.l = 0);
					else (sa.l = 0), (sb.r = 0);
					if (aFirstY) (sa.b = Math.min(sa.b, 0)), (sb.t = Math.min(sb.t, 0));
					else (sa.t = Math.min(sa.t, 0)), (sb.b = Math.min(sb.b, 0));
				}
			}
			// a diagonal pair (separated on one axis, overlapping bands only through the slop on the other): the
			// cut above already separates them on the separating axis, so the grown boxes no longer meet
		}
	}
	return slop;
}
