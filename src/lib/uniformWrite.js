// 102b-papercuts (row 18): what a Set Shader Uniform node writes into a live uniform slot.
// A LEAF (imports nothing) so the flow runtime stays free of the shader compiler (a lazy
// chunk) and the rule is testable with no GL context.
//
// A float slot takes the number, as SH7 always did. A vec2/vec3/vec4 slot holds an ARRAY
// (shaderCompile.uniformValue), and it takes, in this order:
//   1. a wired or typed VECTOR (`vector`, a [x, y, z] array the vector3 socket carries),
//   2. a COLOUR (`color`, '#rrggbb', converted sRGB -> linear exactly as the compiler does
//      for an authored colour, or the driven colour and the authored one would not match),
//   3. the NUMBER, written into every component (a grey, or a uniform scale).
// A vec4 keeps its own 4th component unless the vector names one. Writes are IN PLACE on
// the array three already uploads from, so nothing recompiles. Anything unreadable writes
// nothing: the node "does nothing" rather than breaking the material, as the docs promise.

/** @param {number} c */
function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** '#rrggbb' -> linear [r, g, b], or null when it is not a colour @param {any} hex */
export function hexToLinear(hex) {
	if (typeof hex !== 'string') return null;
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => srgbToLinear(c / 255));
}

/** a vector socket value as numbers, or null @param {any} v @returns {number[] | null} */
function vectorOf(v) {
	if (Array.isArray(v)) {
		const out = v.slice(0, 4).map(Number);
		return out.length && out.every(Number.isFinite) ? out : null;
	}
	if (v && typeof v === 'object' && Number.isFinite(+v.x)) {
		const out = [+v.x, +v.y, +v.z, v.w].filter((n, i) => i < 3 || n !== undefined).map(Number);
		return out.every(Number.isFinite) ? out : null;
	}
	return null;
}

/**
 * Write a node's resolved data into a uniform slot. Returns what kind of value was written
 * ('number' | 'vector' | 'color') or null when nothing was.
 * @param {{value: any} | null | undefined} slot
 * @param {{value?: any, color?: any, vector?: any}} data
 * @returns {'number' | 'vector' | 'color' | null}
 */
export function writeUniformSlot(slot, data) {
	if (!slot) return null;
	const cur = slot.value;
	if (Array.isArray(cur) || (cur && typeof cur === 'object' && typeof cur.fromArray === 'function')) {
		/** @type {any} */ const target = cur;
		const n = Array.isArray(cur) ? cur.length : typeof cur.w === 'number' ? 4 : typeof cur.z === 'number' || typeof cur.b === 'number' ? 3 : 2;
		/** @type {number[] | null} */ let src = vectorOf(data.vector);
		/** @type {'vector' | 'color' | 'number'} */ let kind = 'vector';
		if (!src) {
			src = hexToLinear(data.color);
			kind = 'color';
		}
		if (!src) {
			const num = Number(data.value);
			if (!Number.isFinite(num)) return null;
			src = Array.from({ length: Math.min(n, 3) }, () => num);
			kind = 'number';
		}
		const width = Math.min(n, src.length);
		if (Array.isArray(target)) for (let i = 0; i < width; i++) target[i] = src[i];
		else {
			// a THREE.Vector2/3/4 or Color, should a backend hand one over
			const keys = typeof target.r === 'number' ? ['r', 'g', 'b'] : ['x', 'y', 'z', 'w'];
			for (let i = 0; i < width && i < keys.length; i++) target[keys[i]] = src[i];
		}
		return kind;
	}
	const value = Number(data.value);
	if (!Number.isFinite(value)) return null;
	slot.value = value;
	return 'number';
}
