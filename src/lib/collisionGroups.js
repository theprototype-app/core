// 36 X5: collision groups — a LEAF (imports nothing), shared by physics.js (every
// collider), charController.js (the walker's sweep), the Inspector row and the
// collider node. One object is IN one group and COLLIDES WITH a set of groups;
// rapier packs both into a 32-bit InteractionGroups (membership << 16 | filter)
// and two colliders touch only when each one's membership is in the other's
// filter. Everything is replicated through userData.physics.group /
// .collidesWith (the setPhysicsFor path), so every peer builds the same world.
//
// Level-design uses: a ghost wall the player walks through but crates do not
// (group A, collides with everything except Player), a projectile-only barrier
// (group B, collides with B only), and WATER (W1, 36-water): a water volume is a
// pass-through TRIGGER in the Water group — bodies float by waterVolumes.query
// (36-sim), never by bumping into the water box — and it still fires On Enter /
// On Exit for what falls in.

/** the groups an object may be IN (the Inspector chips, the node's select) */
export const COLLISION_GROUPS = Object.freeze([
	Object.freeze({ id: 'default', label: 'Default', bit: 0 }),
	Object.freeze({ id: 'a', label: 'A', bit: 1 }),
	Object.freeze({ id: 'b', label: 'B', bit: 2 }),
	Object.freeze({ id: 'c', label: 'C', bit: 3 }),
	Object.freeze({ id: 'd', label: 'D', bit: 4 }),
	Object.freeze({ id: 'water', label: 'Water/trigger', bit: 5 })
]);

/** the walker's own group: nothing is ever IN it but the player capsule, so it
 * is offered only in "collides with" (a ghost wall leaves it out) */
export const PLAYER_GROUP = Object.freeze({ id: 'player', label: 'Player', bit: 6 });

/** every group a filter can name (the "collides with" chips) */
export const COLLIDES_WITH_GROUPS = Object.freeze([...COLLISION_GROUPS, PLAYER_GROUP]);

/** @type {Map<string, number>} */
const BIT = new Map(COLLIDES_WITH_GROUPS.map((g) => [g.id, g.bit]));
/** a filter of "everything" — every known bit and the ones a newer build may add */
export const ALL_FILTER = 0xffff;

/** @param {any} id @returns {boolean} */
export function isGroupId(id) {
	return typeof id === 'string' && COLLISION_GROUPS.some((g) => g.id === id);
}

/**
 * The group an object is in: its explicit pick, else 'water' for a W1 water
 * volume (userData.water), else 'default'. @param {any} physics userData.physics
 * @param {any=} water userData.water @returns {string}
 */
export function groupOf(physics, water) {
	if (isGroupId(physics?.group)) return physics.group;
	return water && typeof water === 'object' ? 'water' : 'default';
}

/**
 * The 16-bit filter for a "collides with" list. Absent (or not an array) =
 * everything, which is what every scene saved before X5 means; unknown ids
 * are ignored so a newer peer's group cannot zero the filter.
 * @param {any} collidesWith @returns {number}
 */
export function filterOf(collidesWith) {
	if (!Array.isArray(collidesWith)) return ALL_FILTER;
	let mask = 0;
	for (const id of collidesWith) if (BIT.has(id)) mask |= 1 << /** @type {number} */ (BIT.get(id));
	return mask;
}

/**
 * rapier InteractionGroups for a membership group + a filter list.
 * @param {string} group @param {any=} collidesWith @returns {number}
 */
export function interactionGroups(group, collidesWith) {
	const bit = BIT.get(group) ?? 0;
	// >>> 0: keep it an UNSIGNED 32-bit number (a set bit 15 of the membership
	// would otherwise read negative, which rapier's u32 refuses)
	return (((1 << bit) << 16) | (filterOf(collidesWith) & 0xffff)) >>> 0;
}

/** the player capsule's groups: in Player, colliding with everything (a wall
 * that leaves Player out of ITS filter is what lets the player through) */
export function playerInteractionGroups() {
	return interactionGroups(PLAYER_GROUP.id);
}

/**
 * Would two colliders with these packed groups touch? rapier's own test, for
 * the unit layer and the Inspector's summary. @param {number} a @param {number} b
 */
export function groupsInteract(a, b) {
	const memA = a >>> 16;
	const filA = a & 0xffff;
	const memB = b >>> 16;
	const filB = b & 0xffff;
	return (memA & filB) !== 0 && (memB & filA) !== 0;
}

/**
 * Normalize a "collides with" pick for storage: null when it means everything
 * (so the default writes no key), else the known ids in catalogue order.
 * @param {any} list @returns {string[] | null}
 */
export function normalizeCollidesWith(list) {
	if (!Array.isArray(list)) return null;
	const picked = COLLIDES_WITH_GROUPS.filter((g) => list.includes(g.id)).map((g) => g.id);
	return picked.length === COLLIDES_WITH_GROUPS.length ? null : picked;
}
