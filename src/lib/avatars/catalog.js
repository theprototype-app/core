// 36-avatars (plan 76.1/76.5): the rigged characters a user can pick, and how a config resolves to one.
// A LEAF (no imports): AvatarRig, the customise panel and the unit suite share it.
//
// The GLBs live in static/avatars/ and are BUILT in the packs repo (tools/avatars/build.mjs, from
// KayKit's CC0 Adventurers + Skeletons packs): one merged skinned mesh per character on ONE material,
// and one shared clips.glb (every character uses the same 41-joint rig). `avatars.json` beside them is
// the build's own report; the unit suite asserts this table matches it, so a rebuild that changes a
// character cannot ship with a stale table.

/** where the files are served (relative to the page, so an export on a subpath finds them too) */
export const AVATAR_DIR = 'avatars/';
export const CLIPS_FILE = 'clips.glb';

/**
 * id · picker name · file · drawn triangles · height (model units, top of the head/headgear) · the atlas cells (8×4 grid, row-major from the top-left)
 * the outfit colour repaints — the build's pick (cells the body/limbs use and the head does not),
 * so skin and faces never change colour.
 * @type {{id: string, name: string, file: string, tris: number, height: number, outfitCells: number[]}[]}
 */
export const CHARACTERS = [
	{ id: 'knight', name: 'Knight', file: 'knight.glb', tris: 4712, height: 2.467, outfitCells: [3, 7, 6] },
	{ id: 'mage', name: 'Mage', file: 'mage.glb', tris: 4509, height: 2.716, outfitCells: [8, 19, 4] },
	{ id: 'rogue', name: 'Rogue', file: 'rogue.glb', tris: 4347, height: 2.187, outfitCells: [8, 9, 19] },
	{ id: 'rogue-hooded', name: 'Hooded rogue', file: 'rogue-hooded.glb', tris: 4005, height: 2.251, outfitCells: [8, 19, 5] },
	{ id: 'barbarian', name: 'Barbarian', file: 'barbarian.glb', tris: 4777, height: 2.398, outfitCells: [6, 10, 19] },
	{ id: 'skeleton-minion', name: 'Skeleton', file: 'skeleton-minion.glb', tris: 5288, height: 2.166, outfitCells: [6, 7, 5] },
	{ id: 'skeleton-warrior', name: 'Skeleton warrior', file: 'skeleton-warrior.glb', tris: 5934, height: 2.59, outfitCells: [3, 6, 18] },
	{ id: 'skeleton-mage', name: 'Skeleton mage', file: 'skeleton-mage.glb', tris: 4588, height: 2.63, outfitCells: [18, 7, 3] },
	{ id: 'skeleton-rogue', name: 'Skeleton rogue', file: 'skeleton-rogue.glb', tris: 5278, height: 2.308, outfitCells: [3, 7, 6] }
];

/** the rig's head bone height in model units (every KayKit character shares it) */
export const HEAD_BONE_Y = 1.241;
/** model units from the head bone to the middle of the (big, stylised) head — where the eyes are */
export const HEAD_CENTER_ABOVE_BONE = 0.42;
/** world metres per model unit: a 1.6 m eye height puts the head centre at the camera */
export const AVATAR_SCALE = 0.95;

/**
 * How far above the head CENTRE a hat sits on a character's own head, in the stylised-head geometry's
 * units (its 0.72 scale): the character's top (helmet, hood, wizard hat) less the hat's own base.
 * @param {string} id
 */
export function hatLiftFor(id) {
	const c = characterById(id);
	if (!c) return 0.15;
	return Math.max(0, (c.height - HEAD_BONE_Y - HEAD_CENTER_ABOVE_BONE) / 0.72 - 0.42);
}

/** the clips the runtime plays (clips.glb carries exactly these) */
export const CLIP_NAMES = {
	idle: 'Idle',
	walk: 'Walking_A',
	back: 'Walking_Backwards',
	run: 'Running_A',
	strafeLeft: 'Running_Strafe_Left',
	strafeRight: 'Running_Strafe_Right',
	air: 'Jump_Idle',
	cheer: 'Cheer',
	interact: 'Interact',
	sit: 'Sit_Floor_Idle'
};

/** head options for a rigged body: the character's own head, a stylised shape, or the photo card */
export const HEAD_OPTIONS = [
	{ value: 'character', name: "Character's own" },
	{ value: 'sphere', name: 'Sphere' },
	{ value: 'box', name: 'Box' },
	{ value: 'capsule', name: 'Capsule' },
	{ value: 'cone', name: 'Cone' }
];

/** the picker list: Classic (the floating head) + Auto + every character */
export function characterChoices() {
	return [
		{ value: 'auto', name: 'Surprise me (picked from your id)' },
		...CHARACTERS.map((c) => ({ value: c.id, name: c.name })),
		{ value: 'classic', name: 'Classic floating head' }
	];
}

/** @param {string} id */
export function characterById(id) {
	return CHARACTERS.find((c) => c.id === id) ?? null;
}

/**
 * Which character a peer shows. `auto` (and any id this build does not know — a newer peer's pick)
 * hashes the PEER ID into the list, so every viewer derives the same body with no message.
 * `classic` = the pre-36 floating head. Returns the character row, or null for classic.
 * @param {string | undefined} choice @param {string} peerId
 */
export function resolveCharacter(choice, peerId) {
	if (choice === 'classic') return null;
	const known = choice ? characterById(choice) : null;
	if (known) return known;
	let h = 2166136261;
	for (const ch of String(peerId ?? '')) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	return CHARACTERS[(h >>> 0) % CHARACTERS.length];
}

/**
 * The 32-bit cell mask the outfit shader tests (bit = row * 8 + col).
 * @param {number[]} cells
 */
export function outfitMask(cells) {
	let m = 0;
	for (const c of cells ?? []) if (c >= 0 && c < 32) m |= 1 << c;
	return m >>> 0;
}

/**
 * World-space offset (metres, +Y) from the FEET to the head centre — the body hangs this far below
 * the broadcast camera position.
 */
export function feetBelowHead() {
	return (HEAD_BONE_Y + HEAD_CENTER_ABOVE_BONE) * AVATAR_SCALE;
}
