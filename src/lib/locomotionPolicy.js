// 30b P3/P4: HOW A PLAYER MAY MOVE, and WHERE THEY START — a pure leaf (imports nothing),
// so the rule table and the spawn maths are unit-tested with no headset.
//
// Contract C1: EDIT keeps the editor's movement (fly, teleport, the world gestures).
// INTERACT and PLAY walk like a game — the stick walks, a capsule stops at walls, gravity
// pulls you down, a ~0.3 m step is climbed, snap turn stays — and NEITHER fly NOR teleport
// unless the scene's play block allows it (`play.locomotion: {teleport?, fly?}`, absent =
// false). The Quest report this answers: "In [the dungeon] I can go through walls,
// teleport, I want to be able to do this only in edit mode and fly only in edit mode."

/**
 * @param {'edit' | 'interact'} mode
 * @param {{teleport?: boolean, fly?: boolean} | null | undefined} locomotion the resolved play block
 * @returns {{walk: boolean, fly: boolean, teleport: boolean, collide: boolean, gravity: boolean, worldGestures: boolean}}
 */
export function locomotionPolicy(mode, locomotion) {
	if (mode !== 'interact') {
		// the editor: movement exactly as it has always been, walls included
		return { walk: false, fly: true, teleport: true, collide: false, gravity: false, worldGestures: true };
	}
	const fly = locomotion?.fly === true;
	return {
		walk: true,
		fly,
		teleport: locomotion?.teleport === true,
		collide: true,
		gravity: !fly,
		worldGestures: false
	};
}

/**
 * `play.locomotion` at a store boundary: only booleans survive, and an empty block is
 * ABSENT (so a scene that never used it saves byte-identically).
 * @param {any} raw @returns {{teleport?: boolean, fly?: boolean} | null}
 */
export function normalizeLocomotion(raw) {
	if (!raw || typeof raw !== 'object') return null;
	/** @type {{teleport?: boolean, fly?: boolean}} */
	const out = {};
	if (typeof raw.teleport === 'boolean') out.teleport = raw.teleport;
	if (typeof raw.fly === 'boolean') out.fly = raw.fly;
	return Object.keys(out).length ? out : null;
}

const SPAWN_LIMIT = 100000;

/**
 * A spawn point at a store/api boundary: `{position: [x, y, z], yaw}` with finite numbers
 * (y is the FEET, yaw in radians, three's rotation.y: 0 faces -Z). Accepts the api's
 * `(position, yaw)` pair too. Anything else is null.
 * @param {any} raw @param {any} [yawArg]
 * @returns {{position: [number, number, number], yaw: number} | null}
 */
export function normalizeSpawn(raw, yawArg) {
	// 30c's first shape was `{pos, yaw}` (the level lane); read it too so a scene authored
	// that way keeps its spawn
	const position = Array.isArray(raw) ? raw : (raw?.position ?? raw?.pos);
	if (!Array.isArray(position) || position.length < 3) return null;
	const p = position.slice(0, 3).map(Number);
	if (!p.every((v) => Number.isFinite(v) && Math.abs(v) <= SPAWN_LIMIT)) return null;
	const yawRaw = Array.isArray(raw) ? yawArg : raw?.yaw;
	const yaw = Number(yawRaw ?? 0);
	return {
		position: /** @type {[number, number, number]} */ (p),
		yaw: Number.isFinite(yaw) ? yaw : 0,
		// 30b (core-games): a VR-ONLY spawn — the headset stands on it, desktop Play and
		// Interact keep their own camera (the Jam Room puts a VR player INSIDE the band, where
		// a level desktop eye would see only the piano). Additive, kept only when true.
		...(!Array.isArray(raw) && raw?.vrOnly === true ? { vrOnly: true } : {})
	};
}

/** forward (the direction you face) for a yaw: (-sin yaw, 0, -cos yaw) @param {number} yaw */
export function yawForward(yaw) {
	return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/**
 * The yaw you face from a forward vector (the inverse of yawForward; y is ignored).
 * @param {{x: number, z: number}} dir
 */
export function yawOf(dir) {
	return Math.atan2(-dir.x, -dir.z);
}

/**
 * THE VR SPAWN as two XR reference-space offsets (WebXR: a pose in the NEW space is
 * `inverse(originOffset) * pose in the old one`, so an offset rotating by `a` turns the
 * viewer by `-a`, and one translating by `t` moves the viewer by `-t`).
 *   1. `turn`: rotate about the viewer's head so they face `yaw` (the snap-turn shape),
 *   2. `move`: translate so the FEET land on the spawn point.
 * @param {{x: number, y: number, z: number}} head the head in the current space
 * @param {number} headYaw the yaw the head currently faces
 * @param {number} headHeight the head's height above the physical floor
 * @param {{position: number[], yaw: number}} spawn
 */
export function vrSpawnOffsets(head, headYaw, headHeight, spawn) {
	const a = headYaw - spawn.yaw; // the viewer turns by -a = spawn.yaw - headYaw
	const s = Math.sin(a);
	const c = Math.cos(a);
	const turn = {
		angle: a,
		position: { x: head.x - (c * head.x + s * head.z), y: 0, z: head.z - (-s * head.x + c * head.z) },
		orientation: { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }
	};
	const feet = head.y - headHeight;
	const move = {
		x: head.x - spawn.position[0],
		y: feet - spawn.position[1],
		z: head.z - spawn.position[2]
	};
	return { turn, move };
}
