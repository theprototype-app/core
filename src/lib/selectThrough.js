// 30 P2: SELECT-THROUGH and CLICK-CYCLE — the pure part. Imports NOTHING (the
// objectListNav / inputDevice shape), so the editor pick, the suite and vitest share it.
//
// Two measured reasons it exists (roadmap 30, "Selection and the object list"):
//  - a near-invisible SHELL wins the nearest-hit pick. Stars Room's 0.12-opacity walls
//    took every click on a star, a pad or a planet (16 of 16 selected "Wall south"),
//    and Football's 0.06 ceiling ate the lamps and the bars.
//  - with nothing but the nearest hit there was no way at all to reach what sits
//    BEHIND an opaque object, short of the object list.
//
// So a plain click prefers the first OPAQUE target down the ray, and a REPEATED click on
// the same spot walks down the stack (the DCC convention: Blender and Maya both cycle).
//
// THE TIMING IS A DECISION, and it deviates from the plan's "< 600 ms": the editor's
// double-click (15-O / 85's configurable action) is a second click on the SAME object
// inside 400 ms, so a cycle inside that window would hand the second click to the object
// behind and double-click-to-open-properties would die wherever anything sits behind the
// cursor, i.e. almost everywhere. A repeat therefore cycles from the END of the
// double-click window, and 600 ms would leave a 200 ms window nobody can hit on purpose.

/** below this effective opacity a surface is glass, not a thing to click */
export const SEE_THROUGH_OPACITY = 0.25;
/** how far (css px) a second click may land from the first and still be "the same spot" */
export const CYCLE_SLOP_PX = 4;
/** the editor's double-click window (raycastSelect's lastPick) — a repeat inside it is a double-click */
export const DOUBLE_CLICK_MS = 400;
/** after this, a click on the same spot is a fresh pick again, not "the next one down" */
export const CYCLE_WINDOW_MS = 1500;

/**
 * The effective opacity of the surface a raycast hit landed on: the material of the
 * hit's own FACE on a multi-material mesh, 0 for a material switched off.
 * @param {any} hit
 * @returns {number}
 */
export function hitOpacity(hit) {
	const object = hit?.object;
	if (!object) return 1;
	let material = object.material;
	if (Array.isArray(material)) {
		const index = hit.face?.materialIndex ?? 0;
		material = material[index] ?? material[0];
	}
	if (!material) return 1;
	if (material.visible === false) return 0;
	if (material.transparent && typeof material.opacity === 'number') return material.opacity;
	return 1;
}

/**
 * Is this hit something a click should pass through to whatever is behind it?
 * The flag on the TOP-LEVEL object wins (a template marks its walls and ceilings
 * `userData.pick = 'through'` whatever their opacity), then the surface's own opacity,
 * then a hidden node on the way up (three's raycaster does not test `visible`).
 * @param {any} hit @param {any} target the hit's top-level object
 */
export function isSeeThrough(hit, target) {
	if (target?.userData?.pick === 'through') return true;
	if (hitOpacity(hit) < SEE_THROUGH_OPACITY) return true;
	for (let node = hit?.object; node; node = node.parent) {
		if (node.visible === false) return true;
		if (node === target) break;
	}
	return false;
}

/**
 * @typedef {{ uuid: string, target: any, hit: any, through: boolean }} StackEntry
 */

/**
 * Collapse raw hits (nearest first) into the STACK of distinct top-level targets.
 * A target counts as opaque if ANY of its hits is — a glass case around a solid core
 * is a thing you can click, the core is just behind its own glass.
 * @param {any[]} hits
 * @param {(object: any) => any} topOf resolves a hit mesh to its top-level object (null = skip)
 * @returns {StackEntry[]}
 */
export function pickStack(hits, topOf) {
	/** @type {StackEntry[]} */
	const stack = [];
	/** @type {Map<string, number>} */
	const at = new Map();
	for (const hit of hits ?? []) {
		const target = topOf(hit.object);
		if (!target) continue;
		const through = isSeeThrough(hit, target);
		const index = at.get(target.uuid);
		if (index === undefined) {
			at.set(target.uuid, stack.length);
			stack.push({ uuid: target.uuid, target, hit, through });
		} else if (stack[index].through && !through) {
			stack[index].through = false;
		}
	}
	return stack;
}

/** The entry a plain click selects: the first opaque target, else the nearest.
 * @param {StackEntry[]} stack */
export function primaryIndex(stack) {
	const index = stack.findIndex((entry) => !entry.through);
	return index < 0 ? 0 : index;
}

/**
 * Is `click` a deliberate repeat of `last` — the same spot, after the double-click window
 * and before the cycle window closes?
 * @param {{x: number, y: number, t: number}} click
 * @param {{x: number, y: number, t: number} | null | undefined} last
 */
export function isRepeatClick(click, last) {
	if (!last) return false;
	const dt = click.t - last.t;
	if (!(dt >= DOUBLE_CLICK_MS && dt <= CYCLE_WINDOW_MS)) return false;
	return Math.hypot(click.x - last.x, click.y - last.y) <= CYCLE_SLOP_PX;
}

/**
 * Which stack entry this click selects. A repeat of the last click whose pick is still in
 * the stack takes the NEXT entry down (wrapping, so the see-through shell in front is
 * reachable too); anything else takes the primary.
 * @param {StackEntry[]} stack
 * @param {{x: number, y: number, t: number}} click
 * @param {{x: number, y: number, t: number, uuid: string | null} | null | undefined} last
 * @returns {{index: number, cycled: boolean}} index -1 = nothing to pick
 */
export function chooseInStack(stack, click, last) {
	if (!stack.length) return { index: -1, cycled: false };
	const primary = primaryIndex(stack);
	if (!last?.uuid || !isRepeatClick(click, last)) return { index: primary, cycled: false };
	const current = stack.findIndex((entry) => entry.uuid === last.uuid);
	if (current < 0) return { index: primary, cycled: false };
	return { index: (current + 1) % stack.length, cycled: stack.length > 1 };
}
