// Agent-side tool layer (roadmap #10 B3). Same tool names/shapes as the in-app
// assistant, mapped onto peer messages via messages.js + the bridge. Tools never
// throw — they return JSON results so an LLM can self-correct.
import {
	uuid,
	createMsg,
	lightMsg,
	moveMsg,
	colorMsg,
	nameMsg,
	deleteMsg,
	groupCreateMsg,
	groupReparentMsg,
	materialTypeMsg,
	materialParamMsg,
	visibleMsg,
	objectFileMsg,
	PRIMITIVES,
	LIGHTS,
	MATERIALS
} from './messages.js';
import { generateMesh } from './meshGen.js';

/** OpenAI-format tool schemas (also used to build the MCP tool list). */
export const TOOL_SCHEMAS = [
	{
		name: 'list_scene',
		description: 'List the objects the agent knows about (its own creations plus anything it has observed from other peers). Entries are flagged self/full/stub.',
		parameters: { type: 'object', properties: {} }
	},
	{
		name: 'create_objects',
		description: 'Create primitives, lights or empty groups in one call. Ground is y=0; seat objects on it (a box of height h sits at y=h/2). Returns new uuids.',
		parameters: {
			type: 'object',
			properties: {
				objects: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							kind: { type: 'string', enum: ['primitive', 'light', 'group'] },
							primitive: { type: 'string', enum: PRIMITIVES },
							light: { type: 'string', enum: LIGHTS },
							params: { type: 'array', items: { type: 'number' }, description: 'up to 4 constructor args; Box=[w,h,d], Sphere=[r], Cylinder=[rTop,rBot,h]' },
							name: { type: 'string' },
							position: { type: 'array', items: { type: 'number' } },
							rotation: { type: 'array', items: { type: 'number' }, description: 'Euler radians' },
							scale: { type: 'array', items: { type: 'number' } },
							color: { type: 'string', description: '#rrggbb (meshes only)' },
							parentUuid: { type: 'string' }
						},
						required: ['kind']
					}
				}
			},
			required: ['objects']
		}
	},
	{
		name: 'update_objects',
		description: 'Modify existing objects by uuid: move/rotate/scale, recolor, change material, rename, show/hide, reparent.',
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
							color: { type: 'string' },
							materialType: { type: 'string', enum: MATERIALS },
							materialParams: { type: 'object' },
							visible: { type: 'boolean' },
							parentUuid: { type: 'string', description: 'group uuid, or "root" to un-nest' }
						},
						required: ['uuid']
					}
				}
			},
			required: ['updates']
		}
	},
	{
		name: 'delete_objects',
		description: 'Delete objects by uuid.',
		parameters: { type: 'object', properties: { uuids: { type: 'array', items: { type: 'string' } } }, required: ['uuids'] }
	},
	{
		name: 'group_objects',
		description: 'Create a group and move the given members into it. Returns the group uuid.',
		parameters: {
			type: 'object',
			properties: { name: { type: 'string' }, memberUuids: { type: 'array', items: { type: 'string' } } },
			required: ['name', 'memberUuids']
		}
	},
	{
		name: 'get_status',
		description: 'Report the connection state, session peers and how many objects the agent is tracking.',
		parameters: { type: 'object', properties: {} }
	},
	{
		name: 'generate_mesh',
		description: 'Generate a NEW custom 3D mesh from a text description (when no primitive fits). SLOW + async: returns immediately and the mesh appears in the scene when ready. Requires a mesh backend (--mesh-url).',
		parameters: {
			type: 'object',
			properties: {
				prompt: { type: 'string' },
				name: { type: 'string' },
				position: { type: 'array', items: { type: 'number' } }
			},
			required: ['prompt']
		}
	}
];

/** @param {import('./peerBridge.js').PeerBridge} bridge @param {any} obj */
function createOne(bridge, obj) {
	const id = uuid();
	try {
		if (obj.kind === 'light') {
			bridge.broadcast(lightMsg(id, obj.light));
		} else if (obj.kind === 'group') {
			bridge.broadcast(groupCreateMsg(id, obj.name || 'Group'));
		} else {
			bridge.broadcast(createMsg(id, obj.primitive, obj.params));
		}
	} catch (e) {
		return { error: e.message };
	}
	if (obj.name && obj.kind !== 'group') bridge.broadcast(nameMsg(id, obj.name));
	if (obj.position || obj.rotation || obj.scale)
		bridge.broadcast(moveMsg(id, obj.position || [0, 0, 0], obj.rotation || [0, 0, 0], obj.scale || [1, 1, 1]));
	if (obj.color && obj.kind !== 'light') bridge.broadcast(colorMsg(id, obj.color));
	if (obj.parentUuid) bridge.broadcast(groupReparentMsg(id, obj.parentUuid));
	return { uuid: id, name: obj.name || obj.primitive || obj.light || 'Group' };
}

/** @param {import('./peerBridge.js').PeerBridge} bridge @param {any} u */
function updateOne(bridge, u) {
	const id = u.uuid;
	if (!id) return { error: 'uuid required' };
	if (typeof u.name === 'string') bridge.broadcast(nameMsg(id, u.name));
	if (u.position || u.rotation || u.scale)
		bridge.broadcast(moveMsg(id, u.position || [0, 0, 0], u.rotation || [0, 0, 0], u.scale || [1, 1, 1]));
	if (u.color) bridge.broadcast(colorMsg(id, u.color));
	if (u.materialType) {
		try {
			bridge.broadcast(materialTypeMsg(id, u.materialType));
		} catch (e) {
			return { uuid: id, error: e.message };
		}
	}
	if (u.materialParams && typeof u.materialParams === 'object')
		for (const [k, v] of Object.entries(u.materialParams)) bridge.broadcast(materialParamMsg(id, k, v));
	if (typeof u.visible === 'boolean') bridge.broadcast(visibleMsg(id, u.visible));
	if (u.parentUuid) bridge.broadcast(groupReparentMsg(id, u.parentUuid === 'root' ? 'up' : u.parentUuid));
	return { uuid: id, ok: true };
}

/**
 * Execute a tool call against the bridge. Never throws.
 * @param {import('./peerBridge.js').PeerBridge} bridge
 * @param {string} name
 * @param {any} args
 * @returns {any}
 */
export function executeTool(bridge, name, args) {
	try {
		switch (name) {
			case 'list_scene':
				return { objects: bridge.registry.list() };
			case 'get_status':
				return bridge.status();
			case 'create_objects': {
				const specs = Array.isArray(args?.objects) ? args.objects : [];
				if (!specs.length) return { error: 'no objects provided' };
				return { created: specs.map((s) => createOne(bridge, s)) };
			}
			case 'update_objects': {
				const ups = Array.isArray(args?.updates) ? args.updates : [];
				if (!ups.length) return { error: 'no updates provided' };
				return { updated: ups.map((u) => updateOne(bridge, u)) };
			}
			case 'delete_objects': {
				const uuids = Array.isArray(args?.uuids) ? args.uuids : [];
				for (const id of uuids) bridge.broadcast(deleteMsg(id, bridge.agentId));
				return { deleted: uuids.length };
			}
			case 'group_objects': {
				const members = Array.isArray(args?.memberUuids) ? args.memberUuids : [];
				const id = uuid();
				bridge.broadcast(groupCreateMsg(id, args?.name || 'Group'));
				for (const m of members) bridge.broadcast(groupReparentMsg(m, id));
				return { groupUuid: id, members };
			}
			case 'generate_mesh': {
				const prompt = String(args?.prompt || '').trim();
				if (!prompt) return { error: 'prompt required' };
				if (!bridge.meshConfig) return { error: 'no mesh backend configured (pass --mesh-url / --mesh-kind, or AGENT_MESH_*)' };
				const id = uuid();
				const position = Array.isArray(args?.position) ? args.position : [0, 0, 0];
				// LONG + async: generate in the background, push the GLB bytes when ready
				generateMesh(bridge.meshConfig, prompt, (m) => bridge.log && bridge.log('mesh: ' + m))
					.then(({ bytes }) => {
						bridge.broadcast(objectFileMsg(id, args?.name || prompt.slice(0, 40), bytes, position));
						bridge.registry.upsert(id, { kind: 'generated', name: args?.name || prompt.slice(0, 40), by: 'self' }, 'full');
					})
					.catch((e) => bridge.log && bridge.log('mesh generation failed: ' + e.message));
				return { started: true, uuid: id, note: 'Generating a mesh from "' + prompt.slice(0, 60) + '"; it will appear in ~1-3 min.' };
			}
			default:
				return { error: 'unknown tool: ' + name };
		}
	} catch (e) {
		return { error: e.message };
	}
}

/** System prompt for the REPL/MCP driver. */
export function systemPrompt() {
	return [
		'You are a 3D scene-building agent connected to a live collaborative session.',
		'You act by calling tools; every change replicates to everyone in the session.',
		'Y is up, the ground is y=0 (seat objects on it: height h -> center y=h/2).',
		'Rotations are Euler radians; colors are hex like #cc4422; keep scenes human-scaled.',
		'Primitives: ' + PRIMITIVES.join(', ') + '. Lights: ' + LIGHTS.join(', ') + '.',
		'Call list_scene before editing existing objects and use the real uuids it returns.',
		'Prefer batching many objects into one create_objects call. When done, reply with a',
		'short plain-text summary — do not narrate tool calls.'
	].join('\n');
}
