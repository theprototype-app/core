// Roadmap 85 (owner's additions to 85a, connector voice test 2026-10-29) — the agent's helpers:
//
//   undo_last     an agent takes back its own last tool call(s): a voice client cannot see each call
//   set_pivot     an object's pivot / origin, the Inspector's `objectOrigin` write path (head nod, lamp tilt)
//   create_pivot  a group at a point, holding the objects: the cheap stand-in the owner approved
//   add_image     an image into the library: URL, base64, a generated image, a procedural canvas
//
// Schemas live here, in the registry `getAiTools` builds, so the in-app assistant, the agent page, the
// bridge and the connector catalog list one definition. Everything behind them loads on first use:
// this module is part of the assistant's static graph and of the catalog generator's SSR load.
import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, lockedObjects, pokeScene } from '../../stores/sceneStore.js';
import { peers } from '../../stores/appStore.js';
import { createGroup } from '$lib/geometries.svelte.js';
import { undoStack, undoEntry, recordObjectPresence } from '$lib/history';
import { moveObjectToGroup, renameObject } from '$lib/objectActions';
import { withWireBatch } from '$lib/wireBatch';
import { originOf, originWorld, originPreset, setOriginFor, setOriginFromWorld, resetOrigin } from '$lib/objectOrigin';
import { physicsShapeChanged } from '$lib/physics';
import { lockSkip } from './lockNote.js';
import { entryUuids, undoCount, conflictWords, personEntriesAbove, undoConflicts, UNDO_LAST_MAX } from '$lib/undoLastCore.js';
import { IMAGE_CANVAS_SCHEMA, IMAGE_LIMITS_TEXT } from './imageToolCore.js';

/** the tool names this module answers */
export const ASSIST_TOOL_NAMES = ['undo_last', 'set_pivot', 'create_pivot', 'add_image'];

const MAX_PIVOT_UPDATES = 100;
const MAX_PIVOT_MEMBERS = 500;
const PIVOT_PRESETS = ['bottom', 'center', 'median', 'world', 'children'];
const PIVOT_POINTS = ['center', 'bottom', 'top'];
/** how far from the scene's centre a pivot may be put (metres): a number from nowhere is a typo */
const MAX_COORD = 1e6;

/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;
/** @param {any} v @returns {number[] | null} */
const point = (v) => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD) ? v : null);
/** @param {string} uuid */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);
/** @param {string} uuid */
const lockedByPeer = (uuid) => get(lockedObjects).some((/** @type {any} */ l) => l[1] === uuid);

// ---------------------------------------------------------------- pivots

/** @param {any} u one `updates` row @returns {any} */
function setPivotOne(u) {
	const uuid = String(u?.uuid ?? '');
	const object = uuid && objectOf(uuid);
	if (!object) return { uuid, error: 'no object with that uuid' };
	if (lockedByPeer(uuid)) return { uuid, error: String(lockSkip(uuid, object)) };
	const given = ['at', 'local', 'preset', 'reset'].filter((k) => u[k] !== undefined && u[k] !== false);
	if (given.length !== 1) return { uuid, error: 'give exactly one of at (world point), local (object-space point), preset or reset: true' };
	if (u.at !== undefined) {
		const at = point(u.at);
		if (!at) return { uuid, error: 'at: takes [x, y, z] in metres (world space)' };
		setOriginFromWorld(uuid, new THREE.Vector3().fromArray(at));
	} else if (u.local !== undefined) {
		const local = point(u.local);
		if (!local) return { uuid, error: 'local: takes [x, y, z] in the object\'s own space' };
		setOriginFor(uuid, local);
	} else if (u.preset !== undefined) {
		if (!PIVOT_PRESETS.includes(u.preset)) return { uuid, error: 'preset: one of ' + PIVOT_PRESETS.join(', ') };
		if (originPreset(uuid, u.preset) === null && u.preset !== 'world') return { uuid, error: 'the ' + u.preset + ' preset needs geometry or children to measure, and this object has none' };
	} else resetOrigin(uuid);
	physicsShapeChanged(uuid); // the body/collider pose follows the pivot (the applier's line for peers)
	const local = originOf(object);
	return { uuid, ok: true, pivot: originWorld(object).toArray().map(r3), local: local ? local.map(r3) : null };
}

/** @param {any} args */
function setPivotTool(args) {
	const updates = Array.isArray(args?.updates) ? args.updates : [];
	if (!updates.length) return { error: 'no updates provided: updates: [{uuid, at: [x, y, z]}]' };
	if (updates.length > MAX_PIVOT_UPDATES) return { error: 'at most ' + MAX_PIVOT_UPDATES + ' objects per call' };
	const updated = updates.map(setPivotOne);
	if (updated.every((/** @type {any} */ r) => r.error)) return { error: 'no pivot was set: ' + updated[0].error, updated };
	return { updated };
}

/**
 * Where a create_pivot goes: a world point, or a named point of the members' joint bounds.
 * @param {any} at @param {any[]} members @returns {THREE.Vector3 | null}
 */
function pivotPoint(at, members) {
	const given = point(at);
	if (given) return new THREE.Vector3().fromArray(given);
	if (!PIVOT_POINTS.includes(at)) return null;
	const box = new THREE.Box3();
	for (const m of members) box.expandByObject(m);
	if (!isFinite(box.min.x)) return null;
	const c = box.getCenter(new THREE.Vector3());
	if (at === 'bottom') c.y = box.min.y;
	if (at === 'top') c.y = box.max.y;
	return c;
}

/** @param {any} args */
function createPivotTool(args) {
	const ids = [...new Set((Array.isArray(args?.objects) ? args.objects : []).map(String))];
	if (!ids.length) return { error: 'no objects: objects: [uuid, ...] are what the pivot will turn' };
	if (ids.length > MAX_PIVOT_MEMBERS) return { error: 'at most ' + MAX_PIVOT_MEMBERS + ' objects per pivot' };
	/** @type {any[]} */
	const members = [];
	/** @type {string[]} */
	const skippedWhy = [];
	for (const uuid of ids) {
		const o = objectOf(uuid);
		if (!o) skippedWhy.push(uuid + ': no object with that uuid');
		else if (lockedByPeer(uuid)) skippedWhy.push(String(lockSkip(uuid, o)));
		else members.push(o);
	}
	if (!members.length) return { error: 'no pivot made: ' + skippedWhy[0], skippedWhy };
	const at = pivotPoint(args?.at, members);
	if (!at) return { error: 'at: takes a world point [x, y, z], or ' + PIVOT_POINTS.join(' / ') + ' of the objects' };
	const group = /** @type {any} */ (get(objectsGroup));
	const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 120) : 'Pivot';
	// parts of one model stay inside it: the pivot joins their common parent, or a moved lamp loses its head
	const parent = members.every((m) => m.parent === members[0].parent) && members[0].parent !== group ? members[0].parent : null;
	/** @type {any} */
	const peer = get(peers);
	// the groupSelection order: both sides attach with the group already at the point, so local coords match
	const uuid = withWireBatch(() => {
		const made = createGroup('/group Pivot');
		const pivot = objectOf(made);
		if (peer) peer.send({ type: 'group', command: '/group Pivot', uuid: made });
		recordObjectPresence('create', pivot);
		renameObject(made, name);
		pivot.position.copy(at);
		if (peer) peer.send({ type: 'move', uuid: made, pos: pivot.position.toArray(), rot: pivot.rotation.toArray(), scale: pivot.scale.toArray() });
		for (const m of members) moveObjectToGroup(m.uuid, made);
		if (parent) moveObjectToGroup(made, parent.uuid);
		return made;
	});
	pokeScene();
	return {
		groupUuid: uuid,
		name,
		at: at.toArray().map(r3),
		members: members.map((m) => m.uuid),
		...(parent ? { parentUuid: parent.uuid } : {}),
		...(skippedWhy.length ? { skippedWhy } : {}),
		note: 'Turn the group (update_objects rotation on groupUuid, or animate it) and its objects swing about that point.'
	};
}

// ---------------------------------------------------------------- undo

/** an in-app assistant prompt's step (assistant.js labels them) @param {any} e */
const assistantStep = (e) => e?.kind === 'aibatch' && /^AI: /.test(String(e.label ?? ''));

/**
 * The in-app assistant has no A8 recorder (one prompt = one 'AI: …' step on this page's stack), so "undo
 * that" takes back its newest steps, under the same rule: a person's later edit of those objects refuses.
 * @param {number} count
 */
function undoAssistantSteps(count) {
	const stack = get(undoStack);
	const steps = stack.filter(assistantStep).slice(-count).reverse();
	if (!steps.length) return { undone: [], note: 'There is nothing of yours left to undo.' };
	const rows = steps.map((step) => ({
		line: { peer: 'me', at: Infinity },
		uuids: entryUuids(step),
		local: personEntriesAbove(stack, [step], assistantStep)
	}));
	const conflicts = undoConflicts(rows, {}, {
		nameOf: (u) => String(objectOf(u)?.name ?? '')
	}).map((c) => ({ ...c, by: 'you' }));
	if (conflicts.length) return { error: conflictWords(conflicts), refused: true, conflicts, undone: [] };
	const undone = [];
	for (const step of steps) {
		if (!undoEntry(step)) break;
		undone.push({ tool: 'prompt', text: String(step.label).replace(/^AI: /, '') });
	}
	return { undone, count: undone.length };
}

/** @param {any} args */
async function undoLastTool(args) {
	const count = undoCount(args?.count);
	const recorder = await import('$lib/agentLogRecorder.js');
	return recorder.recordingThisCall() ? recorder.undoLastCalls(count) : undoAssistantSteps(count);
}

// ---------------------------------------------------------------- the dispatch

/**
 * @param {string} name @param {any} args
 * @returns {Promise<any>}
 */
export async function assistTool(name, args) {
	switch (name) {
		case 'undo_last':
			return undoLastTool(args);
		case 'set_pivot':
			return setPivotTool(args);
		case 'create_pivot':
			return createPivotTool(args);
		case 'add_image':
			return (await import('./imageTool.js')).addImageTool(args ?? {});
		default:
			return { error: 'unknown tool ' + name };
	}
}

/** the assistant's OpenAI-format schemas */
export const ASSIST_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'undo_last',
			description:
				'Take back your own last tool call (count for several, newest first). Use it whenever the person says "undo that" or "take that back": they may be talking and cannot see each call. ' +
				'Only ever undoes YOUR calls. If someone has since changed the same objects it refuses and lists them, and nothing changes: tell the person who changed what.',
			parameters: {
				type: 'object',
				properties: { count: { type: 'integer', minimum: 1, maximum: UNDO_LAST_MAX, description: 'how many of your calls to take back (default 1)' } }
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_pivot',
			description:
				"Set the point an object turns and scales about, without moving it: a head that nods at the neck, a lamp that tilts at its joint, a door on its hinge. After this, update_objects rotation and scale, clips and Spin nodes all turn it about that point. list_scene reports it as `pivot`.",
			parameters: {
				type: 'object',
				properties: {
					updates: {
						type: 'array',
						maxItems: MAX_PIVOT_UPDATES,
						items: {
							type: 'object',
							properties: {
								uuid: { type: 'string' },
								at: { type: 'array', items: { type: 'number' }, description: '[x,y,z] world metres' },
								local: { type: 'array', items: { type: 'number' }, description: "[x,y,z] in the object's own space" },
								preset: { type: 'string', enum: PIVOT_PRESETS, description: 'bottom = on its footprint, center = its box, median = its vertices, world = the scene origin, children = the middle of a group' },
								reset: { type: 'boolean', description: "true = back to the object's own centre" }
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
			name: 'create_pivot',
			description:
				'Make a group at a point and put objects in it, so turning the group swings them about that point: arm parts about a shoulder, several parts of a lamp about one joint. The objects stay where they are. For one object, set_pivot needs no extra group. Returns groupUuid.',
			parameters: {
				type: 'object',
				properties: {
					objects: { type: 'array', items: { type: 'string' }, maxItems: MAX_PIVOT_MEMBERS, description: 'the uuids to swing' },
					at: { description: 'the point: [x,y,z] world metres, or "center" / "bottom" / "top" of the objects together' },
					name: { type: 'string', description: 'the group\'s name (default "Pivot")' }
				},
				required: ['objects', 'at']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'add_image',
			description:
				'Put an image into the shared library (Explorer) and get its hash, for texture slots (update_objects materialParams.map, set_material) and image nodes. Give exactly one source: `url` (https, the site must allow other origins), `data` (base64, also how to pass an image you generated), or `canvas` (draw one from shapes, gradients, checkers and noise: textures, signs, labels). ' +
				'It is re-encoded here, so nothing in the file survives but its pixels. ' +
				IMAGE_LIMITS_TEXT +
				' One undo step; editors and admins only.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'https address of a PNG, JPEG, WebP, GIF or AVIF' },
					data: { type: 'string', description: 'the image as base64, or this part of it' },
					chunk: {
						type: 'object',
						description: 'a large image in parts: every part has the same id; it is added when the last part arrives',
						properties: { id: { type: 'string' }, index: { type: 'number' }, total: { type: 'number' } }
					},
					canvas: IMAGE_CANVAS_SCHEMA,
					name: { type: 'string', description: 'the file name in the library' },
					folder: { type: 'string', description: 'library folder, "A/B" for nested (default "Generated")' },
					prompt: { type: 'string', description: 'a generated image: the request it was made for' },
					source: { type: 'string', description: 'where it came from, e.g. the generator' },
					licence: { type: 'string', description: 'its licence, e.g. CC0, "own work"' },
					place: { type: 'boolean', description: 'also place it in the scene as a card (default false)' },
					position: { type: 'array', items: { type: 'number' }, description: 'the card: [x,y,z] metres' },
					height: { type: 'number', description: 'the card: height in metres' }
				}
			}
		}
	}
];

/** the assistant's system prompt lines */
export const ASSIST_PROMPT =
	'\nTo undo your own last change, call undo_last. To make something swing about a joint, set_pivot (one object) or create_pivot (several) and then rotate it. ' +
	'For a texture that is not in the library yet, add_image first and use the hash it returns.';
