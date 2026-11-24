// 102b-papercuts (scout row 18): CUBE-MAP SKIES. camera.md said "cube-map files are not supported".
// The whole sky pipeline (PMREM from an equirect texture, Rotation, the sun placed from the image,
// the hash a peer pulls, the .tpscene and export bundling) takes ONE equirectangular image, so a cube
// map is CONVERTED on upload into an equirectangular Radiance .hdr and stored like any uploaded sky.
// Nothing new is saved or sent: an older build opens the result as an ordinary HDRI.
//
// PURE (no DOM, no three): layouts, the face lookup, the resample and the .hdr writer, so the
// geometry is unit-tested. Decoding the files is cubeImport.js's job.
//
// CONVENTIONS. Faces are named the way cube-map files are: px nx py ny pz nz, with the OpenGL face
// axes (images top row first). Unfolded as a cross, the centre face is +Z and the face to its RIGHT is
// +X — which, standing inside and turning right, is world -X in three's right-handed frame; three
// flips x for every cube texture it draws (`flipEnvMap`), and the lookup below does the same, so a
// cross shows exactly as it would as a three CubeTexture and is never mirrored.

/** @typedef {'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz'} Face */
/** @typedef {{ data: Float32Array, width: number, height: number }} RGBAImage  linear RGBA floats, top row first */

export const FACES = /** @type {const} */ (['px', 'nx', 'py', 'ny', 'pz', 'nz']);

/** the largest equirect we write: 2048 x 1024 RGBE is 8 MB, well under the 25 MB a peer can receive */
export const MAX_EQUIRECT_WIDTH = 2048;

/**
 * Which cube layout an image's shape is, or null. A cross is 4:3 (or 3:4), a strip 6:1 (or 1:6).
 * @param {number} w @param {number} h @returns {'hcross' | 'vcross' | 'hstrip' | 'vstrip' | null}
 */
export function cubeLayoutOf(w, h) {
	if (!(w > 0 && h > 0)) return null;
	const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) <= 0.01 * b;
	if (near(w * 3, h * 4) && w % 4 === 0) return 'hcross';
	if (near(w * 4, h * 3) && h % 4 === 0) return 'vcross';
	if (near(w, h * 6) && w % 6 === 0) return 'hstrip';
	if (near(h, w * 6) && h % 6 === 0) return 'vstrip';
	return null;
}

/** an equirectangular image is twice as wide as it is tall @param {number} w @param {number} h */
export function isEquirectShape(w, h) {
	return w > 0 && h > 0 && Math.abs(w - 2 * h) <= 0.01 * w;
}

/**
 * Where each face sits in a layout, in cells of the face size, and whether it is stored turned 180
 * degrees (the -Z face at the bottom of a vertical cross is).
 *        +Y                 +Y
 *     -X +Z +X -Z        -X +Z +X       strips: +X -X +Y -Y +Z -Z
 *        -Y                 -Y
 *                           -Z (turned)
 * @param {'hcross' | 'vcross' | 'hstrip' | 'vstrip'} layout
 * @returns {Record<Face, {cx: number, cy: number, turned: boolean}>}
 */
export function faceCells(layout) {
	if (layout === 'hcross')
		return { py: { cx: 1, cy: 0, turned: false }, nx: { cx: 0, cy: 1, turned: false }, pz: { cx: 1, cy: 1, turned: false }, px: { cx: 2, cy: 1, turned: false }, nz: { cx: 3, cy: 1, turned: false }, ny: { cx: 1, cy: 2, turned: false } };
	if (layout === 'vcross')
		return { py: { cx: 1, cy: 0, turned: false }, nx: { cx: 0, cy: 1, turned: false }, pz: { cx: 1, cy: 1, turned: false }, px: { cx: 2, cy: 1, turned: false }, ny: { cx: 1, cy: 2, turned: false }, nz: { cx: 1, cy: 3, turned: true } };
	/** @type {any} */ const out = {};
	FACES.forEach((f, i) => (out[f] = layout === 'hstrip' ? { cx: i, cy: 0, turned: false } : { cx: 0, cy: i, turned: false }));
	return out;
}

/**
 * Cut a single cube-layout image into its six square faces.
 * @param {RGBAImage} img @returns {Record<Face, RGBAImage> | null}
 */
export function splitCubeImage(img) {
	const layout = cubeLayoutOf(img.width, img.height);
	if (!layout) return null;
	const size = layout === 'hcross' ? img.width / 4 : layout === 'vcross' ? img.width / 3 : layout === 'hstrip' ? img.height : img.width;
	const cells = faceCells(layout);
	/** @type {any} */ const faces = {};
	for (const f of FACES) {
		const { cx, cy, turned } = cells[f];
		const data = new Float32Array(size * size * 4);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const sx = cx * size + (turned ? size - 1 - x : x);
				const sy = cy * size + (turned ? size - 1 - y : y);
				const si = (sy * img.width + sx) * 4;
				const di = (y * size + x) * 4;
				data[di] = img.data[si];
				data[di + 1] = img.data[si + 1];
				data[di + 2] = img.data[si + 2];
				data[di + 3] = img.data[si + 3];
			}
		faces[f] = { data, width: size, height: size };
	}
	return faces;
}

/**
 * Which face a cube-map lookup direction hits, and where (s, t in 0..1, t from the TOP of the face
 * image) — the OpenGL major-axis rule.
 * @param {number} x @param {number} y @param {number} z @returns {{face: Face, s: number, t: number}}
 */
export function cubeLookup(x, y, z) {
	const ax = Math.abs(x);
	const ay = Math.abs(y);
	const az = Math.abs(z);
	/** @type {Face} */ let face;
	let sc;
	let tc;
	let ma;
	if (ax >= ay && ax >= az) {
		ma = ax;
		face = x > 0 ? 'px' : 'nx';
		sc = x > 0 ? -z : z;
		tc = -y;
	} else if (ay >= az) {
		ma = ay;
		face = y > 0 ? 'py' : 'ny';
		sc = x;
		tc = y > 0 ? z : -z;
	} else {
		ma = az;
		face = z > 0 ? 'pz' : 'nz';
		sc = z > 0 ? x : -x;
		tc = -y;
	}
	return { face, s: (sc / ma + 1) / 2, t: (tc / ma + 1) / 2 };
}

/** bilinear sample of a face at (s, t), clamped to the face @param {RGBAImage} f @param {number} s @param {number} t @param {Float32Array} out @param {number} o */
function sampleFace(f, s, t, out, o) {
	const fx = Math.min(f.width - 1, Math.max(0, s * f.width - 0.5));
	const fy = Math.min(f.height - 1, Math.max(0, t * f.height - 0.5));
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(f.width - 1, x0 + 1);
	const y1 = Math.min(f.height - 1, y0 + 1);
	const wx = fx - x0;
	const wy = fy - y0;
	const d = f.data;
	const i00 = (y0 * f.width + x0) * 4;
	const i10 = (y0 * f.width + x1) * 4;
	const i01 = (y1 * f.width + x0) * 4;
	const i11 = (y1 * f.width + x1) * 4;
	for (let c = 0; c < 4; c++)
		out[o + c] = (d[i00 + c] * (1 - wx) + d[i10 + c] * wx) * (1 - wy) + (d[i01 + c] * (1 - wx) + d[i11 + c] * wx) * wy;
}

/**
 * The equirect width for a face size: four faces round the equator, capped, even.
 * @param {number} faceSize
 */
export function equirectWidthFor(faceSize) {
	return Math.max(64, Math.min(MAX_EQUIRECT_WIDTH, Math.round((faceSize * 4) / 2) * 2));
}

/**
 * Resample six faces into an equirectangular image (three's mapping: u = atan2(z, x) / 2π + 0.5,
 * v = asin(y) / π + 0.5, top row = straight up).
 * @param {Record<Face, RGBAImage>} faces @param {number} [width]
 * @returns {RGBAImage}
 */
export function cubeToEquirect(faces, width) {
	const size = faces.px.width;
	const W = width ?? equirectWidthFor(size);
	const H = W / 2;
	const data = new Float32Array(W * H * 4);
	for (let r = 0; r < H; r++) {
		const lat = (0.5 - (r + 0.5) / H) * Math.PI;
		const cl = Math.cos(lat);
		const y = Math.sin(lat);
		for (let c = 0; c < W; c++) {
			const phi = ((c + 0.5) / W - 0.5) * 2 * Math.PI;
			const x = Math.cos(phi) * cl;
			const z = Math.sin(phi) * cl;
			// three's flipEnvMap: a cube texture is looked up with x negated
			const hit = cubeLookup(-x, y, z);
			sampleFace(faces[hit.face], hit.s, hit.t, data, (r * W + c) * 4);
		}
	}
	return { data, width: W, height: H };
}

/**
 * Downsample an equirect (box filter) so the written file stays within MAX_EQUIRECT_WIDTH.
 * @param {RGBAImage} img @returns {RGBAImage}
 */
export function fitEquirect(img) {
	if (img.width <= MAX_EQUIRECT_WIDTH) return img;
	const W = MAX_EQUIRECT_WIDTH;
	const H = W / 2;
	const data = new Float32Array(W * H * 4);
	const kx = img.width / W;
	const ky = img.height / H;
	for (let r = 0; r < H; r++)
		for (let c = 0; c < W; c++) {
			const x0 = Math.floor(c * kx);
			const x1 = Math.max(x0 + 1, Math.floor((c + 1) * kx));
			const y0 = Math.floor(r * ky);
			const y1 = Math.max(y0 + 1, Math.floor((r + 1) * ky));
			const o = (r * W + c) * 4;
			let n = 0;
			for (let y = y0; y < y1; y++)
				for (let x = x0; x < x1; x++) {
					const i = (y * img.width + x) * 4;
					for (let k = 0; k < 4; k++) data[o + k] += img.data[i + k];
					n++;
				}
			for (let k = 0; k < 4; k++) data[o + k] /= n;
		}
	return { data, width: W, height: H };
}

/**
 * Write linear RGB floats as a Radiance .hdr (flat RGBE scanlines, which three's HDRLoader reads).
 * @param {RGBAImage} img @returns {Uint8Array}
 */
export function encodeRGBE(img) {
	const header = `#?RADIANCE\n# made by theprototype.app from a cube map\nFORMAT=32-bit_rle_rgbe\n\n-Y ${img.height} +X ${img.width}\n`;
	const head = new TextEncoder().encode(header);
	const out = new Uint8Array(head.length + img.width * img.height * 4);
	out.set(head, 0);
	let o = head.length;
	const d = img.data;
	for (let i = 0; i < img.width * img.height; i++) {
		const r = Math.max(0, d[i * 4] || 0);
		const g = Math.max(0, d[i * 4 + 1] || 0);
		const b = Math.max(0, d[i * 4 + 2] || 0);
		const m = Math.max(r, g, b);
		if (m < 1e-32) {
			o += 4; // already zero
			continue;
		}
		const e = Math.ceil(Math.log2(m) + 1e-9);
		// three's HDRLoader decodes byte * 2^(e - 128) / 255 (not the classic / 256), so encode to match
		const scale = 255 / Math.pow(2, e);
		out[o] = Math.min(255, Math.round(r * scale));
		out[o + 1] = Math.min(255, Math.round(g * scale));
		out[o + 2] = Math.min(255, Math.round(b * scale));
		out[o + 3] = e + 128;
		o += 4;
	}
	return out;
}

/**
 * Which face a separate file is, from its name: px / posx / pos-x / right … Order matters: the
 * three-letter axis forms win over the words. Null when the name says nothing.
 * @param {string} name @returns {Face | null}
 */
export function faceOfFileName(name) {
	const base = String(name ?? '')
		.toLowerCase()
		.replace(/^.*[\\/]/, '')
		.replace(/\.[a-z0-9]+$/, '');
	// the face word ENDS the name, after a separator (or is the whole name): sky_px, negz, cloudy-back
	const m = /(?:^|[^a-z0-9])(pos-?[xyz]|neg-?[xyz]|[pn][xyz]|[+-][xyz]|right|left|top|up|bottom|down|front|back|rt|lf|ft|bk|dn)$/.exec(base) ?? /^(pos[xyz]|neg[xyz])$/.exec(base);
	if (!m) return null;
	const t = m[1].replace('-', '');
	/** @type {Record<string, Face>} */
	const map = {
		px: 'px', nx: 'nx', py: 'py', ny: 'ny', pz: 'pz', nz: 'nz',
		posx: 'px', negx: 'nx', posy: 'py', negy: 'ny', posz: 'pz', negz: 'nz',
		'+x': 'px', x: 'nx', '+y': 'py', y: 'ny', '+z': 'pz', z: 'nz',
		right: 'px', left: 'nx', top: 'py', up: 'py', bottom: 'ny', down: 'ny', front: 'pz', back: 'nz',
		rt: 'px', lf: 'nx', ft: 'pz', bk: 'nz', dn: 'ny'
	};
	return map[t] ?? null;
}

/**
 * Six named files -> the faces in order, or the reason they cannot be one cube.
 * @param {{name: string, image: RGBAImage}[]} files
 * @returns {{faces: Record<Face, RGBAImage>} | {error: string}}
 */
export function facesFromFiles(files) {
	if (files.length !== 6) return { error: 'A cube map in separate files needs all six faces (px, nx, py, ny, pz, nz).' };
	/** @type {any} */ const faces = {};
	for (const f of files) {
		const face = faceOfFileName(f.name);
		if (!face) return { error: 'Could not tell which face "' + f.name + '" is: name the files px, nx, py, ny, pz, nz (or right, left, top, bottom, front, back).' };
		if (faces[face]) return { error: 'Two files are the ' + face + ' face.' };
		faces[face] = f.image;
	}
	const size = faces.px.width;
	for (const face of FACES)
		if (faces[face].width !== size || faces[face].height !== size) return { error: 'The six faces must be square and the same size.' };
	return { faces };
}
