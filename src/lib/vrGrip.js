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
 * @param {{scenery: boolean, grabbable: boolean}[]} candidates top-level objects along the
 *   ray, nearest first (each once)
 * @param {'edit' | 'interact'} mode
 * @returns {number} the index taken, or -1 for "nothing" (empty air in Edit = the world)
 */
export function pickGripTarget(candidates, mode) {
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (!c || c.scenery) continue;
		if (mode === 'interact') return c.grabbable ? i : -1;
		return i;
	}
	return -1;
}

/**
 * Does an empty-air grip move the world in this mode? Only Edit's does.
 * @param {'edit' | 'interact'} mode
 */
export function gripMovesWorld(mode) {
	return mode !== 'interact';
}
