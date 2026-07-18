import { get } from 'svelte/store';
import { objectsGroup, lockedObjects } from '../../stores/sceneStore.js';
import { peers } from '../../stores/appStore.js';
import { createGeometry, createLight, createGroup } from '$lib/geometries.svelte.js';
import { recordObjectPresence, recordTransform } from '$lib/history';
import {
	renameObject,
	toggleObjectVisibility,
	moveObjectToGroup,
	deleteObjectsByUuid
} from '$lib/objectActions';
import { setObjectColor, switchMaterialType, setMaterialParam } from '$lib/materialsHandler';
import { notifyExternalMove } from '$lib/flowRuntime';

// AI tool layer (roadmap #10, A4). Maps OpenAI-style function calls onto the
// existing REPLICATED mutation surface — every tool applies locally AND broadcasts
// AND records undo history, exactly like a human edit. Runs inside a history batch
// (ai/assistant.js) so one prompt = one undo step. Executors never throw: errors
// come back as JSON results so the model can self-correct.

/** Primitives createGeometry accepts (geometries.svelte.js:54 + customGeometries). */
export const PRIMITIVE_TYPES = [
	'Box',
	'Sphere',
	'Cylinder',
	'Cone',
	'Capsule',
	'Torus',
	'TorusKnot',
	'Ring',
	'Circle',
	'Plane',
	'Dodecahedron',
	'Icosahedron',
	'Octahedron',
	'Tetrahedron',
	'Tube',
	'Lathe',
	'Wedge',
	'Stairs',
	'Arch',
	'Corner'
];

export const LIGHT_TYPES = ['ambient', 'directional', 'hemisphere', 'point', 'spot', 'rectarea'];

/** A fresh uuid (crypto — avoids pulling THREE's untyped module into this file).
 * @returns {string} */
function genUuid() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** Sensible default constructor args per primitive (from primitivesCatalog).
 * @type {Record<string, number[]>} */
const DEFAULT_PARAMS = {
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

const MATERIAL_TYPES = [
	'MeshBasicMaterial',
	'MeshStandardMaterial',
	'MeshPhysicalMaterial',
	'MeshPhongMaterial',
	'MeshLambertMaterial',
	'MeshToonMaterial'
];

/** @param {number} n */
function r3(n) {
	return Math.round(n * 1000) / 1000;
}

/** @param {any} object @returns {any} */
function describeObject(object) {
	/** @type {any} */
	const out = {
		uuid: object.uuid,
		name: object.name || object.type,
		type: object.type,
		parentUuid: object.parent && object.parent.type === 'Group' ? object.parent.uuid : null,
		position: object.position.toArray().map(r3),
		rotation: [r3(object.rotation.x), r3(object.rotation.y), r3(object.rotation.z)],
		scale: object.scale.toArray().map(r3),
		visible: object.visible !== false
	};
	const material = object.material;
	if (material && !Array.isArray(material)) {
		out.materialType = material.type;
		if (material.color) out.color = '#' + material.color.getHexString();
	}
	return out;
}

/**
 * A compact, replication-identical snapshot of the scene for the model. Walks the
 * replicated objectsGroup only (scene-root helpers/env stay local). Capped so a
 * huge scene can't blow the context.
 * @param {number} [cap]
 * @returns {{objects: any[], truncated?: number}}
 */
export function summarizeScene(cap = 200) {
	const group = get(objectsGroup);
	/** @type {any[]} */
	const objects = [];
	let truncated = 0;
	if (group) {
		group.traverse((/** @type {any} */ object) => {
			if (object === group) return;
			if (objects.length >= cap) {
				truncated++;
				return;
			}
			objects.push(describeObject(object));
		});
	}
	return truncated ? { objects, truncated } : { objects };
}

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

/** @param {any} data */
function broadcast(data) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(data);
}

/** Is this object currently locked by ANOTHER peer? (lockedObjects = remote only)
 * @param {string} uuid */
function lockedByPeer(uuid) {
	return get(lockedObjects).some((/** @type {any} */ l) => l[1] === uuid);
}

/**
 * Move an object and replicate + record (mirrors alignToGround/transformSet).
 * @param {any} object @param {{position?: number[], rotation?: number[], scale?: number[]}} t
 */
function applyAiTransform(object, t) {
	if (!t.position && !t.rotation && !t.scale) return;
	const before = {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray()
	};
	if (t.position && t.position.length === 3) object.position.fromArray(t.position);
	if (t.rotation && t.rotation.length === 3)
		object.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2]);
	if (t.scale && t.scale.length === 3) object.scale.fromArray(t.scale);
	const after = {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray()
	};
	notifyExternalMove(object.uuid);
	objectsGroup.update((v) => v);
	broadcast({ type: 'move', uuid: object.uuid, pos: after.pos, rot: after.rot, scale: after.scale });
	recordTransform({ uuid: object.uuid, before, after });
}

/** @param {any} spec @returns {any} one created object's result */
function createOne(spec) {
	const uuid = genUuid();
	let created = null;
	if (spec.kind === 'light') {
		const type = String(spec.light || '').toLowerCase();
		if (!LIGHT_TYPES.includes(type)) return { error: 'unknown light "' + spec.light + '"; allowed: ' + LIGHT_TYPES.join(', ') };
		const command = '/light ' + type;
		createLight(command, uuid);
		created = objectOf(uuid);
		if (!created) return { error: 'light creation failed' };
		broadcast({ type: 'light', command, uuid });
	} else if (spec.kind === 'group') {
		const name = (spec.name || 'Group').replace(/\s+/g, '_');
		const command = '/group ' + name;
		createGroup(command, uuid);
		created = objectOf(uuid);
		if (!created) return { error: 'group creation failed' };
		broadcast({ type: 'group', command, uuid });
	} else {
		// primitive (default)
		const primitive = normalizePrimitive(spec.primitive);
		if (!primitive) return { error: 'unknown primitive "' + spec.primitive + '"; allowed: ' + PRIMITIVE_TYPES.join(', ') };
		const params =
			Array.isArray(spec.params) && spec.params.length
				? spec.params.slice(0, 4)
				: DEFAULT_PARAMS[primitive] || [];
		const command = ('/create ' + primitive + ' ' + params.join(' ')).trim();
		createGeometry(command, uuid);
		created = objectOf(uuid);
		if (!created) return { error: 'primitive creation failed' };
		broadcast({ type: 'create', command, uuid });
	}
	// record presence BEFORE edits: redo recreates the base, later batch entries
	// carry it to final state; undo reverses the edits then deletes.
	recordObjectPresence('create', created);

	if (spec.name && spec.kind !== 'group') renameObject(uuid, String(spec.name));
	applyAiTransform(created, spec);
	if (spec.color && created.material && !Array.isArray(created.material)) setObjectColor(uuid, String(spec.color));
	if (spec.parentUuid) {
		const parent = objectOf(spec.parentUuid);
		if (parent && parent.type === 'Group') moveObjectToGroup(uuid, spec.parentUuid);
	}
	return { uuid, name: created.name };
}

/** @param {any} raw @returns {string|null} */
function normalizePrimitive(raw) {
	if (!raw) return 'Box';
	const s = String(raw);
	const match = PRIMITIVE_TYPES.find((p) => p.toLowerCase() === s.toLowerCase());
	return match || null;
}

/** @param {any} spec @returns {any} */
function updateOne(spec) {
	const uuid = spec.uuid;
	const object = objectOf(uuid);
	if (!object) return { uuid, error: 'no object with that uuid' };
	if (lockedByPeer(uuid)) return { uuid, skipped: 'locked by another peer' };

	if (typeof spec.name === 'string') renameObject(uuid, spec.name);
	applyAiTransform(object, spec);
	if (spec.color && object.material && !Array.isArray(object.material)) setObjectColor(uuid, String(spec.color));
	if (spec.materialType) {
		const mt = MATERIAL_TYPES.find((m) => m.toLowerCase() === String(spec.materialType).toLowerCase());
		if (mt) switchMaterialType(uuid, mt, true);
	}
	if (spec.materialParams && typeof spec.materialParams === 'object') {
		for (const [key, value] of Object.entries(spec.materialParams)) setMaterialParam(uuid, key, value, true);
	}
	if (typeof spec.visible === 'boolean' && object.visible !== spec.visible) toggleObjectVisibility(uuid);
	if (spec.parentUuid) {
		if (spec.parentUuid === 'root') moveObjectToGroup(uuid, 'root');
		else {
			const parent = objectOf(spec.parentUuid);
			if (parent && parent.type === 'Group') moveObjectToGroup(uuid, spec.parentUuid);
		}
	}
	return { uuid, ok: true };
}

/**
 * Execute one tool call. Never throws — returns a JSON-serializable result.
 * @param {string} name
 * @param {any} args
 * @returns {Promise<any>}
 */
export async function executeAiTool(name, args) {
	try {
		switch (name) {
			case 'list_scene':
				return summarizeScene();

			case 'create_objects': {
				const specs = Array.isArray(args?.objects) ? args.objects : [];
				if (!specs.length) return { error: 'no objects provided' };
				const results = specs.map((/** @type {any} */ s) => createOne(s));
				return { created: results };
			}

			case 'update_objects': {
				const updates = Array.isArray(args?.updates) ? args.updates : [];
				if (!updates.length) return { error: 'no updates provided' };
				const results = updates.map((/** @type {any} */ u) => updateOne(u));
				return { updated: results };
			}

			case 'delete_objects': {
				const uuids = Array.isArray(args?.uuids) ? args.uuids : [];
				const allowed = uuids.filter((/** @type {string} */ u) => objectOf(u) && !lockedByPeer(u));
				const skipped = uuids.filter((/** @type {string} */ u) => !allowed.includes(u));
				const count = deleteObjectsByUuid(allowed);
				return { deleted: count, skipped };
			}

			case 'group_objects': {
				const members = Array.isArray(args?.memberUuids) ? args.memberUuids : [];
				const name = (args?.name || 'Group').replace(/\s+/g, '_');
				const groupUuid = genUuid();
				const command = '/group ' + name;
				createGroup(command, groupUuid);
				const group = objectOf(groupUuid);
				if (!group) return { error: 'group creation failed' };
				broadcast({ type: 'group', command, uuid: groupUuid });
				recordObjectPresence('create', group);
				const moved = [];
				for (const uuid of members) {
					if (objectOf(uuid) && !lockedByPeer(uuid)) {
						moveObjectToGroup(uuid, groupUuid);
						moved.push(uuid);
					}
				}
				return { groupUuid, name: group.name, members: moved };
			}

			case 'clear_scene': {
				if (!args?.confirm) return { error: 'clear_scene requires confirm: true' };
				const group = get(objectsGroup);
				const top = group ? group.children.map((/** @type {any} */ c) => c.uuid) : [];
				const count = deleteObjectsByUuid(top);
				return { cleared: count };
			}

			default:
				return { error: 'unknown tool: ' + name };
		}
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** OpenAI-format tool schemas. Batch-first so one prompt = few tool calls. */
export const AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'list_scene',
			description:
				'List every object currently in the scene with its uuid, name, type, parent, transform, material and color. Call this before editing so you use real uuids.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_objects',
			description:
				'Create one or more primitives, lights or empty groups in a single call. Ground is the y=0 plane; place objects so they rest ON it (a box of height h sits at y=h/2). Returns the new uuids.',
			parameters: {
				type: 'object',
				properties: {
					objects: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								kind: { type: 'string', enum: ['primitive', 'light', 'group'] },
								primitive: {
									type: 'string',
									enum: PRIMITIVE_TYPES,
									description: 'required when kind=primitive'
								},
								light: {
									type: 'string',
									enum: LIGHT_TYPES,
									description: 'required when kind=light'
								},
								params: {
									type: 'array',
									items: { type: 'number' },
									description:
										'up to 4 constructor args. Box=[w,h,d], Sphere=[radius], Cylinder=[rTop,rBottom,height], Cone=[radius,height], Plane=[w,h], Torus=[radius,tube]. Omit for sensible defaults.'
								},
								name: { type: 'string' },
								position: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' },
								rotation: {
									type: 'array',
									items: { type: 'number' },
									description: 'Euler radians [x,y,z]'
								},
								scale: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' },
								color: { type: 'string', description: 'hex like #ff8800 (meshes only)' },
								parentUuid: { type: 'string', description: 'uuid of an existing group to nest under' }
							},
							required: ['kind']
						}
					}
				},
				required: ['objects']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'update_objects',
			description:
				'Modify existing objects by uuid: move/rotate/scale, recolor, change material, rename, show/hide, or reparent. Batch many in one call.',
			parameters: {
				type: 'object',
				properties: {
					updates: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								uuid: { type: 'string' },
								name: { type: 'string' },
								position: { type: 'array', items: { type: 'number' } },
								rotation: { type: 'array', items: { type: 'number' } },
								scale: { type: 'array', items: { type: 'number' } },
								color: { type: 'string', description: 'hex #rrggbb' },
								materialType: {
									type: 'string',
									enum: MATERIAL_TYPES,
									description: 'swap the material class'
								},
								materialParams: {
									type: 'object',
									description: 'e.g. { "roughness": 0.2, "metalness": 1 }'
								},
								visible: { type: 'boolean' },
								parentUuid: {
									type: 'string',
									description: 'group uuid to nest under, or "root" to un-nest'
								}
							},
							required: ['uuid']
						}
					}
				},
				required: ['updates']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'delete_objects',
			description: 'Delete objects by uuid.',
			parameters: {
				type: 'object',
				properties: { uuids: { type: 'array', items: { type: 'string' } } },
				required: ['uuids']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'group_objects',
			description: 'Create a new group and move the given member objects into it. Returns the group uuid.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					memberUuids: { type: 'array', items: { type: 'string' } }
				},
				required: ['name', 'memberUuids']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'clear_scene',
			description: 'Delete ALL objects in the scene. Requires confirm:true. Use only when the user clearly asks to start over.',
			parameters: {
				type: 'object',
				properties: { confirm: { type: 'boolean' } },
				required: ['confirm']
			}
		}
	}
];

/** Build the system prompt with scene-building guidance. @returns {string} */
export function buildSystemPrompt() {
	return [
		'You are a 3D scene-building assistant embedded in a collaborative prototyping app.',
		'You build scenes by calling tools that create and arrange objects. Everything you do is',
		'replicated live to other people in the session and is undoable as a single step.',
		'',
		'Coordinate system: Y is up. The ground is the y=0 plane. Place objects so they rest on it',
		'(an object of height h is centered at y=h/2). Rotations are Euler angles in RADIANS.',
		'Colors are hex strings like #cc4422. Distances are in meters; keep scenes human-scaled',
		'(a chair ~1m, a house ~5-8m).',
		'',
		'Primitives: ' + PRIMITIVE_TYPES.join(', ') + '.',
		'Lights: ' + LIGHT_TYPES.join(', ') + '.',
		'',
		'Workflow: call list_scene first when modifying or referring to existing objects, and always',
		'use the real uuids it returns. Prefer batching many objects into ONE create_objects call',
		'(e.g. a grid of boxes) instead of many calls. Give objects clear names. When done, reply',
		'with a short plain-text summary of what you built — do not describe tool calls.'
	].join('\n');
}
