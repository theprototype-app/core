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
import { meshGenReady } from './meshProviders.js';
import { graphOf, SCENE_GRAPH } from '../../stores/flowStore';
import { sceneJoints } from '$lib/joints';
import {
	physicsToolsEnabled,
	aiNodeTypes,
	createFlowNodesTool,
	updateFlowNodesTool,
	setPhysicsTool,
	createJointsTool,
	controlSimulationTool
} from './flowTools.js';

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
	if (object.userData?.physics) out.physics = { ...object.userData.physics };
	const flow = summarizeGraph(object.uuid);
	if (flow) out.flow = flow;
	return out;
}

/** Node data compacted for the model: label/type dupes stripped, big point
 * lists reduced to a count, long strings clipped. @param {any} node */
function compactNodeData(node) {
	/** @type {any} */
	const out = {};
	for (const [key, value] of Object.entries(node.data ?? {})) {
		if (key === 'label' || key === 'type') continue;
		if (key === 'points' && Array.isArray(value) && value.length > 6) {
			out.points = value.length + ' points';
			continue;
		}
		if (typeof value === 'string' && value.length > 80) {
			out[key] = value.slice(0, 77) + '…';
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * Compact one graph document for the scene summary ("make the spider faster"
 * needs the node ids + data). Capped per graph so a node-heavy scene can't
 * blow the context.
 * @param {string} graphId @param {number} [cap]
 * @returns {{nodes: any[], edges?: any[], truncatedNodes?: number}|null}
 */
function summarizeGraph(graphId, cap = 12) {
	const graph = graphOf(graphId);
	if (!graph || (!graph.nodes.length && !graph.edges.length)) return null;
	/** @type {any} */
	const out = {
		nodes: graph.nodes
			.slice(0, cap)
			.map((/** @type {any} */ n) => ({ id: n.id, type: n.type, ...compactNodeData(n) }))
	};
	if (graph.nodes.length > cap) out.truncatedNodes = graph.nodes.length - cap;
	if (graph.edges.length)
		out.edges = graph.edges.map((/** @type {any} */ e) => ({
			from: e.source,
			to: e.target,
			...(e.sourceHandle ? { fromHandle: e.sourceHandle } : {}),
			...(e.targetHandle ? { toHandle: e.targetHandle } : {})
		}));
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
	/** @type {any} */
	const out = truncated ? { objects, truncated } : { objects };
	const sceneFlow = summarizeGraph(SCENE_GRAPH);
	if (sceneFlow) out.sceneFlow = sceneFlow;
	const joints = get(sceneJoints);
	if (joints.length)
		out.joints = joints.map((/** @type {any} */ j) => ({ id: j.id, kind: j.kind, a: j.a, b: j.b }));
	return out;
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

const TOOL_NAMES = [
	'list_scene',
	'create_objects',
	'update_objects',
	'delete_objects',
	'group_objects',
	'clear_scene',
	'generate_mesh',
	'create_flow_nodes',
	'update_flow_nodes',
	'set_physics',
	'create_joints',
	'control_simulation'
];

const SIM_ACTIONS = ['start', 'stop', 'pause', 'resume', 'reset'];

/** Common near-misses. Small local models invent singular/verb variants. */
const NAME_ALIASES = /** @type {Record<string,string>} */ ({
	create_object: 'create_objects',
	add_object: 'create_objects',
	add_objects: 'create_objects',
	create_primitive: 'create_objects',
	create_primitives: 'create_objects',
	spawn_object: 'create_objects',
	create: 'create_objects',
	add: 'create_objects',
	update_object: 'update_objects',
	modify_object: 'update_objects',
	modify_objects: 'update_objects',
	move_object: 'update_objects',
	move_objects: 'update_objects',
	set_color: 'update_objects',
	update: 'update_objects',
	delete_object: 'delete_objects',
	remove_object: 'delete_objects',
	remove_objects: 'delete_objects',
	delete: 'delete_objects',
	group_object: 'group_objects',
	group: 'group_objects',
	get_scene: 'list_scene',
	scene: 'list_scene',
	list_objects: 'list_scene',
	list: 'list_scene',
	clear: 'clear_scene',
	generate_model: 'generate_mesh',
	create_mesh: 'generate_mesh',
	// flow / behavior invention family
	add_behavior: 'create_flow_nodes',
	add_behaviour: 'create_flow_nodes',
	create_behavior: 'create_flow_nodes',
	animate: 'create_flow_nodes',
	animate_object: 'create_flow_nodes',
	add_animation: 'create_flow_nodes',
	add_node: 'create_flow_nodes',
	add_nodes: 'create_flow_nodes',
	add_flow_node: 'create_flow_nodes',
	add_flow_nodes: 'create_flow_nodes',
	create_flow_node: 'create_flow_nodes',
	create_nodes: 'create_flow_nodes',
	update_flow_node: 'update_flow_nodes',
	update_node: 'update_flow_nodes',
	update_nodes: 'update_flow_nodes',
	edit_node: 'update_flow_nodes',
	set_node_data: 'update_flow_nodes',
	remove_node: 'update_flow_nodes',
	remove_nodes: 'update_flow_nodes',
	delete_node: 'update_flow_nodes',
	delete_nodes: 'update_flow_nodes',
	// physics family
	enable_physics: 'set_physics',
	set_physic: 'set_physics',
	update_physics: 'set_physics',
	physics: 'set_physics',
	make_static: 'set_physics',
	make_dynamic: 'set_physics',
	set_mass: 'set_physics',
	create_joint: 'create_joints',
	add_joint: 'create_joints',
	add_joints: 'create_joints',
	hinge: 'create_joints',
	weld: 'create_joints',
	attach: 'create_joints',
	attach_objects: 'create_joints',
	connect_objects: 'create_joints',
	start_simulation: 'control_simulation',
	stop_simulation: 'control_simulation',
	pause_simulation: 'control_simulation',
	reset_simulation: 'control_simulation',
	run_simulation: 'control_simulation',
	simulate: 'control_simulation',
	simulation: 'control_simulation'
});

/** Alias hits landing on control_simulation carry the action IN THE NAME
 * ("start_simulation") more often than in args — fill it in.
 * @param {string} name @param {string} sourceKey @param {any} args */
function withActionFill(name, sourceKey, args) {
	if (name === 'control_simulation' && !args.action) {
		const action = SIM_ACTIONS.find((a) => sourceKey.includes(a)) ?? 'start';
		return { name, args: { ...args, action }, repaired: true };
	}
	return { name, args, repaired: true };
}

/**
 * Best-effort repair of a tool call from a weaker model: fix the NAME (case, aliases,
 * `functions.` prefixes) and, when the name is pure invention, infer the tool from the
 * ARGUMENT shape — a call like `Cube({kind:'primitive', primitive:'Box'})` is plainly a
 * one-object create_objects. Conservative: anything unrecognizable is returned as-is so
 * executeAiTool reports a proper error the model can correct.
 * @param {string} rawName
 * @param {any} rawArgs
 * @returns {{name: string, args: any, repaired: boolean}}
 */
export function repairToolCall(rawName, rawArgs) {
	const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
	const original = String(rawName || '');
	if (TOOL_NAMES.includes(original)) return { name: original, args, repaired: false };

	// `functions.create_objects`, `tool:create_objects`, "Create Objects", camelCase…
	const bare = original.split(/[.:]/).pop() || original;
	const key = bare.trim().toLowerCase().replace(/[\s-]+/g, '_');
	const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
	for (const candidate of [key, snake]) {
		if (TOOL_NAMES.includes(candidate)) return { name: candidate, args, repaired: true };
		if (NAME_ALIASES[candidate]) return withActionFill(NAME_ALIASES[candidate], candidate, args);
	}

	// name is invention — infer from the argument shape
	if (Array.isArray(args.objects)) return { name: 'create_objects', args, repaired: true };
	if (Array.isArray(args.nodes)) return { name: 'create_flow_nodes', args, repaired: true };
	if (Array.isArray(args.joints)) return { name: 'create_joints', args, repaired: true };
	if (typeof args.action === 'string' && SIM_ACTIONS.includes(args.action.toLowerCase()))
		return { name: 'control_simulation', args, repaired: true };
	if (Array.isArray(args.updates)) {
		// updates whose items carry ONLY physics keys route to set_physics
		const PHYS_KEYS = ['mass', 'restitution', 'bounciness', 'friction', 'mode', 'collider'];
		const OBJ_KEYS = ['position', 'rotation', 'scale', 'color', 'name', 'visible', 'materialType', 'materialParams', 'parentUuid'];
		const items = args.updates.filter((/** @type {any} */ u) => u && typeof u === 'object');
		const physicsOnly =
			items.length > 0 &&
			items.every(
				(/** @type {any} */ u) => PHYS_KEYS.some((k) => k in u) && !OBJ_KEYS.some((k) => k in u)
			);
		return { name: physicsOnly ? 'set_physics' : 'update_objects', args, repaired: true };
	}
	if (Array.isArray(args.uuids)) return { name: 'delete_objects', args, repaired: true };
	if (Array.isArray(args.memberUuids)) return { name: 'group_objects', args, repaired: true };
	// a single object spec passed directly (kind/primitive/light present)
	if (args.kind || args.primitive || args.light) {
		return { name: 'create_objects', args: { objects: [args] }, repaired: true };
	}
	// the invented name IS a primitive ("Cube", "sphere") with loose args
	const asPrimitive = normalizePrimitive(bare) || (/^cubes?$/i.test(bare) ? 'Box' : null);
	if (asPrimitive && (args.position || args.color || args.params || args.scale || args.name)) {
		return {
			name: 'create_objects',
			args: { objects: [{ ...args, kind: 'primitive', primitive: asPrimitive }] },
			repaired: true
		};
	}
	return { name: original, args, repaired: false };
}

/** Names stay in TOOL_NAMES even while gated OFF so repair still normalizes
 * them — the executor answers with this instead. */
const PHYSICS_DISABLED =
	'physics tools are disabled — enable "Physics tools" for this provider in Settings → AI';

/**
 * Execute one tool call. Never throws — returns a JSON-serializable result.
 * @param {string} rawName
 * @param {any} rawArgs
 * @returns {Promise<any>}
 */
export async function executeAiTool(rawName, rawArgs) {
	const { name, args } = repairToolCall(rawName, rawArgs);
	try {
		switch (name) {
			case 'list_scene':
				return summarizeScene();

			case 'create_objects': {
				const specs = Array.isArray(args?.objects) ? args.objects : [];
				if (!specs.length)
					return { error: 'no objects provided — pass objects: [{ kind: "primitive", primitive: "Box", ... }]' };
				const results = specs.map((/** @type {any} */ s) => createOne(s));
				// surface a total failure at the TOP level so the caller (and the undo
				// summary) doesn't count a no-op as an applied action
				if (results.every((/** @type {any} */ r) => r.error))
					return { error: 'nothing was created: ' + results[0].error, created: results };
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

			case 'create_flow_nodes':
				return createFlowNodesTool(args);

			case 'update_flow_nodes':
				return updateFlowNodesTool(args);

			case 'set_physics': {
				if (!physicsToolsEnabled()) return { error: PHYSICS_DISABLED };
				return setPhysicsTool(args);
			}

			case 'create_joints': {
				if (!physicsToolsEnabled()) return { error: PHYSICS_DISABLED };
				return createJointsTool(args);
			}

			case 'control_simulation': {
				if (!physicsToolsEnabled()) return { error: PHYSICS_DISABLED };
				return await controlSimulationTool(args);
			}

			case 'generate_mesh': {
				// LONG tool: generation takes minutes, so we DON'T block the chat loop.
				// Kick off the job and return immediately; the job runner places +
				// replicates the mesh when it lands (a progress card shows status).
				const prompt = String(args?.prompt || '').trim();
				if (!prompt) return { error: 'prompt required' };
				if (!meshGenReady()) return { error: 'no mesh-generation provider is configured (Settings -> AI -> Mesh generation)' };
				import('$lib/ai/meshJobs')
					.then((m) => m.generateMesh({ prompt, name: args?.name, position: args?.position }))
					.catch(() => {});
				return {
					started: true,
					note: 'Generating a 3D mesh from "' + prompt.slice(0, 60) + '". It will appear in the scene in ~1-3 minutes; a progress card shows status. Do not call generate_mesh again for the same request.'
				};
			}

			default:
				return {
					error:
						'unknown tool "' +
						rawName +
						'". Call one of: ' +
						TOOL_NAMES.join(', ') +
						'. To add objects use create_objects with { objects: [{ kind, primitive, position, color, name }] }.'
				};
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

/** The generate_mesh tool — only offered when a mesh provider is configured (it is
 * slow + costs credits, so we don't tempt the model with it otherwise). */
export const MESH_TOOL = {
	type: 'function',
	function: {
		name: 'generate_mesh',
		description:
			'Generate a NEW custom 3D mesh from a text description when no primitive fits (an organic prop, a detailed object, a character). SLOW (~1-3 min) and async — it returns immediately and the mesh appears in the scene when ready. Use sparingly; prefer primitives for simple/blocky shapes.',
		parameters: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: 'what to generate, e.g. "a weathered wooden treasure chest"' },
				name: { type: 'string' },
				position: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' }
			},
			required: ['prompt']
		}
	}
};

/** Flow-node tool schemas. Built per call — the node-type enum tracks the
 * physics gate (physics node types absent when gated off).
 * @param {boolean} physics @returns {any[]} */
function flowToolSchemas(physics) {
	const types = aiNodeTypes(physics);
	return [
		{
			type: 'function',
			function: {
				name: 'create_flow_nodes',
				description:
					'Add behavior (flow) nodes to a node graph — this is how objects get MOTION and interactivity: spin, bounce, patrol a path, pulse, blink, react to clicks. graph is "scene" or an object uuid (ONE graph per call). KEY RULE: a behavior node placed in an OBJECT\'s graph with no edges automatically drives that object — most behaviors are one node, zero edges, so usually OMIT edges.',
				parameters: {
					type: 'object',
					properties: {
						graph: {
							type: 'string',
							description: '"scene" or an existing object uuid (nodes in an object\'s graph drive that object)'
						},
						nodes: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									ref: {
										type: 'string',
										description: 'local key so edges in THIS call can reference the new node'
									},
									type: { type: 'string', enum: types },
									data: {
										type: 'object',
										description:
											'node params, e.g. spin {axis:"y",speed:2}; bounce {amplitude:0.5,speed:2}; pathpatrol {points:[[x,y,z],…] (>=2 world waypoints), speed:1, mode:"loop"|"pingpong"}; setcolor {color:"#ff0000"}. Omit for defaults.'
									}
								},
								required: ['type']
							}
						},
						edges: {
							type: 'array',
							description:
								'optional wires between nodes (by ref or existing node id). Usually OMIT — unwired behavior nodes already drive their graph\'s object.',
							items: {
								type: 'object',
								properties: {
									from: { type: 'string' },
									to: { type: 'string' },
									fromHandle: { type: 'string' },
									toHandle: { type: 'string' }
								},
								required: ['from', 'to']
							}
						}
					},
					required: ['graph', 'nodes']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'update_flow_nodes',
				description:
					'Tune or remove existing behavior nodes in one graph. Node ids and current data are in the scene summary under each object\'s "flow" (and "sceneFlow").',
				parameters: {
					type: 'object',
					properties: {
						graph: { type: 'string', description: '"scene" or an object uuid' },
						updates: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string' },
									data: { type: 'object', description: 'data keys to change, e.g. {speed: 3}' }
								},
								required: ['id', 'data']
							}
						},
						remove: { type: 'array', items: { type: 'string' }, description: 'node ids to delete' }
					},
					required: ['graph']
				}
			}
		}
	];
}

/** Physics tool schemas — only offered when the provider's "Physics tools"
 * checkbox is on (hard for small local models). */
const PHYSICS_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_physics',
			description:
				'Set physics body params on objects (batch). NOTE: new primitives already spawn dynamic with mass 1 — use this mostly to TUNE bodies or make scenery immovable (mode "static" for ground/walls). mode "auto" reverts to scenery defaults.',
			parameters: {
				type: 'object',
				properties: {
					updates: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								uuid: { type: 'string' },
								mode: { type: 'string', enum: ['auto', 'static', 'dynamic'] },
								mass: { type: 'number', description: 'kg; implies mode dynamic' },
								restitution: { type: 'number', description: 'bounciness 0..1' },
								friction: { type: 'number', description: '0..2' },
								collider: { type: 'string', enum: ['box', 'sphere', 'capsule', 'cylinder', 'hull'] },
								sensor: {
									type: 'boolean',
									description: 'true = a trigger volume: no collision response, fires On Enter/On Exit nodes'
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
			name: 'create_joints',
			description:
				'Attach object pairs with physics joints: "fixed" welds them rigidly, "revolute" hinges around an axis (optional motor spins it). Move parts to their final pose WORLD-ALIGNED (no rotation) before jointing.',
			parameters: {
				type: 'object',
				properties: {
					joints: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								kind: { type: 'string', enum: ['fixed', 'revolute'] },
								a: { type: 'string', description: 'uuid of the base object' },
								b: { type: 'string', description: 'uuid of the attached object (hinge anchors at its origin)' },
								axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'hinge axis (revolute only, default y)' },
								motor: {
									type: 'object',
									description: 'revolute only: {vel: rad/s, maxForce}',
									properties: { vel: { type: 'number' }, maxForce: { type: 'number' } }
								}
							},
							required: ['kind', 'a', 'b']
						}
					}
				},
				required: ['joints']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'control_simulation',
			description:
				'Start, stop, pause, resume or reset the physics simulation. After building a physics assembly, start the simulation so the user sees it move.',
			parameters: {
				type: 'object',
				properties: { action: { type: 'string', enum: ['start', 'stop', 'pause', 'resume', 'reset'] } },
				required: ['action']
			}
		}
	}
];

/** Toolset for the assistant — flow tools always; physics tools when the
 * provider checkbox is on; generate_mesh only when a mesh provider is ready.
 * Call this per turn (readiness can change). @returns {any[]} */
export function getAiTools() {
	const physics = physicsToolsEnabled();
	const tools = [...AI_TOOLS, ...flowToolSchemas(physics)];
	if (physics) tools.push(...PHYSICS_AI_TOOLS);
	if (meshGenReady()) tools.push(MESH_TOOL);
	return tools;
}

/** Build the system prompt with scene-building guidance. @returns {string} */
export function buildSystemPrompt() {
	const meshLine = meshGenReady()
		? '\nCustom meshes: for objects no primitive can approximate, call generate_mesh with a text\ndescription (slow, async — it appears shortly). Prefer primitives for simple shapes.'
		: '';
	const physics = physicsToolsEnabled();
	const flowBlock = [
		'',
		'Behaviors (flow nodes): objects MOVE via behavior nodes. create_flow_nodes adds them;',
		"the graph argument picks whose: \"scene\" or an object's uuid. KEY RULE: a behavior node",
		"in an OBJECT's graph with no edges drives that object — one node, zero edges is the",
		'normal case, so usually OMIT edges. Node types: ' + aiNodeTypes(physics).join(', ') + '.',
		'pathpatrol walks world waypoints: data.points = [[x,y,z],…] (at least 2).',
		'Moving-creature recipe (e.g. "a moving spider"): create the body parts, group them, put',
		"ONE pathpatrol node on the GROUP's graph, and a bounce node on each leg's graph.",
		'Existing node ids/data appear in the scene summary ("flow"/"sceneFlow") — tune or remove',
		'them with update_flow_nodes.'
	].join('\n');
	const physicsBlock = physics
		? [
				'',
				'Physics: new primitives already spawn DYNAMIC (mass 1) — they fall and collide once a',
				'simulation runs. Use set_physics to tune bodies or pin scenery (mode "static" for',
				'ground/walls). create_joints welds (fixed) or hinges (revolute, optional motor) pairs:',
				'assemble parts at their final pose WORLD-ALIGNED (no rotation) BEFORE jointing, or the',
				'hinge axis is wrong and the solver launches the assembly. A door = static frame +',
				'revolute joint; a wheel = revolute + motor. When a physics build is done, call',
				'control_simulation action "start" so it comes alive (undo will not stop a running sim).'
			].join('\n')
		: '';
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
		'Workflow: the "Current scene" block in the user message already lists every object with',
		'its uuid — use those uuids directly and only call list_scene when you need to re-read the',
		'scene after your own edits. Build with as FEW calls as possible: put every object of a',
		'request into ONE create_objects call (a ring of 6 rocks and a flame = one call, 7 objects).',
		'When done, reply with a short plain-text summary of what you built — do not describe tool',
		'calls.',
		'',
		'Tool discipline: only ever call a tool from the provided list, by its exact name. Never use',
		"an object's name as the tool name — the name of a thing you create belongs in that object's",
		'`name` field inside create_objects. Every call takes effect immediately, so never repeat a',
		'call that already came back without an error — once the scene matches the request, stop',
		'calling tools and write the summary.' + meshLine + flowBlock + physicsBlock
	].join('\n');
}
