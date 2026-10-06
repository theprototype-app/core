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

// 36 F22 — SELECTING INSIDE AND BEHIND THINGS. The report: "I cannot click the fish inside
// the Aquarium's water." A water volume's own mesh is a plain opaque box for picking (the
// water renderer swaps its material per render call only), so it was the first OPAQUE hit
// in front of every fish, plant and stone in the tank. A NON-BLOCKING object now stands
// aside like a 0.12-opacity wall: a WATER volume (W1 `userData.water`, or a particle-fluid
// tank `userData.fluid`) by default; on request any TRANSPARENT surface, and any TRIGGER
// volume (a physics sensor, or the Water/trigger collision group). It is still in the stack:
// with nothing behind it the click takes it (its surface edge, an open ocean), Alt+click
// walks to it, and the object list always reaches it.

/** @typedef {{water: boolean, transparent: boolean, triggers: boolean}} PassThrough */

/** What the editor's selection passes through when a scene says nothing (Configure Scene ▸
 * Advanced). @type {Readonly<PassThrough>} */
export const PASS_DEFAULTS = Object.freeze({ water: true, transparent: false, triggers: false });

/** A game's interaction rays (play taps, carries, the VR laser and sweep) skip water and
 * trigger volumes unless the game asks for them (`play.rayHits`). @type {Readonly<PassThrough>} */
export const GAME_PASS_DEFAULTS = Object.freeze({ water: true, transparent: false, triggers: true });

/**
 * One boundary for a pass-through setting: anything missing takes `base`.
 * @param {any} value @param {Readonly<PassThrough>} [base] @returns {PassThrough}
 */
export function normalizePassThrough(value, base = PASS_DEFAULTS) {
	const v = value && typeof value === 'object' ? value : {};
	return {
		water: typeof v.water === 'boolean' ? v.water : base.water,
		transparent: typeof v.transparent === 'boolean' ? v.transparent : base.transparent,
		triggers: typeof v.triggers === 'boolean' ? v.triggers : base.triggers
	};
}

/**
 * The pass-through a game's rays use: the defaults, minus what the scene's play block
 * opts back IN to hitting (`play.rayHits: {water?: true, triggers?: true}`).
 * @param {any} rayHits @returns {PassThrough}
 */
export function gamePassThrough(rayHits) {
	const hits = rayHits && typeof rayHits === 'object' ? rayHits : {};
	return {
		water: hits.water === true ? false : GAME_PASS_DEFAULTS.water,
		transparent: GAME_PASS_DEFAULTS.transparent,
		triggers: hits.triggers === true ? false : GAME_PASS_DEFAULTS.triggers
	};
}

/**
 * What kind of non-blocking object this top-level target is, if any.
 * @param {any} target @returns {'water' | 'trigger' | null}
 */
export function nonBlockingKind(target) {
	const ud = target?.userData;
	if (!ud) return null;
	if ((ud.water && typeof ud.water === 'object') || (ud.fluid && typeof ud.fluid === 'object')) return 'water';
	if (ud.physics?.sensor === true || ud.physics?.group === 'water') return 'trigger';
	return null;
}

/** Is the surface a hit landed on see-through at all (transparent, below full opacity)?
 * @param {any} hit */
function hitTransparent(hit) {
	return hitOpacity(hit) < 1;
}

/**
 * Is this hit something a click should pass through to whatever is behind it?
 * The flag on the TOP-LEVEL object wins (a template marks its walls and ceilings
 * `userData.pick = 'through'` whatever their opacity), then the surface's own opacity,
 * then a hidden node on the way up (three's raycaster does not test `visible`), then the
 * non-blocking kinds the setting names (36 F22).
 * @param {any} hit @param {any} target the hit's top-level object
 * @param {PassThrough} [pass] absent = PASS_DEFAULTS
 */
export function isSeeThrough(hit, target, pass = PASS_DEFAULTS) {
	if (target?.userData?.pick === 'through') return true;
	if (hitOpacity(hit) < SEE_THROUGH_OPACITY) return true;
	const kind = nonBlockingKind(target);
	if (kind === 'water' && pass.water) return true;
	if (kind === 'trigger' && pass.triggers) return true;
	if (pass.transparent && hitTransparent(hit)) return true;
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
 * @param {PassThrough} [pass] what stands aside (36 F22); absent = PASS_DEFAULTS
 * @returns {StackEntry[]}
 */
export function pickStack(hits, topOf, pass = PASS_DEFAULTS) {
	/** @type {StackEntry[]} */
	const stack = [];
	/** @type {Map<string, number>} */
	const at = new Map();
	for (const hit of hits ?? []) {
		const target = topOf(hit.object);
		if (!target) continue;
		const through = isSeeThrough(hit, target, pass);
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

// ---- 36 F22: Alt+click CYCLES -------------------------------------------------------------
// Blender/Unity style: every object under the cursor, FRONT TO BACK — pass-through ones
// included, that is how the water itself is reached. The first Alt+click on a spot takes the
// frontmost; another Alt+click on the same spot (no time window: Alt says it on purpose) takes
// the next one down, wrapping. A "2 of 4" hint says where in the stack you are.

/** how far (css px) an Alt+click may land from the last one and still continue the cycle */
export const ALT_CYCLE_SLOP_PX = 8;

/**
 * Which stack entry an Alt+click selects.
 * @param {StackEntry[]} stack
 * @param {{x: number, y: number}} click
 * @param {{x: number, y: number, uuid: string | null} | null | undefined} last the previous Alt+click
 * @returns {{index: number, of: number}} index -1 = nothing under the cursor
 */
export function altCycleIndex(stack, click, last) {
	if (!stack.length) return { index: -1, of: 0 };
	const near = !!last && Math.hypot(click.x - last.x, click.y - last.y) <= ALT_CYCLE_SLOP_PX;
	const at = near ? stack.findIndex((entry) => entry.uuid === last?.uuid) : -1;
	return { index: at < 0 ? 0 : (at + 1) % stack.length, of: stack.length };
}

/**
 * The entry a GAME ray reaches: the stack's primary among the hits within `reach` metres.
 * @param {StackEntry[]} stack @param {number} [reach] @returns {StackEntry | null}
 */
export function gameRayEntry(stack, reach = Infinity) {
	const near = stack.filter((entry) => (entry.hit?.distance ?? 0) <= reach);
	return near.length ? near[primaryIndex(near)] : null;
}
