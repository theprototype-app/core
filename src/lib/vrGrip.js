// 30b P2: WHAT A VR GRIP TAKES HOLD OF — a pure leaf (imports nothing), so the rule is
// unit-tested with no headset and no scene.
//
// THE FINDING (the Quest report: "when in game and in edit mode I should be able to move
// around the world and scale it with grips, now it disables this for some reason"). No
// code disabled the world grab. It fires only when a grip closes on EMPTY AIR, and a game
// scene has none: Stars Room is a closed 12 m room (floor, four walls, a ceiling), the
// football pitch sits in a glass box, Towers stands on a 26 m floor ringed by walls. Every
// controller ray ends on one of them, and the hand-inside test (100.3) is no better in a
// room-sized mesh, so every grip GRABBED THE ROOM — the wall moved with your hand, the world
// never did. A "normal" editor scene has sky behind everything, which is why it only broke
// in games.
//
// THE RULE: SCENERY is not held by a grip. An object is scenery when its world bounds
// reach SCENERY_EXTENT on any axis (a floor, a wall, a ceiling, a pitch) or the viewer's
// HEAD is inside them (you are standing in it — a room mesh, an arena). A grip ray passes
// through scenery to what is behind it, and a grip that finds nothing else is empty air —
// which in EDIT is the world gesture again, everywhere. Scenery still moves in Edit through
// every other path (the trigger selects it; the gizmo, the props panel and the menus act on
// the selection).
//
// And by MODE (contract C1): EDIT holds anything that is not scenery; INTERACT holds only
// what a player may hold — a dynamic physics body, under a play block whose interaction is
// 'grab' — and NEVER moves the world. The first non-scenery hit decides: in Interact a
// static podium in front of a ball blocks the grab, the way a wall blocks your hand.

/** metres: a world-bounds extent at or past this on any axis makes an object scenery */
export const SCENERY_EXTENT = 4;

/**
 * @param {{min: {x: number, y: number, z: number}, max: {x: number, y: number, z: number}} | null} box
 *   the object's WORLD bounds (null / empty = nothing to hold, never scenery)
 * @param {{x: number, y: number, z: number} | null} head the viewer's head in world space
 * @returns {boolean}
 */
export function isScenery(box, head) {
	if (!box || !box.min || !box.max) return false;
	const dx = box.max.x - box.min.x;
	const dy = box.max.y - box.min.y;
	const dz = box.max.z - box.min.z;
	if (!(dx >= 0 && dy >= 0 && dz >= 0)) return false; // empty / NaN bounds
	if (Math.max(dx, dy, dz) >= SCENERY_EXTENT) return true;
	if (!head) return false;
	return (
		head.x >= box.min.x && head.x <= box.max.x &&
		head.y >= box.min.y && head.y <= box.max.y &&
		head.z >= box.min.z && head.z <= box.max.z
	);
}

/**
 * Which candidate a grip takes, in ray order.
 *
 * 33 E4 — "not all objects positions can be moved in edit mode when in game": scenery was
 * held by NOTHING, so in a game scene every wall, floor, pitch and arena could not be moved
 * with a grip at all. The fix keeps the world gesture and makes the intent explicit: in
 * EDIT, scenery you have SELECTED (the trigger selects it) is held like any object — the
 * select-then-manipulate rule every editor follows. Unselected scenery still passes through
 * to the world grab, so grabbing a room you are standing in still moves the world.
 * @param {{scenery: boolean, grabbable: boolean, selected?: boolean, terrain?: boolean}[]} candidates
 *   top-level objects along the ray, nearest first (each once)
 * @param {'edit' | 'interact'} mode
 * @returns {number} the index taken, or -1 for "nothing" (empty air in Edit = the world)
 */
export function pickGripTarget(candidates, mode) {
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (!c) continue;
		if (c.terrain) continue; // 52 (V5): terrain never moves by grip, selected or not
		if (c.scenery && !(mode !== 'interact' && c.selected)) continue;
		if (mode === 'interact') return c.grabbable ? i : -1;
		return i;
	}
	return -1;
}

/**
 * Does an empty-air grip move the world in this mode? Edit's always does; Interact's only
 * when the play block says `locomotion.worldGrab` (31 K1 — Untangle, Jam Room).
 * @param {'edit' | 'interact'} mode @param {boolean} [worldGrab]
 */
export function gripMovesWorld(mode, worldGrab = false) {
	return mode !== 'interact' || worldGrab === true;
}

// ---- 52 (V5): THE UNIVERSAL WORLD GRAB -------------------------------------------------------------
// The user (2026-10-21): the two-grip world gesture worked "only if controllers do not point at any object"
// — surrounded by things, every grip closed on one of them. VR editors (Open Brush, Gravity Sketch, ShapesXR)
// read BOTH GRIPS as the world, and a two-hand object scale as a follow-up of an object already in hand.
// So: both grips are the world whatever the rays hit; the second hand scales an object only when the first
// has ALREADY MOVED it; a first grab that has not moved is dropped (back to its start pose, nothing recorded,
// nothing sent) and the world takes over. And a hand merely TOUCHING or INSIDE something big never takes it.

/** metres an object must have moved in the first hand before a second grip scales it instead of the world */
export const GRAB_MOVED_M = 0.02;
/** ms after a first-hand grab during which it stays TENTATIVE (no selection, nothing sent) unless it moves */
export const GRAB_JOIN_MS = 250;
/** metres: a hand touching / inside an object larger than this on any axis does not take it */
export const CONTACT_MAX_EXTENT = 2;

/**
 * May a hand that is merely INSIDE an object (100.3 — no ray) take it? Not when the object encloses the
 * headset, is larger than CONTACT_MAX_EXTENT on any axis, is terrain, or is locked — those move only
 * deliberately (select with the ray, then grip; terrain never by grip). Pure.
 * @param {{min: {x: number, y: number, z: number}, max: {x: number, y: number, z: number}} | null} box world bounds
 * @param {{x: number, y: number, z: number} | null} head
 * @param {{terrain?: boolean, locked?: boolean}} [flags]
 */
export function contactGrabAllowed(box, head, flags = {}) {
	if (!box || !box.min || !box.max) return false;
	if (flags.terrain || flags.locked) return false;
	const dx = box.max.x - box.min.x;
	const dy = box.max.y - box.min.y;
	const dz = box.max.z - box.min.z;
	if (!(dx >= 0 && dy >= 0 && dz >= 0)) return false;
	if (Math.max(dx, dy, dz) > CONTACT_MAX_EXTENT) return false;
	if (head && head.x >= box.min.x && head.x <= box.max.x && head.y >= box.min.y && head.y <= box.max.y && head.z >= box.min.z && head.z <= box.max.z)
		return false;
	return true;
}

/**
 * What a SECOND grip does while the other hand's grip is held. Pure.
 *  - 'legacy'   the pre-52 rule decides (setting "Only in empty air", Interact, stretch mode, or the other hand
 *               is busy with a window / vertex / face — not an object or the air)
 *  - 'scale'    the other hand holds an object it has already moved: two-hand scale/rotate of THAT object
 *               wherever this hand's ray points (unless this HAND is inside a different object it may take by
 *               touch: then it holds that one — 33 G4's two things at once; 'legacy' decides it)
 *  - 'world'    everything else: drop an unmoved first grab, both grips are the world
 * @param {{setting: 'always' | 'emptyAir', mode: 'edit' | 'interact', stretch?: boolean, otherBusy?: boolean,
 *   otherGrab?: {moved: boolean, set?: boolean} | null, takesOther?: boolean}} s
 * @returns {'legacy' | 'scale' | 'world'}
 */
export function secondGripVerdict(s) {
	if (s.setting !== 'always' || s.mode !== 'edit' || s.stretch || s.otherBusy) return 'legacy';
	if (s.otherGrab?.moved) return s.otherGrab.set || s.takesOther ? 'legacy' : 'scale';
	return 'world';
}

/** has a held object moved past GRAB_MOVED_M from where it was taken? (world metres) Pure.
 * @param {number[]} start @param {number[]} now */
export function grabMoved(start, now) {
	return Math.hypot(now[0] - start[0], now[1] - start[1], now[2] - start[2]) > GRAB_MOVED_M;
}
