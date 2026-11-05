// 64-text TX7 — the agent's way to the ONE text object. No new connector tool names: these are
// FINE tools behind existing families (tools/agent/src/catalog.js): create_shape {action: 'text'}
// -> create_text, assets {action: 'fonts'} -> list_fonts, and edit_shape {action: 'params'} ->
// set_geometry, which hands a text object's params to `setTextOne` here.
//
// A font is a bundled one (id, name or style: "serif", "Noto Serif", "mono" …), a Library font
// `{asset: <hash>}` (an upload through import_file, or one listed by list_fonts), or ANY other
// name, which is taken as a Google Fonts family: fetched ONCE now and kept in the Library (never
// a run-time call). Every write goes through textPathEdit (replicated, one undo step, the device's
// character cap and the "solid text cannot follow a path" refusal both apply).

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { TEXT_FONTS, TEXT_ANCHORS, TEXT_QUALITIES, normalizeTextPath, textCharCap } from '../textPathCore.js';

export const TEXT_TOOL_NAMES = ['create_text', 'list_fonts'];

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid);

/** a bundled font by id, label or style word @param {string} s */
export function bundledFontFor(s) {
	const k = String(s ?? '').trim().toLowerCase();
	if (!k) return null;
	return (
		TEXT_FONTS.find((f) => f.id === k) ??
		TEXT_FONTS.find((f) => f.label.toLowerCase() === k) ??
		TEXT_FONTS.find((f) => f.kind === k || (k === 'sans-serif' && f.kind === 'sans') || (k === 'monospace' && f.kind === 'mono') || (k === 'pixel' && f.kind === 'display')) ??
		null
	);
}

/**
 * The font fields of a patch for whatever the agent named.
 * @param {any} font @param {{bold?: boolean, italic?: boolean}} face
 * @returns {Promise<{patch: any, note?: string} | {error: string}>}
 */
async function fontPatch(font, face) {
	if (font === undefined || font === null || font === '') return { patch: {} };
	if (typeof font === 'object' && typeof font.asset === 'string') {
		const tf = await import('../textFonts.js');
		const info = await tf.fontAssetInfo(font.asset);
		if (!info) return { error: 'font.asset: no font with that hash in the Library (list them with assets {action: "fonts"}, or upload one with import_file)' };
		tf.shareFontAsset(font.asset);
		return { patch: { fontAsset: font.asset, fontName: info.family, fontMeta: { licence: info.licence, url: info.url, noEmbed: info.noEmbed } } };
	}
	if (typeof font !== 'string') return { error: 'font: a bundled font name, a Google Fonts family name, or {asset: "<hash>"}' };
	const bundled = bundledFontFor(font);
	if (bundled) return { patch: { font: bundled.id, fontAsset: null } };
	const tf = await import('../textFonts.js');
	const added = await tf.addGoogleFont(font, face);
	if (!added.ok) return { error: 'font: ' + added.error };
	tf.shareFontAsset(added.font.hash);
	return {
		patch: { fontAsset: added.font.hash, fontName: added.font.family, fontMeta: { licence: added.font.licence, url: added.font.url, noEmbed: added.font.noEmbed } },
		note: 'Google font "' + added.font.family + '" was added to the Library once; nobody calls Google again'
	};
}

/** agent words -> record fields (only what was given) @param {any} a */
function recordPatch(a) {
	/** @type {Record<string, any>} */
	const p = {};
	if (typeof a.text === 'string') p.text = a.text;
	const num = (/** @type {string} */ k, /** @type {string} */ to = k) => {
		if (typeof a[k] === 'number' && Number.isFinite(a[k])) p[to] = a[k];
	};
	num('size');
	num('depth');
	num('maxWidth');
	num('lineHeight');
	num('letterSpacing', 'spacing');
	num('spacing');
	num('emissive');
	num('metalness');
	num('roughness');
	num('outline');
	if (typeof a.bold === 'boolean') p.bold = a.bold;
	if (typeof a.italic === 'boolean') p.italic = a.italic;
	if (typeof a.color === 'string') p.color = a.color;
	if (typeof a.sideColor === 'string' || a.sideColor === null) p.sideColor = a.sideColor;
	if (typeof a.align === 'string') p.align = /** @type {Record<string, string>} */ ({ left: 'start', right: 'end', justify: 'fit', centre: 'center' })[a.align] ?? a.align;
	if (typeof a.anchor === 'string') p.anchor = a.anchor.replace('centre', 'center');
	if (typeof a.quality === 'string') p.quality = a.quality;
	if (a.bevel === false || a.bevel === 0) p.bevel = { size: 0 };
	else if (typeof a.bevel === 'number') p.bevel = { size: a.bevel, thickness: a.bevel };
	else if (a.bevel && typeof a.bevel === 'object') p.bevel = { ...a.bevel };
	if (typeof a.solid === 'boolean') p.mode = a.solid ? 'extruded' : 'flat';
	else if (a.mode === 'flat' || a.mode === 'extruded' || a.mode === 'solid') p.mode = a.mode === 'flat' ? 'flat' : 'extruded';
	// asking for depth or a bevel means solid letters
	else if (p.depth !== undefined || (p.bevel && p.bevel.size > 0)) p.mode = 'extruded';
	return p;
}

/** what the agent sees of a text @param {any} object */
export function textSummary(object) {
	const r = normalizeTextPath(object.userData.textPath);
	return {
		uuid: object.uuid,
		name: object.name,
		text: r.text,
		mode: r.mode === 'extruded' ? 'solid' : 'flat',
		font: r.fontAsset ? { asset: r.fontAsset, name: r.fontName } : r.font,
		size: r.size,
		...(r.mode === 'extruded' ? { depth: r.depth, bevel: r.bevel } : {}),
		align: r.align,
		anchor: r.anchor,
		maxWidth: r.maxWidth,
		color: r.color,
		position: object.position.toArray().map((/** @type {number} */ v) => Math.round(v * 1000) / 1000)
	};
}

/**
 * edit_shape {params} on a text object.
 * @param {string} uuid @param {any} params
 */
export async function setTextOne(uuid, params) {
	const object = objectOf(uuid);
	if (!object?.userData?.textPath) return { uuid, error: 'not a text object' };
	const a = params && typeof params === 'object' ? params : {};
	const rec = normalizeTextPath(object.userData.textPath);
	const f = await fontPatch(a.font, { bold: a.bold ?? rec.bold, italic: a.italic ?? rec.italic });
	if ('error' in f) return { uuid, ok: false, errors: [f.error] };
	const patch = { ...recordPatch(a), ...f.patch };
	if (!Object.keys(patch).length) return { uuid, ok: false, errors: ['nothing to change: give text, font, size, depth, bevel, align, maxWidth, anchor, color …'] };
	const edit = await import('../textPathEdit.js');
	const next = edit.setTextPathFor(uuid, patch);
	if (!next) return { uuid, ok: false, errors: [edit.lastTextRefusal() ?? 'not changed'] };
	return { uuid, ok: true, text: textSummary(object), ...(f.note ? { note: f.note } : {}) };
}

/** @param {any} args */
async function createTextTool(args) {
	const a = args ?? {};
	if (typeof a.text !== 'string' || !a.text.trim()) return { error: 'text: the words to show (line breaks with \\n)' };
	const f = await fontPatch(a.font, { bold: !!a.bold, italic: !!a.italic });
	if ('error' in f) return { error: f.error };
	const patch = { ...recordPatch(a), ...f.patch };
	const at = Array.isArray(a.position) && a.position.length === 3 && a.position.every((/** @type {any} */ n) => Number.isFinite(n)) ? a.position : null;
	const edit = await import('../textPathEdit.js');
	const made = edit.createTextObject(patch, at);
	if ('error' in made) return { error: made.error };
	const object = made.object;
	if (typeof a.name === 'string' && a.name.trim()) object.name = a.name.trim().slice(0, 80);
	if (Array.isArray(a.rotation) && a.rotation.length === 3 && a.rotation.every((/** @type {any} */ n) => Number.isFinite(n))) {
		// replicated + recorded like any AI move (tools.js imports this module: reached lazily)
		(await import('./tools.js')).applyAiTransform(object, { rotation: a.rotation });
	}
	return {
		created: textSummary(object),
		...(f.note ? { note: f.note } : {}),
		hint: 'Solid text is built on every screen from these settings (never sent as a mesh). Change it with edit_shape {action: "params"}; turn it into an editable mesh with Bake to mesh in the Inspector.'
	};
}

async function listFontsTool() {
	const tf = await import('../textFonts.js');
	const scene = tf.sceneFonts();
	const lib = tf.libraryFonts();
	return {
		bundled: tf.bundledFonts().map((f) => ({ font: f.id, name: f.label, style: f.kind })),
		library: lib.map((f) => ({ font: { asset: f.hash }, name: f.family, file: f.name, ...(f.licence ? { licence: f.licence } : {}), ...(f.noEmbed ? { noEmbedding: true } : {}) })),
		inScene: {
			bundled: scene.bundled.map((b) => ({ font: b.id, texts: b.texts })),
			library: scene.assets.map((a) => ({ font: { asset: a.hash }, name: a.family, texts: a.texts }))
		},
		hint: 'Any other name is fetched once from Google Fonts by family name (e.g. "Lobster"). Upload a TTF / OTF / WOFF / WOFF2 with import_file; it becomes a Library font.',
		caps: { flat: textCharCap('flat', 'desktop'), solid: textCharCap('extruded', 'desktop'), phoneOrHeadset: { flat: textCharCap('flat', 'low'), solid: textCharCap('extruded', 'low') } }
	};
}

/** @param {string} name @param {any} args */
export async function textTool(name, args) {
	if (name === 'create_text') return createTextTool(args);
	if (name === 'list_fonts') return listFontsTool();
	return { error: 'unknown text tool ' + name };
}

const V3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

/** the text fields create_text takes and set_geometry's params take for a text */
export const TEXT_PARAM_PROPS = {
	text: { type: 'string', description: 'the words; \\n breaks a line' },
	font: {
		description:
			'a bundled font (sans, serif, mono, rounded, display — or its name: Noto Sans, Noto Serif, IBM Plex Mono, Nunito, Press Start 2P, IBM Plex Sans), ANY Google Fonts family name (fetched once, kept in the Library), or {asset: "<hash>"} for a Library font'
	},
	size: { type: 'number', description: 'letter height (the em) in metres, default 0.4' },
	solid: { type: 'boolean', description: 'true = solid 3D letters (extruded); false = flat. depth or bevel imply solid' },
	depth: { type: 'number', description: 'solid: thickness in metres (default 0.1)' },
	bevel: { description: 'solid: bevel width in metres, false for none, or {size, thickness, segments}' },
	align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
	maxWidth: { type: 'number', description: 'wrap lines at this width in metres; 0 = no wrapping' },
	anchor: { type: 'string', enum: [...TEXT_ANCHORS], description: 'where the block sits around its position (default middle-center)' },
	lineHeight: { type: 'number', description: 'in ems, default 1.2' },
	letterSpacing: { type: 'number', description: 'extra space between letters, in ems' },
	bold: { type: 'boolean', description: 'flat Noto Sans and Google fonts' },
	italic: { type: 'boolean' },
	color: { type: 'string', description: 'hex #rrggbb (the face colour of solid text)' },
	sideColor: { type: 'string', description: 'solid: hex colour of the sides (default a shade of color)' },
	emissive: { type: 'number', description: 'solid: glow 0..4' },
	metalness: { type: 'number' },
	roughness: { type: 'number' },
	quality: { type: 'string', enum: [...TEXT_QUALITIES], description: 'solid: curve smoothness (triangles)' },
	outline: { type: 'number', description: 'flat: outline width in ems (0..0.3)' }
};

export const TEXT_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'create_text',
			description:
				'Add a 3D text object: a sign, a title, a label. Flat letters by default; solid (extruded) letters with depth and a bevel when solid: true or depth / bevel are given. Fonts: bundled, any Google Fonts family by name, or a Library font {asset}. Solid text holds up to 300 characters (80 on a phone or headset), flat 2000. Returns its uuid; change it later with set_geometry params.',
			parameters: {
				type: 'object',
				properties: {
					...TEXT_PARAM_PROPS,
					name: { type: 'string' },
					position: { ...V3, description: 'world point, metres (default: in front of the camera)' },
					rotation: { ...V3, description: 'Euler radians' }
				},
				required: ['text']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_fonts',
			description: 'The fonts 3D text can use: the bundled ones, the Library\'s (uploads and Google fonts, with their licences), and which the scene\'s texts use. Read only.',
			parameters: { type: 'object', properties: {} }
		}
	}
];

export const TEXT_PROMPT =
	'\n3D text: create_text makes a sign, title or label (flat, or solid with depth + bevel; font = bundled, a Google Fonts family name, or a Library font {asset}); set_geometry params on a text change its words, font, size, depth, bevel, align, maxWidth, anchor; list_fonts lists fonts.';
