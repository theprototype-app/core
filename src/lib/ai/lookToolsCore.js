// Roadmap 85 L1-L5 — the PURE half of the look tools (imports nothing; the unit layer runs it):
// what a texture source may be, how a `materials` payload takes a map or new sampler state, a shader
// graph checked against the node catalog, a post stack request checked against the effect registry.

/** the texture slots L1 names → three's material key; both spellings are accepted */
export const MAP_SLOTS = /** @type {Record<string, string>} */ (
	Object.assign(Object.create(null), {
		albedo: 'map',
		map: 'map',
		normal: 'normalMap',
		normalMap: 'normalMap',
		roughness: 'roughnessMap',
		roughnessMap: 'roughnessMap',
		metalness: 'metalnessMap',
		metalnessMap: 'metalnessMap',
		emissive: 'emissiveMap',
		emissiveMap: 'emissiveMap',
		ao: 'aoMap',
		aoMap: 'aoMap'
	})
);

/** three's key → the word tools say */
export const SLOT_WORD = /** @type {Record<string, string>} */ ({
	map: 'albedo',
	normalMap: 'normal',
	roughnessMap: 'roughness',
	metalnessMap: 'metalness',
	emissiveMap: 'emissive',
	aoMap: 'ao'
});

/** slots holding COLOUR data (sRGB); the rest are raw numbers */
const COLOR_SLOTS = new Set(['map', 'emissiveMap']);
/** @param {string} key */
export const isColorSlot = (key) => COLOR_SLOTS.has(key);

/** how many bytes a URL texture may be */
export const URL_MAX_BYTES = 16 * 1024 * 1024;
/** the image types a URL may answer with (never SVG: nothing executed) */
export const URL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

/** a library content hash (sha-256 hex; older items may be shorter) */
const HASH = /^[0-9a-f]{16,128}$/i;

/**
 * Check a texture URL. https only, no credentials, no address a page should not reach on an agent's
 * say-so (loopback, private ranges, `.local`).
 * @param {string} url @returns {{ok: true, url: string} | {ok: false, error: string}}
 */
export function checkTextureUrl(url) {
	/** @type {URL} */
	let u;
	try {
		u = new URL(url);
	} catch {
		return { ok: false, error: 'not a URL' };
	}
	if (u.protocol !== 'https:') return { ok: false, error: 'https URLs only' };
	if (u.username || u.password) return { ok: false, error: 'a URL with a user name or password is refused' };
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const privateV4 = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateV4 || host.includes(':'))
		return { ok: false, error: 'a local or private address is refused' };
	return { ok: true, url: u.href };
}

/**
 * What the file's first bytes say it is, or null: a server's Content-Type is a claim, and these are
 * the only formats the texture path decodes.
 * @param {Uint8Array} b @returns {string | null}
 */
export function sniffImageType(b) {
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
	const tag = (/** @type {number} */ at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
	if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'image/webp';
	if (tag(4) === 'ftyp' && (tag(8) === 'avif' || tag(8) === 'avis')) return 'image/avif';
	return null;
}

/**
 * One texture source as given. A raw string that is neither stays refused (1.48.0's rule).
 * @param {any} value @returns {{clear: true} | {hash: string} | {url: string} | {error: string}}
 */
export function parseMapSource(value) {
	if (value === null) return { clear: true };
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		if (typeof value.hash === 'string') return parseMapSource(value.hash);
		if (typeof value.url === 'string') return parseMapSource(value.url);
	}
	if (typeof value !== 'string' || !value.trim()) return { error: 'takes a library image hash, an https URL, or null to clear' };
	const text = value.trim();
	if (HASH.test(text)) return { hash: text.toLowerCase() };
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
		const checked = checkTextureUrl(text);
		return checked.ok ? { url: checked.url } : { error: checked.error + ': ' + text.slice(0, 60) };
	}
	return { error: '"' + text.slice(0, 40) + '" is neither a library image hash nor an https URL' };
}

/**
 * The `maps` argument, read. @param {any} maps
 * @returns {{slots: Record<string, any>, errors: string[]}} slots keyed by three's key
 */
export function parseMaps(maps) {
	/** @type {Record<string, any>} */
	const slots = {};
	/** @type {string[]} */
	const errors = [];
	if (maps === undefined) return { slots, errors };
	if (!maps || typeof maps !== 'object' || Array.isArray(maps)) return { slots, errors: ['maps: an object like {"albedo": "<hash or https URL>", "normal": null}'] };
	for (const [word, value] of Object.entries(maps)) {
		const key = MAP_SLOTS[word];
		if (!key) {
			errors.push('maps.' + word + ': unknown slot — albedo, normal, roughness, metalness, emissive or ao');
			continue;
		}
		const source = parseMapSource(value);
		if ('error' in source) errors.push('maps.' + word + ': ' + source.error);
		else slots[key] = source;
	}
	return { slots, errors };
}

/**
 * A number three MULTIPLIES a map by, when it would hide the map: metalness 0 × any metalness map is
 * 0, and a black emissive × any emissive map is black. These are what the Inspector's user would set
 * by hand after seeing nothing happen; a value the call gives itself always wins.
 * @param {string[]} added three's keys of the maps this call sets
 * @param {{metalness?: number, emissive?: any}} current the material's numbers now (emissive as a hex string)
 * @param {Record<string, any>} given the fields of the call
 * @returns {Record<string, any>} fields to set as well
 */
export function fieldsForMaps(added, current, given) {
	/** @type {Record<string, any>} */
	const out = {};
	if (added.includes('metalnessMap') && given.metalness === undefined && !current.metalness) out.metalness = 1;
	if (added.includes('roughnessMap') && given.roughness === undefined) out.roughness = 1;
	if (added.includes('emissiveMap') && given.emissive === undefined && (!current.emissive || /^#?0{6}$/.test(String(current.emissive)))) out.emissive = '#ffffff';
	return out;
}

/**
 * The three texture JSON of a payload's slot, whichever map keys it holds.
 * @param {any} payload @param {number} slot @param {string[]} [only] three's keys
 * @returns {{key: string, texture: any}[]}
 */
export function payloadTextures(payload, slot, only) {
	const material = payload?.materials?.[slot];
	if (!material) return [];
	/** @type {{key: string, texture: any}[]} */
	const out = [];
	for (const key of Object.keys(SLOT_WORD)) {
		if (only && !only.includes(key)) continue;
		const id = material[key];
		if (!id) continue;
		const texture = (payload.textures ?? []).find((/** @type {any} */ t) => t.uuid === id);
		if (texture) out.push({ key, texture });
	}
	return out;
}

/**
 * Write tiling / offset / rotation on a slot's textures (L4). A texture shared with another slot gets
 * its own copy, so tiling one does not move the other. Tiling needs REPEAT or it smears the border.
 * @param {any} payload @param {number} slot @param {{tiling?: number[], offset?: number[], rotation?: number}} t
 * @param {string[] | undefined} only three's keys @param {() => string} newId
 * @returns {string[]} the slots written (three's keys)
 */
export function setPayloadTransform(payload, slot, t, only, newId) {
	const material = payload?.materials?.[slot];
	/** @type {string[]} */
	const written = [];
	if (!material) return written;
	for (const { key, texture } of payloadTextures(payload, slot, only)) {
		const sharedElsewhere = (payload.materials ?? []).some(
			(/** @type {any} */ m, /** @type {number} */ i) =>
				Object.keys(SLOT_WORD).some((k) => m[k] === texture.uuid && !(i === slot && k === key))
		);
		const target = sharedElsewhere ? { ...texture, uuid: newId() } : texture;
		if (sharedElsewhere) {
			payload.textures.push(target);
			material[key] = target.uuid;
		}
		if (t.tiling) target.repeat = [...t.tiling];
		if (t.offset) target.offset = [...t.offset];
		if (t.rotation !== undefined) {
			target.rotation = t.rotation;
			target.center = [0.5, 0.5]; // about the middle of the image, not its corner
		}
		const repeats = (target.repeat ?? [1, 1]).some((/** @type {number} */ n) => n !== 1) || (target.offset ?? [0, 0]).some((/** @type {number} */ n) => n !== 0);
		if (repeats) target.wrap = [1000, 1000]; // THREE.RepeatWrapping
		written.push(key);
	}
	return written;
}

/**
 * Check `{tiling, offset, rotation}`. @param {any} args
 * @returns {{tiling?: number[], offset?: number[], rotation?: number, errors: string[]}}
 */
export function parseUvTransform(args) {
	/** @type {{tiling?: number[], offset?: number[], rotation?: number, errors: string[]}} */
	const out = { errors: [] };
	const pair = (/** @type {any} */ v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n));
	if (args?.tiling !== undefined) {
		const v = typeof args.tiling === 'number' ? [args.tiling, args.tiling] : args.tiling;
		if (!pair(v) || v.some((/** @type {number} */ n) => Math.abs(n) > 1000 || n === 0)) out.errors.push('tiling: [u, v] (or one number), not 0, at most 1000');
		else out.tiling = v;
	}
	if (args?.offset !== undefined) {
		if (!pair(args.offset) || args.offset.some((/** @type {number} */ n) => Math.abs(n) > 1000)) out.errors.push('offset: [u, v], at most 1000');
		else out.offset = args.offset;
	}
	if (args?.rotation !== undefined) {
		if (!Number.isFinite(args.rotation)) out.errors.push('rotation: radians');
		else out.rotation = args.rotation;
	}
	return out;
}

/**
 * Per-face UV (the owner's connector row): project triangles along their mean normal so the face
 * group exactly fills 0..1, then tile, rotate about the middle and offset. Pure over the triangles
 * (`[{x,y,z},{x,y,z},{x,y,z}]`), which is what readTriangles gives.
 * @param {{x: number, y: number, z: number}[][]} tris @param {{tiling?: number[], offset?: number[], rotation?: number}} t
 * @returns {number[][][]} per triangle, three [u, v]
 */
export function projectFaceUvs(tris, t = {}) {
	const n = [0, 0, 0];
	for (const tri of tris) {
		const [a, b, c] = tri;
		const u = [b.x - a.x, b.y - a.y, b.z - a.z];
		const v = [c.x - a.x, c.y - a.y, c.z - a.z];
		n[0] += u[1] * v[2] - u[2] * v[1];
		n[1] += u[2] * v[0] - u[0] * v[2];
		n[2] += u[0] * v[1] - u[1] * v[0];
	}
	const len = Math.hypot(n[0], n[1], n[2]) || 1;
	const w = [n[0] / len, n[1] / len, n[2] / len];
	// the image's up is the world's up unless the face looks straight along it (a top or a bottom:
	// then -z, so a label on top reads from the front)
	const up = Math.abs(w[1]) > 0.99 ? [0, 0, w[1] > 0 ? -1 : 1] : [0, 1, 0];
	// right = up × normal: looking AT the face (against its normal), u runs to the viewer's right
	const r = [up[1] * w[2] - up[2] * w[1], up[2] * w[0] - up[0] * w[2], up[0] * w[1] - up[1] * w[0]];
	const rl = Math.hypot(r[0], r[1], r[2]) || 1;
	const right = [r[0] / rl, r[1] / rl, r[2] / rl];
	const top = [w[1] * right[2] - w[2] * right[1], w[2] * right[0] - w[0] * right[2], w[0] * right[1] - w[1] * right[0]];
	const dot = (/** @type {any} */ p, /** @type {number[]} */ d) => p.x * d[0] + p.y * d[1] + p.z * d[2];
	let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
	for (const tri of tris)
		for (const p of tri) {
			const a = dot(p, right), b = dot(p, top);
			uMin = Math.min(uMin, a); uMax = Math.max(uMax, a);
			vMin = Math.min(vMin, b); vMax = Math.max(vMax, b);
		}
	const su = uMax - uMin || 1;
	const sv = vMax - vMin || 1;
	const [tu, tv] = t.tiling ?? [1, 1];
	const [ou, ov] = t.offset ?? [0, 0];
	const cos = Math.cos(t.rotation ?? 0);
	const sin = Math.sin(t.rotation ?? 0);
	return tris.map((tri) =>
		tri.map((p) => {
			// fitted 0..1, centred for the rotation
			const a = (dot(p, right) - uMin) / su - 0.5;
			const b = (dot(p, top) - vMin) / sv - 0.5;
			const x = a * cos - b * sin;
			const y = a * sin + b * cos;
			return [(x + 0.5) * tu + ou, (y + 0.5) * tv + ov];
		})
	);
}

// ---- shader graphs --------------------------------------------------------------------------

/** how big a graph an agent may write (the editor has no limit; the wire does) */
export const SHADER_MAX_NODES = 200;
export const SHADER_MAX_EDGES = 400;

/**
 * Check a graph against the node catalog BEFORE it reaches the store: an unknown type or socket the
 * compiler would only half-explain ("Nothing is connected…"), said per node with what is allowed.
 * @param {{nodes: any[], edges: any[]}} graph
 * @param {(key: string) => any} defOf shaderNodeDef @param {string[]} allTypes
 * @param {(def: any, stageTaps: boolean) => string[]} [inputsOf]
 * @returns {string[]} errors
 */
export function checkShaderGraph(graph, defOf, allTypes, inputsOf) {
	/** @type {string[]} */
	const errors = [];
	const nodes = graph?.nodes ?? [];
	const edges = graph?.edges ?? [];
	if (nodes.length > SHADER_MAX_NODES) errors.push('too many nodes (' + nodes.length + ', the limit is ' + SHADER_MAX_NODES + ')');
	if (edges.length > SHADER_MAX_EDGES) errors.push('too many edges (' + edges.length + ', the limit is ' + SHADER_MAX_EDGES + ')');
	const byId = new Map();
	for (const node of nodes) {
		if (byId.has(node.id)) errors.push('node id "' + node.id + '" is used twice');
		byId.set(node.id, node);
		if (!defOf(node.type)) errors.push('node "' + node.id + '": unknown type "' + node.type + '" (one of: ' + allTypes.join(', ') + ')');
	}
	const socketNames = (/** @type {any[]} */ list) => (list ?? []).map((s) => s.name);
	for (const edge of edges) {
		const from = byId.get(edge.source);
		const to = byId.get(edge.target);
		const label = edge.source + (edge.sourceHandle ? '.' + edge.sourceHandle : '') + ' -> ' + edge.target + (edge.targetHandle ? '.' + edge.targetHandle : '');
		if (!from) {
			errors.push('edge ' + label + ': no node "' + edge.source + '"');
			continue;
		}
		if (!to) {
			errors.push('edge ' + label + ': no node "' + edge.target + '"');
			continue;
		}
		const fromDef = defOf(from.type);
		const toDef = defOf(to.type);
		if (fromDef && edge.sourceHandle && !socketNames(fromDef.outputs).includes(edge.sourceHandle))
			errors.push('edge ' + label + ': a ' + from.type + ' has no output "' + edge.sourceHandle + '" (' + socketNames(fromDef.outputs).join(', ') + ')');
		const inputs = toDef ? (inputsOf ? inputsOf(toDef, true) : socketNames(toDef.inputs)) : [];
		if (toDef && !edge.targetHandle) errors.push('edge ' + label + ': say which input of the ' + to.type + ' (' + inputs.join(', ') + ')');
		else if (toDef && !inputs.includes(edge.targetHandle)) errors.push('edge ' + label + ': a ' + to.type + ' has no input "' + edge.targetHandle + '" (' + inputs.join(', ') + ')');
	}
	return errors;
}

/**
 * A compiled graph's params as an agent reads them: which name a flow's `setuniform` node takes. Only a
 * float can be driven (the node's value socket is a number, flowRuntime "NUMBERS only").
 * @param {any[]} irUniforms @returns {{node: string, param: string, uniform: string, type: string, value: any, drivable: boolean}[]}
 */
export function uniformsOf(irUniforms) {
	return (irUniforms ?? [])
		.filter((u) => u && !u.clock && u.nodeId)
		.map((u) => ({ node: u.nodeId, param: u.param, uniform: u.name, type: u.type, value: u.hash !== undefined ? u.hash : u.value, drivable: u.type === 'float' }));
}

/**
 * Merge new nodes + edges into a graph: a node of a known id replaces it, an edge is added once.
 * @param {{nodes: any[], edges: any[]}} graph @param {{nodes: any[], edges: any[]}} add
 * @param {{nodes?: string[]}} [remove] node ids to drop first, with their edges
 */
export function mergeShaderGraph(graph, add, remove = {}) {
	const gone = new Set(remove.nodes ?? []);
	const nodes = graph.nodes.filter((n) => !gone.has(n.id));
	let edges = graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
	for (const node of add?.nodes ?? []) {
		const at = nodes.findIndex((n) => n.id === node.id);
		if (at >= 0) nodes[at] = { ...nodes[at], ...node, position: node.position ?? nodes[at].position, data: { ...nodes[at].data, ...node.data } };
		else nodes.push(node);
	}
	for (const edge of add?.edges ?? []) {
		// an input takes ONE wire, so a new one replaces what was there
		edges = edges.filter((e) => !(e.target === edge.target && (e.targetHandle ?? '') === (edge.targetHandle ?? '')));
		edges.push(edge);
	}
	return { nodes, edges };
}

// ---- the post stack -------------------------------------------------------------------------

/** how many effects one look may hold through this tool */
export const POST_MAX_EFFECTS = 24;

/**
 * Check one effect's params against its registry row. Numbers are clamped to the row's range, a select
 * must be one of its options, anything the row does not name is an error.
 * @param {any} def postEffectDef's row @param {any} params
 * @returns {{params: Record<string, any>, errors: string[]}}
 */
export function checkPostParams(def, params) {
	/** @type {Record<string, any>} */
	const out = {};
	/** @type {string[]} */
	const errors = [];
	if (params === undefined || params === null) return { params: out, errors };
	if (typeof params !== 'object' || Array.isArray(params)) return { params: out, errors: ['params: an object'] };
	const rows = def?.params ?? [];
	const known = rows.map((/** @type {any} */ p) => p.key);
	for (const [key, value] of Object.entries(params)) {
		const row = rows.find((/** @type {any} */ p) => p.key === key);
		if (!row) {
			errors.push('no param "' + key + '" (' + known.join(', ') + ')');
			continue;
		}
		if (row.type === 'select') {
			const options = (row.options ?? []).map((/** @type {any} */ o) => o.value);
			if (!options.includes(value)) errors.push(key + ': one of ' + options.join(', '));
			else out[key] = value;
		} else if (row.type === undefined || row.type === 'number' || row.type === 'range') {
			const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
			if (typeof n !== 'number' || !Number.isFinite(n)) errors.push(key + ': takes a number');
			else out[key] = Math.min(row.max ?? Infinity, Math.max(row.min ?? -Infinity, n));
		} else if (row.type === 'toggle' || row.type === 'boolean') {
			if (typeof value !== 'boolean') errors.push(key + ': true or false');
			else out[key] = value;
		} else if (typeof value === 'object') {
			errors.push(key + ': takes a plain value');
		} else out[key] = value;
	}
	return { params: out, errors };
}

/**
 * Plan a set_post call against the stack as it is: effects are found by id, else by kind (so a retry
 * does not stack a second bloom), else added. `replace` drops everything the call does not name.
 * @param {{effects: any[]}} stack
 * @param {{effects?: any[], replace?: boolean}} args
 * @param {(kind: string) => any} defOf @param {string[]} kinds
 * @returns {{ops: any[], errors: string[]}} ops in order: {op: 'add'|'edit'|'remove'|'move', …}
 */
export function planPost(stack, args, defOf, kinds) {
	/** @type {any[]} */
	const ops = [];
	/** @type {string[]} */
	const errors = [];
	const wanted = args.effects ?? [];
	if (!Array.isArray(wanted)) return { ops, errors: ['effects: a list'] };
	if (wanted.length > POST_MAX_EFFECTS) errors.push('effects: at most ' + POST_MAX_EFFECTS);
	const current = stack.effects ?? [];
	const named = new Set();
	wanted.forEach((e, i) => {
		const at = 'effects[' + i + ']';
		if (!e || typeof e !== 'object') return void errors.push(at + ': an object like {"kind": "bloom", "params": {"intensity": 1}}');
		const entry = e.id ? current.find((x) => x.id === e.id) : current.find((x) => x.kind === e.kind && !named.has(x.id));
		if (e.id && !entry) return void errors.push(at + ': no effect "' + e.id + '" in this look');
		const kind = entry?.kind ?? e.kind;
		const def = defOf(kind);
		if (!def) return void errors.push(at + ': unknown kind "' + String(kind).slice(0, 40) + '" (one of: ' + kinds.join(', ') + ')');
		if (kind === 'graph') return void errors.push(at + ': a graph effect is made with create_post_graph');
		if (entry) named.add(entry.id);
		if (e.remove === true) {
			if (entry) ops.push({ op: 'remove', id: entry.id, kind });
			return;
		}
		const checked = checkPostParams(def, e.params);
		for (const message of checked.errors) errors.push(at + ' (' + kind + '): ' + message);
		if (e.enabled !== undefined && typeof e.enabled !== 'boolean') errors.push(at + ': enabled is true or false');
		if (e.at !== undefined && !(Number.isInteger(e.at) && e.at >= 0)) errors.push(at + ': at is a position in the stack, from 0');
		ops.push(entry ? { op: 'edit', id: entry.id, kind, params: checked.params, enabled: e.enabled, at: e.at } : { op: 'add', kind, params: checked.params, enabled: e.enabled, at: e.at });
	});
	if (args.replace === true) for (const x of current) if (!named.has(x.id)) ops.unshift({ op: 'remove', id: x.id, kind: x.kind });
	return { ops, errors };
}
