// Default object palette (V-3). New primitives used to be uniformly bright
// green (0x00ff00) — ugly, and ten cubes were indistinguishable. Instead each
// new primitive picks a color from a curated muted palette by a DETERMINISTIC
// hash of its uuid: the creator and every receiver compute the SAME color from
// the same uuid in the `create` message, so the look is shared with zero extra
// wire bytes and objects naturally cycle through the palette.
//
// Colors are mid-value muted tones that read well on the studio background and
// take the new shadows + AO gracefully. Assigned as hex strings — safe under
// THREE color management (the setHSL-linearization gotcha only bites HSL).

export const DEFAULT_PALETTE = [
	'#e07a5f', // terracotta
	'#f2cc8f', // sand
	'#81b29a', // sage
	'#6d9dc5', // steel blue
	'#8f7fc8', // slate lavender
	'#d387ab', // rose
	'#5fb0b7', // teal
	'#b8b2a7' // warm gray
];

/** Deterministic palette color for an object, keyed by uuid.
 * @param {string} uuid @returns {string} hex color */
export function paletteColorFor(uuid) {
	let hash = 0;
	const key = String(uuid ?? '');
	for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
	return DEFAULT_PALETTE[Math.abs(hash) % DEFAULT_PALETTE.length];
}
