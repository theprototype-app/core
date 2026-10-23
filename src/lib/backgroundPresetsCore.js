// 65 M2 — the BACKGROUND PRESET format, as pure rules (imports NOTHING, so the vitest layer
// runs it with no browser): what a packs preset index and a preset document may hold, and
// the one preset core ships itself so an offline or fresh build is never empty.
//
// THE PRESETS LIVE IN THE PACKS REPO (`backgrounds/`, built by its tools/backgrounds/build.cjs),
// read over the same pinned jsDelivr ref as the Explorer packs. Each one is an ORDINARY
// background-domain shader graph — the postGraphPresets reasoning: anything a preset does is
// something a person could build node by node, so a preset teaches the vocabulary instead of
// hiding it. Applying one COPIES it into the scene's `background` document; the scene never
// points at the CDN, so a saved, exported or replicated scene does not need the packs repo.

/** The newest preset document format this build reads. A NEWER file is refused by name rather
 * than half-read: a field this build does not know might be the one that makes it work. */
export const PRESET_FORMAT = 1;

/** A preset key: lower-case words and dashes (the file name stem). */
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The preset LIST from `backgrounds/index.json`. Bad rows are DROPPED, not fatal: one broken
 * row in a CDN file must not take the whole picker down.
 * @param {any} raw
 * @returns {{ok: boolean, error?: string, presets: {key: string, label: string, hint: string, file: string}[]}}
 */
export function normalizePresetIndex(raw) {
	if (!raw || typeof raw !== 'object') return { ok: false, error: 'The preset list is not JSON.', presets: [] };
	const format = Number(raw.format ?? 1);
	if (!Number.isFinite(format) || format > PRESET_FORMAT)
		return { ok: false, error: 'The preset list is a newer format (' + raw.format + ') than this app reads.', presets: [] };
	const rows = Array.isArray(raw.presets) ? raw.presets : [];
	/** @type {{key: string, label: string, hint: string, file: string}[]} */
	const presets = [];
	const seen = new Set();
	for (const row of rows) {
		const key = typeof row?.key === 'string' ? row.key : '';
		if (!KEY_RE.test(key) || seen.has(key)) continue;
		const file = typeof row.file === 'string' && /^[A-Za-z0-9._-]+\.json$/.test(row.file) ? row.file : key + '.json';
		seen.add(key);
		presets.push({
			key,
			label: typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 60) : key,
			hint: typeof row.hint === 'string' ? row.hint.trim().slice(0, 240) : '',
			file
		});
	}
	return { ok: true, presets };
}

/**
 * One preset DOCUMENT. Returns the graph ready for `setShaderGraphFor('background', …)`,
 * or an error a person can read. Only the shape is checked here — whether the graph
 * COMPILES is the compiler's question, asked when it is applied.
 * @param {any} raw @param {string} [key]
 * @returns {{ok: true, doc: {domain: 'background', name: string, preset: string, nodes: any[], edges: any[], layer: {pointer: boolean, scroll: boolean}}} | {ok: false, error: string}}
 */
export function normalizePresetDoc(raw, key = '') {
	if (!raw || typeof raw !== 'object') return { ok: false, error: 'The preset "' + key + '" is not JSON.' };
	const format = Number(raw.format ?? 1);
	if (!Number.isFinite(format) || format > PRESET_FORMAT)
		return { ok: false, error: 'The preset "' + key + '" is a newer format than this app reads — update the app.' };
	if (raw.domain !== 'background') return { ok: false, error: 'The preset "' + key + '" is not a background graph.' };
	const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter((/** @type {any} */ n) => n && typeof n.id === 'string' && typeof n.type === 'string') : [];
	const edges = Array.isArray(raw.edges)
		? raw.edges.filter((/** @type {any} */ e) => e && typeof e.source === 'string' && typeof e.target === 'string')
		: [];
	if (!nodes.some((/** @type {any} */ n) => n.type === 'backgroundOutput'))
		return { ok: false, error: 'The preset "' + key + '" has no Background output node.' };
	// an edge into a node that is not there would be the compiler's "points at a node that
	// does not exist" — drop it here so a hand-edited file degrades rather than refuses
	const ids = new Set(nodes.map((/** @type {any} */ n) => n.id));
	return {
		ok: true,
		doc: {
			domain: 'background',
			name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : key || 'Background',
			preset: typeof raw.preset === 'string' ? raw.preset : key,
			nodes: nodes.map((/** @type {any} */ n) => ({ ...n, data: n.data && typeof n.data === 'object' ? n.data : {} })),
			edges: edges.filter((/** @type {any} */ e) => ids.has(e.source) && ids.has(e.target)),
			layer: { pointer: raw.layer?.pointer !== false, scroll: raw.layer?.scroll === true }
		}
	};
}

/** The editor's canonical edge id shape, handles included. */
const edge = (/** @type {string} */ s, /** @type {string} */ sh, /** @type {string} */ t, /** @type {string} */ th) => ({
	id: 'e-' + s + '.' + sh + '-' + t + '.' + th,
	source: s,
	sourceHandle: sh,
	target: t,
	targetHandle: th
});
const node = (/** @type {string} */ id, /** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, data = {}) => ({
	id,
	type,
	position: { x, y },
	data
});

/** The key of the preset core ships itself. */
export const BUILTIN_PRESET_KEY = 'soft-gradient';

/**
 * The ONE built-in: a calm two-tone gradient with a soft glow under the pointer. Small on
 * purpose — it exists so the picker is never empty offline and so a fresh clone can test the
 * layer with no CDN, not to compete with the pack.
 */
export function builtinPresetDoc() {
	return {
		format: PRESET_FORMAT,
		domain: 'background',
		name: 'Soft gradient',
		preset: BUILTIN_PRESET_KEY,
		layer: { pointer: true, scroll: false },
		nodes: [
			node('uv', 'aspectUv', 40, 60),
			node('chan', 'split', 240, 40),
			node('ramp', 'gradient', 440, 40, { colorA: '#1b2340', colorB: '#3d4f8f', colorC: '#9fb4ff', mid: 0.55 }),
			node('ptr', 'pointer', 40, 260),
			node('ptrUv', 'aspectUv', 240, 260),
			node('dist', 'distance', 440, 260),
			node('rise', 'smoothstep', 620, 260, { edge0: 0, edge1: 0.4 }),
			node('fall', 'oneMinus', 800, 260),
			node('amt', 'float', 800, 400, { value: 0.18 }),
			node('glow', 'multiply', 980, 280),
			node('lit', 'add', 1160, 120),
			node('out', 'backgroundOutput', 1360, 120)
		],
		edges: [
			edge('uv', 'out', 'chan', 'value'),
			edge('chan', 'y', 'ramp', 't'),
			edge('ptr', 'position', 'ptrUv', 'uv'),
			edge('uv', 'out', 'dist', 'a'),
			edge('ptrUv', 'out', 'dist', 'b'),
			edge('dist', 'out', 'rise', 'a'),
			edge('rise', 'out', 'fall', 'a'),
			edge('fall', 'out', 'glow', 'a'),
			edge('amt', 'out', 'glow', 'b'),
			edge('ramp', 'out', 'lit', 'a'),
			edge('glow', 'out', 'lit', 'b'),
			edge('lit', 'out', 'out', 'color')
		]
	};
}
