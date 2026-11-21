// 102 M2 — EXPORT FOR 3D PRINTING, the PURE half: binary STL and 3MF writers, their readers
// (the suites' round trip) and the manifold count. No THREE, no scene: a part arrives as
// WORLD-space triangles in METRES and leaves in MILLIMETRES (the printer's unit; 3MF declares
// it, STL has no unit field and every slicer reads mm), times the user's `scale`.
//
//  · STL: 80-byte header, uint32 count, 50 bytes per triangle (normal, three corners, u16 0).
//    One file, every part merged — STL has no notion of objects or colour.
//  · 3MF: an OPC zip (`[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model`), unit
//    millimeter, ONE <object> per part with its own colour through a <basematerials> group, so a
//    multi-colour printer (or a slicer's per-object filament) gets the scene's colours.
//  · MANIFOLD: welded edges (a quantized grid, 1e-5 m) used other than twice. A warning, never a
//    block: slicers repair small holes, and a person may be printing a flat sign on purpose.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

/**
 * @typedef {{name: string, positions: Float32Array, index: Uint32Array | null, color?: number[] | null}} PrintPart
 *   positions: world-space metres, xyz per vertex; index: triangles (null = consecutive triples);
 *   color: linear-free sRGB 0..1 [r, g, b] (null = none)
 */

/** metres → millimetres */
export const MM_PER_M = 1000;

/** triangles of a part @param {PrintPart} part */
export function partTriangles(part) {
	return Math.floor((part.index ? part.index.length : part.positions.length / 3) / 3);
}

/** the corner index of triangle t, corner c @param {PrintPart} part @param {number} t @param {number} c */
function corner(part, t, c) {
	return part.index ? part.index[t * 3 + c] : t * 3 + c;
}

/** world-space bounds of parts, in metres: {min, max, size} or null when empty @param {PrintPart[]} parts */
export function partsBounds(parts) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const part of parts)
		for (let i = 0; i < part.positions.length; i += 3)
			for (let a = 0; a < 3; a++) {
				const v = part.positions[i + a];
				if (v < min[a]) min[a] = v;
				if (v > max[a]) max[a] = v;
			}
	if (min[0] === Infinity) return null;
	return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * The scale that makes the longest side `mm` millimetres (the dialog's "longest side" field).
 * @param {number[]} sizeMetres @param {number} mm
 */
export function scaleForLongestSide(sizeMetres, mm) {
	const longest = Math.max(...sizeMetres);
	return longest > 0 && mm > 0 ? mm / (longest * MM_PER_M) : 1;
}

/** A Y-up scene to a Z-up print bed: (x, y, z) → (x, -z, y), and the result sits on z = 0 and
 * is centred on x/y, which is what every slicer expects of an imported part.
 * @param {PrintPart[]} parts @param {number} scale @returns {(p: Float32Array, i: number) => number[]} */
function bedTransform(parts, scale) {
	const b = partsBounds(parts);
	const cx = b ? (b.min[0] + b.max[0]) / 2 : 0;
	const cz = b ? (b.min[2] + b.max[2]) / 2 : 0;
	const y0 = b ? b.min[1] : 0;
	const k = MM_PER_M * scale;
	return (p, i) => [(p[i] - cx) * k, -(p[i + 2] - cz) * k, (p[i + 1] - y0) * k];
}

/**
 * Binary STL of every part, merged. PURE.
 * @param {PrintPart[]} parts @param {{scale?: number, header?: string}} [opts] @returns {ArrayBuffer}
 */
export function writeStl(parts, opts = {}) {
	const scale = opts.scale ?? 1;
	const total = parts.reduce((n, p) => n + partTriangles(p), 0);
	const buffer = new ArrayBuffer(84 + total * 50);
	const view = new DataView(buffer);
	const header = strToU8((opts.header ?? 'theprototype.app STL, millimetres').slice(0, 80));
	new Uint8Array(buffer, 0, header.length).set(header);
	view.setUint32(80, total, true);
	const bed = bedTransform(parts, scale);
	let at = 84;
	for (const part of parts) {
		const n = partTriangles(part);
		for (let t = 0; t < n; t++) {
			const a = bed(part.positions, corner(part, t, 0) * 3);
			const b = bed(part.positions, corner(part, t, 1) * 3);
			const c = bed(part.positions, corner(part, t, 2) * 3);
			const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
			const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
			let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
			const len = Math.hypot(nx, ny, nz) || 1;
			nx /= len;
			ny /= len;
			nz /= len;
			for (const v of [nx, ny, nz, ...a, ...b, ...c]) {
				view.setFloat32(at, v, true);
				at += 4;
			}
			view.setUint16(at, 0, true);
			at += 2;
		}
	}
	return buffer;
}

/** Read a binary STL back: its triangle count and corners (mm). For the suites. @param {ArrayBuffer} buffer */
export function readStl(buffer) {
	const view = new DataView(buffer);
	const count = view.getUint32(80, true);
	if (buffer.byteLength !== 84 + count * 50) throw new Error('not a binary STL: ' + buffer.byteLength + ' bytes for ' + count + ' triangles');
	const positions = new Float32Array(count * 9);
	for (let t = 0; t < count; t++) for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(84 + t * 50 + 12 + k * 4, true);
	return { triangles: count, positions };
}

/** @param {number} v */
const num = (v) => (Math.abs(v) < 1e-9 ? '0' : String(Math.round(v * 1e5) / 1e5));
/** @param {string} s */
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
/** @param {number[]} rgb 0..1 */
export function hexColor(rgb) {
	return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * The 3MF model document. Vertices are WELDED per part (exact float match) — 3MF is an indexed
 * format and a slicer's manifold test reads shared indices, not coincident corners. PURE.
 * @param {PrintPart[]} parts @param {{scale?: number}} [opts] @returns {string}
 */
export function threeMfModel(parts, opts = {}) {
	const bed = bedTransform(parts, opts.scale ?? 1);
	const colored = parts.filter((p) => p.color);
	/** @type {string[]} */
	const out = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
		' <metadata name="Application">theprototype.app</metadata>',
		' <resources>'
	];
	const materialsId = parts.length + 1;
	if (colored.length) {
		out.push('  <basematerials id="' + materialsId + '">');
		for (const p of colored) out.push('   <base name="' + xml(p.name || 'part') + '" displaycolor="' + hexColor(/** @type {number[]} */ (p.color)) + '" />');
		out.push('  </basematerials>');
	}
	let colorSlot = 0;
	parts.forEach((part, i) => {
		const id = i + 1;
		const material = part.color ? ' pid="' + materialsId + '" pindex="' + colorSlot++ + '"' : '';
		out.push('  <object id="' + id + '" type="model" name="' + xml(part.name || 'part ' + id) + '"' + material + '>', '   <mesh>', '    <vertices>');
		/** @type {Map<string, number>} */
		const weld = new Map();
		/** @type {number[]} */
		const remap = [];
		const count = part.positions.length / 3;
		for (let v = 0; v < count; v++) {
			const p = bed(part.positions, v * 3);
			const key = p.map(num).join(' ');
			let at = weld.get(key);
			if (at === undefined) {
				at = weld.size;
				weld.set(key, at);
				out.push('     <vertex x="' + num(p[0]) + '" y="' + num(p[1]) + '" z="' + num(p[2]) + '" />');
			}
			remap.push(at);
		}
		out.push('    </vertices>', '    <triangles>');
		const n = partTriangles(part);
		for (let t = 0; t < n; t++) {
			const a = remap[corner(part, t, 0)], b = remap[corner(part, t, 1)], c = remap[corner(part, t, 2)];
			if (a === b || b === c || a === c) continue; // a sliver that welded to a line
			out.push('     <triangle v1="' + a + '" v2="' + b + '" v3="' + c + '" />');
		}
		out.push('    </triangles>', '   </mesh>', '  </object>');
	});
	out.push(' </resources>', ' <build>');
	parts.forEach((_, i) => out.push('  <item objectid="' + (i + 1) + '" />'));
	out.push(' </build>', '</model>');
	return out.join('\n');
}

const CONTENT_TYPES =
	'<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" /></Types>';
const RELS =
	'<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" /></Relationships>';

/** A 3MF package of the parts. PURE. @param {PrintPart[]} parts @param {{scale?: number}} [opts] @returns {Uint8Array} */
export function write3mf(parts, opts = {}) {
	return zipSync(
		{
			'[Content_Types].xml': strToU8(CONTENT_TYPES),
			'_rels/.rels': strToU8(RELS),
			'3D/3dmodel.model': strToU8(threeMfModel(parts, opts))
		},
		{ level: 6 }
	);
}

/** Read a 3MF back: unit, objects with their triangle counts and colours. For the suites.
 * @param {Uint8Array} bytes */
export function read3mf(bytes) {
	const files = unzipSync(bytes);
	const model = files['3D/3dmodel.model'];
	if (!model || !files['[Content_Types].xml'] || !files['_rels/.rels']) throw new Error('not a 3MF package');
	const text = strFromU8(model);
	const unit = /<model[^>]*unit="([^"]+)"/.exec(text)?.[1] ?? '';
	const colors = [...text.matchAll(/displaycolor="(#[0-9A-F]{6})"/g)].map((m) => m[1]);
	const objects = [...text.matchAll(/<object [^>]*>([\s\S]*?)<\/object>/g)].map((m) => ({
		triangles: (m[1].match(/<triangle /g) ?? []).length,
		vertices: (m[1].match(/<vertex /g) ?? []).length
	}));
	return { unit, objects, colors, triangles: objects.reduce((n, o) => n + o.triangles, 0) };
}

/**
 * Open edges: welded edges (1e-5 m grid) used by other than exactly two triangles, over all
 * parts. 0 = watertight. PURE.
 * @param {PrintPart[]} parts
 */
export function openEdges(parts) {
	let open = 0;
	for (const part of parts) {
		/** @type {Map<string, number>} */
		const ids = new Map();
		const count = part.positions.length / 3;
		const id = new Uint32Array(count);
		for (let v = 0; v < count; v++) {
			const p = part.positions;
			const key = Math.round(p[v * 3] * 1e5) + ',' + Math.round(p[v * 3 + 1] * 1e5) + ',' + Math.round(p[v * 3 + 2] * 1e5);
			let at = ids.get(key);
			if (at === undefined) {
				at = ids.size;
				ids.set(key, at);
			}
			id[v] = at;
		}
		/** @type {Map<number, number>} */
		const use = new Map();
		const n = partTriangles(part);
		const stride = ids.size + 1;
		for (let t = 0; t < n; t++)
			for (let e = 0; e < 3; e++) {
				const a = id[corner(part, t, e)];
				const b = id[corner(part, t, (e + 1) % 3)];
				if (a === b) continue;
				const k = a < b ? a * stride + b : b * stride + a;
				use.set(k, (use.get(k) ?? 0) + 1);
			}
		for (const u of use.values()) if (u !== 2) open++;
	}
	return open;
}
