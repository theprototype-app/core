// Avatar model (129): pure config resolution + per-shape geometry helpers,
// shared by AvatarRig (rendering) and CharacterModal (editing). The config
// rides userdata slot 5 and replicates like any avatar field.

export const AVATAR_DEFAULTS = {
	body: '#4f83cc',
	hat: 'none',
	face: 'label',
	shape: 'sphere', // sphere | box | capsule | cone
	showLabel: true
};

/** selectable head shapes for the customizer */
export const FACE_SHAPES = [
	{ value: 'sphere', name: 'Sphere' },
	{ value: 'box', name: 'Box' },
	{ value: 'capsule', name: 'Capsule' },
	{ value: 'cone', name: 'Cone' }
];

/** merge a userdata slot over the defaults @param {any} slot */
export function resolveAvatar(slot) {
	return { ...AVATAR_DEFAULTS, ...(slot ?? {}) };
}

/** where the hat sits so it rests ON TOP of each shape (not intersecting)
 * @param {string} shape */
export function hatAnchorY(shape) {
	return /** @type {Record<string, number>} */ ({ sphere: 0, box: 0.02, capsule: 0.2, cone: 0.28 })[shape] ?? 0;
}

/** a photo avatar renders as a billboard card instead of a 3D head
 * @param {any} config @param {string|null|undefined} photoUrl */
export function usesPhotoCard(config, photoUrl) {
	return config.face === 'image' && !!photoUrl;
}
