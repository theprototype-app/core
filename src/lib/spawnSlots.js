// fix-late-joiners row 3 — TWO PEOPLE OPENING A PLAY LINK AT ONCE NEVER SPAWN INSIDE EACH OTHER. Pure (no three,
// no stores): playSpawn feeds it the facts and a probe, the unit layer feeds it numbers.
//
// THE CANDIDATES: the scene's spawn points first (the spawn in force, then every object marked as a spawn point,
// by uuid so every peer lists them in the same order), then a ring around the first one: 1.4, 2.4, 3.6 and 4.8 m,
// 8 + 8 + 8 + 12 bearings (the first straight behind the facing, then alternately either side), the spawn's own
// facing kept. 40 spots with one spawn point: room for 16 players and the editors in the roster beside them.
//
// THE SLOT: who is ARRIVING is the same set on every arriving peer: me, plus every roster peer not yet in play
// whose avatar I cannot see or whose link opened moments ago (a peer opening the same link has told nobody it
// is playing, and from a fresh page every link is moments old). A host sitting in the editor counts too, so a
// lone joiner beside an editing host may take the first ring spot instead of the spawn: the price of never
// needing a message to agree. Ranked by peer id in that set, each
// arriving player takes its own residue class of the candidates (rank r of n: r, r + n, r + 2n ...), so two
// classes never share a spot even before either has seen the other's avatar. A lone player is {0, 1}: the
// spawn itself. A player joining a game already under way ranks alone too, finds the spawn taken by a visible
// avatar and walks on to the first free spot.
//
// THE PROBE: a spot is used only when `probe(spot)` says so (playSpawn: a sight line from the first spawn at
// chest height, then one ray down for the floor). The probe may move the spot's height onto the floor it found.

/** ring radii (m) and how many bearings each carries */
export const SPAWN_RINGS = [
	[1.4, 8],
	[2.4, 8],
	[3.6, 8],
	[4.8, 12]
];

/** how far an arriving player keeps from another player's avatar root (m) — playSpawn.AVATAR_CLEARANCE */
export const SPAWN_CLEARANCE = 1.0;

/**
 * Every candidate, in order. Spawns are `{position: [x, y, z], yaw}` with y the FEET.
 * @param {{position: number[], yaw: number} | null} primary the spawn in force
 * @param {{position: number[], yaw: number, id?: string}[]} [points] objects marked as spawn points
 * @returns {{position: number[], yaw: number, ring: boolean}[]}
 */
export function spawnCandidates(primary, points = []) {
	const marked = points
		.filter((p) => p && Array.isArray(p.position) && p.position.length === 3 && p.position.every(Number.isFinite))
		.slice()
		.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
	const first = primary ?? marked[0] ?? null;
	if (!first) return [];
	/** @type {{position: number[], yaw: number, ring: boolean}[]} */
	const out = [];
	const seen = new Set();
	for (const p of [primary, ...marked]) {
		if (!p) continue;
		const key = p.position.map((v) => v.toFixed(3)).join(',');
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ position: [p.position[0], p.position[1], p.position[2]], yaw: Number.isFinite(p.yaw) ? p.yaw : 0, ring: false });
	}
	const [x, y, z] = first.position;
	const yaw = Number.isFinite(first.yaw) ? first.yaw : 0;
	for (const [radius, count] of SPAWN_RINGS) {
		const step = (Math.PI * 2) / count;
		for (let i = 0; i < count; i++) {
			// i = 0 is behind the facing (+Z rotated by yaw), then alternately either side of it
			const turn = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step;
			const a = yaw + turn;
			out.push({ position: [x + Math.sin(a) * radius, y, z + Math.cos(a) * radius], yaw, ring: true });
		}
	}
	return out;
}

/**
 * This player's place among the players arriving now (see the header).
 * @param {string} me @param {string[]} roster every peer id in the session (may include me)
 * @param {(id: string) => boolean} arriving is that peer arriving too? (playSpawn: not in play, and its avatar
 *   unseen or its link opened within ARRIVE_MS — from a fresh joiner's view every link is new, so two joiners
 *   opening a link together both count the same peers)
 * @returns {{rank: number, of: number}}
 */
export function arrivingSlot(me, roster, arriving) {
	if (typeof me !== 'string' || !me) return { rank: 0, of: 1 };
	const set = [...new Set([me, ...(roster ?? []).filter((id) => typeof id === 'string' && id && id !== me && arriving(id))])].sort();
	return { rank: Math.max(0, set.indexOf(me)), of: set.length };
}

/**
 * Pick the spot: this slot's own residue class first, then any spot, each one clear of every avatar and passed by
 * the probe; else the first candidate (never nothing — a spawn has to land somewhere).
 * @param {{position: number[], yaw: number}[]} candidates
 * @param {{rank: number, of: number}} slot
 * @param {number[][]} avatars other players' avatar roots [x, y, z] (feet or head: only x/z and a loose y count)
 * @param {(spot: {position: number[], yaw: number}) => ({position: number[], yaw: number} | null)} [probe]
 * @param {number} [clearance]
 * @returns {{spot: {position: number[], yaw: number} | null, index: number}}
 */
export function pickSpawn(candidates, slot, avatars = [], probe = (s) => s, clearance = SPAWN_CLEARANCE) {
	if (!candidates.length) return { spot: null, index: -1 };
	// horizontal distance: an avatar root may be its head (1.7 m up) or its feet, and either stands on this spot
	const clear = (/** @type {number[]} */ p) => avatars.every((a) => Math.hypot(a[0] - p[0], a[2] - p[2]) >= clearance);
	const of = Math.max(1, Math.floor(slot?.of ?? 1));
	const rank = Math.min(of - 1, Math.max(0, Math.floor(slot?.rank ?? 0)));
	const tried = new Set();
	/** @param {number} k */
	const attempt = (k) => {
		if (tried.has(k)) return null;
		tried.add(k);
		const c = candidates[k];
		if (!clear(c.position)) return null;
		const probed = probe(c);
		return probed && clear(probed.position) ? probed : null;
	};
	for (let k = rank; k < candidates.length; k += of) {
		const s = attempt(k);
		if (s) return { spot: s, index: k };
	}
	for (let k = 0; k < candidates.length; k++) {
		const s = attempt(k);
		if (s) return { spot: s, index: k };
	}
	return { spot: candidates[0], index: 0 };
}
