// Pure message builders + catalogs for the theprototype.app peer protocol.
// No peerjs / THREE imports — trivially unit-testable. The catalogs mirror the
// app (same-version assumption, golden rule 4); source references below.

// geometries.svelte.js:54 + customGeometries (Wedge/Stairs/Arch/Corner)
export const PRIMITIVES = [
	'Box',
	'Capsule',
	'Circle',
	'Cone',
	'Cylinder',
	'Dodecahedron',
	'Icosahedron',
	'Octahedron',
	'Plane',
	'Ring',
	'Sphere',
	'Tetrahedron',
	'Torus',
	'TorusKnot',
	'Tube',
	'Lathe',
	'Wedge',
	'Stairs',
	'Arch',
	'Corner'
];

// createLight() in geometries.svelte.js
export const LIGHTS = ['ambient', 'directional', 'point', 'spot', 'hemisphere', 'rectarea'];

// materialsHandler.js MATERIAL_TYPES (subset the agent exposes)
export const MATERIALS = [
	'MeshBasicMaterial',
	'MeshStandardMaterial',
	'MeshPhysicalMaterial',
	'MeshPhongMaterial',
	'MeshLambertMaterial',
	'MeshToonMaterial'
];

/** Sensible constructor args per primitive (primitivesCatalog.js). */
export const DEFAULT_PARAMS = {
	Box: [2, 2, 2],
	Sphere: [1],
	Cylinder: [1, 1, 2],
	Cone: [1, 2],
	Capsule: [0.5, 1],
	Torus: [1, 0.4],
	TorusKnot: [1, 0.3],
	Ring: [0.5, 1],
	Circle: [1],
	Plane: [4, 4],
	Dodecahedron: [1],
	Icosahedron: [1],
	Octahedron: [1],
	Tetrahedron: [1],
	Wedge: [2, 1, 2],
	Stairs: [2, 1.5, 2, 6],
	Arch: [2, 2, 0.5],
	Corner: [2, 2, 0.25]
};

/** @param {string} raw @returns {string|null} */
export function normalizePrimitive(raw) {
	if (!raw) return null;
	const m = PRIMITIVES.find((p) => p.toLowerCase() === String(raw).toLowerCase());
	return m || null;
}
/** @param {string} raw @returns {string|null} */
export function normalizeLight(raw) {
	if (!raw) return null;
	const s = String(raw).toLowerCase();
	return LIGHTS.includes(s) ? s : null;
}
/** @param {string} raw @returns {string|null} */
export function normalizeMaterial(raw) {
	if (!raw) return null;
	const m = MATERIALS.find((x) => x.toLowerCase() === String(raw).toLowerCase());
	return m || null;
}

/** RFC4122 uuid (crypto). @returns {string} */
export function uuid() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

const num3 = (a, fallback) =>
	Array.isArray(a) && a.length === 3 ? a.map(Number) : fallback;

// ---- mutation messages (receive-side verified in peerHandler/commandsHandler) ----

/** @param {string} id @param {string} primitive @param {number[]} [params] */
export function createMsg(id, primitive, params) {
	const p = normalizePrimitive(primitive);
	if (!p) throw new Error('unknown primitive "' + primitive + '"; allowed: ' + PRIMITIVES.join(', '));
	const args = Array.isArray(params) && params.length ? params.slice(0, 4) : DEFAULT_PARAMS[p] || [];
	return { type: 'create', command: ('/create ' + p + ' ' + args.join(' ')).trim(), uuid: id, primitive: p };
}
/** @param {string} id @param {string} light */
export function lightMsg(id, light) {
	const l = normalizeLight(light);
	if (!l) throw new Error('unknown light "' + light + '"; allowed: ' + LIGHTS.join(', '));
	return { type: 'light', command: '/light ' + l, uuid: id, light: l };
}
/** @param {string} id @param {string} name */
export function groupCreateMsg(id, name) {
	const clean = String(name || 'Group').replace(/\s+/g, '_');
	return { type: 'group', command: '/group ' + clean, uuid: id };
}
/** @param {string} id @param {string} groupUuid ('up' un-nests one level) */
export function groupReparentMsg(id, groupUuid) {
	return { type: 'group', uuid: id, group: groupUuid };
}
/** @param {string} id @param {number[]} pos @param {number[]} rot @param {number[]} scale */
export function moveMsg(id, pos, rot, scale) {
	return {
		type: 'move',
		uuid: id,
		pos: num3(pos, [0, 0, 0]),
		rot: num3(rot, [0, 0, 0]),
		scale: num3(scale, [1, 1, 1])
	};
}
/** @param {string} id @param {string} hex */
export function colorMsg(id, hex) {
	return { type: 'color', uuid: id, color: hex };
}
/** @param {string} id @param {string} name */
export function nameMsg(id, name) {
	return { type: 'name', uuid: id, name: String(name) };
}
/** @param {string} id @param {string} peerId */
export function deleteMsg(id, peerId) {
	return { type: 'delete', uuid: id, peerId };
}
/** @param {string} id @param {string} key @param {any} value */
export function materialParamMsg(id, key, value) {
	return { type: 'objectParameters', parameter: 'materialParam', uuid: id, key, value };
}
/** @param {string} id @param {string} material */
export function materialTypeMsg(id, material) {
	const m = normalizeMaterial(material);
	if (!m) throw new Error('unknown material "' + material + '"; allowed: ' + MATERIALS.join(', '));
	return { type: 'objectParameters', parameter: 'material', uuid: id, material: m };
}
/** @param {string} id @param {boolean} visible */
export function visibleMsg(id, visible) {
	return { type: 'objectParameters', parameter: 'visible', uuid: id, visible: !!visible };
}

// ---- handshake messages (minimal; NO modules/environment/get* — see B1 notes) ----

/** @param {string} agentId @param {string[]} hosts */
export function hostsMsg(agentId, hosts) {
	return { type: 'hosts', hosts: hosts && hosts.length ? hosts : [agentId] };
}
/** @param {string} agentId @param {string} name */
export function userdataMsg(agentId, name) {
	// row = [peerId, username, avatarUrl, spectator?, fov?, avatarConfig?] (Scene.svelte:63)
	return { type: 'userdata', userdata: [[agentId, name || 'agent', '']] };
}
export function lockedMsg() {
	return { type: 'locked', lockeditems: [] };
}
