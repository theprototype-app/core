// 102 M6 — PAINT ON MESHES: the live stroke's WIRE SHAPE. A zero-import leaf on its own so the dispatcher's
// validator (wireValidate, in the boot chunk) can reach it without pulling the painter, which loads on first use.

/** the channel keys a stroke may name (meshPaintCore.CHANNELS, asserted equal by its unit test) */
export const CHANNEL_KEYS = Object.freeze(['color', 'roughness', 'metalness', 'emissive']);

// ---- the wire ---------------------------------------------------------------------------------------------------

/** the most points one live `meshpaint` message may carry (a 66 ms throttle sends a handful) */
export const MAX_SEG_POINTS = 512;
export const PAINT_SPACES = Object.freeze(['uv', 'obj', 'vtx']);

/**
 * The shape of a live `meshpaint` message (wireValidate's table). The live stroke is a PREVIEW: the committed
 * image (`map` / `mapSlot`) or geometry (`meshgeo`) that follows is the truth, so this only has to keep a bad
 * message from throwing or asking for absurd work. @param {any} d
 */
export function validMeshPaint(d) {
	if (!d || typeof d.id !== 'string' || d.id.length > 64) return false;
	if (typeof d.uuid !== 'string' || !d.uuid || d.uuid.length > 64) return false;
	if (d.slot !== undefined && !(Number.isInteger(d.slot) && d.slot >= 0 && d.slot < 64)) return false;
	if (d.ch !== undefined && !CHANNEL_KEYS.includes(d.ch)) return false;
	if (!PAINT_SPACES.includes(d.sp)) return false;
	if (typeof d.c !== 'string' || !/^#[0-9a-f]{6}$/i.test(d.c)) return false;
	if (!(typeof d.r === 'number' && Number.isFinite(d.r) && d.r > 0 && d.r <= 1e6)) return false;
	if (d.b !== undefined && (!d.b || typeof d.b !== 'object' || Array.isArray(d.b))) return false;
	if (d.n !== undefined && !(Array.isArray(d.n) && d.n.length === 3 && d.n.every(Number.isFinite))) return false;
	if (!Array.isArray(d.seg) || d.seg.length < 1 || d.seg.length > MAX_SEG_POINTS) return false;
	const dim = d.sp === 'uv' ? 2 : 3;
	for (const p of d.seg) {
		if (!Array.isArray(p) || (p.length !== dim && p.length !== dim + 1)) return false;
		for (const x of p) if (typeof x !== 'number' || !Number.isFinite(x)) return false;
	}
	return true;
}

/** Points travel rounded, and the SENDER paints the rounded point too, so both sides run the same numbers.
 * @param {number[]} p @param {number} dim */
export function quantizePoint(p, dim) {
	const out = [];
	for (let k = 0; k < dim; k++) out.push(Math.round(p[k] * 1e5) / 1e5);
	if (Number.isFinite(p[dim]) && p[dim] < 1) out.push(Math.round(Math.max(0, p[dim]) * 1000) / 1000);
	return out;
}
