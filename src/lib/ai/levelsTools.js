// Roadmap 93 — THE LEVELS TOOLS (game_setup {levels, portal, loading, checkpoint}: actions of 85's game_setup
// family, no new connector tool names).
//
//   set_levels        (game_setup {levels})      the ONE Levels table: names, scene or spawn point, goals, order,
//                                                the keep-across-levels list (LP0 + LP4)
//   set_portal        (game_setup {portal})      place / edit a Portal: target level / scene / spawn / back,
//                                                transition, shown or invisible in Play, its own loading screen (LP1)
//   set_checkpoint    (game_setup {checkpoint})  place / edit a Checkpoint pad (LP3)
//   set_loading       (game_setup {loading})     the Levels table's loading screen (LP2)
//
// Every write is ONE undo step (the `levels` history kind, gameLevels/history.js, loaded on first use) and
// replicates through the scene-settings singleton. The Kit: Levels nodes (Go to level / Next level / Finish
// level) drive the same table.
import { get } from 'svelte/store';
import { scenePhysicsState_ } from '$lib/scenePhysics';
import { objectsGroup } from '../../stores/sceneStore.js';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '$lib/history';
import { planSetLevels, describeLevels, planPortalRecord, planCheckpointRecord, planLevelObjectPlace, planLoading, describePortal } from '$lib/gameLevels/agentCore.js';
import { KEEP_KINDS, UNLOCK_RULES } from '$lib/gameLevels/table.js';
import { LOADING_PRESETS, BAR_STYLES } from '$lib/gameLevels/loadingConfig.js';
import { PORTAL_TRANSITIONS } from '$lib/gameLevels/objects.js';

export const LEVELS_TOOL_NAMES = ['set_levels', 'set_portal', 'set_checkpoint', 'set_loading'];

/** @typedef {(spec: any, extraTypes?: string[]) => any} CreateBase */

const tableNow = () => get(scenePhysicsState_)?.levels ?? null;
/** @param {string} uuid */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid);

/** @param {any} args */
async function setLevelsTool(args) {
	const current = get(scenePhysicsState_)?.levels ?? null;
	const plan = planSetLevels(args, current);
	if ('error' in plan) return { error: plan.error };
	if ('read' in plan) return { levels: plan.table, note: describeLevels(plan.table) };
	const h = await import('$lib/gameLevels/history.js');
	const table = h.commitLevels(plan.table);
	return { updated: [{ levels: true, ok: true }], levels: table, note: describeLevels(table) };
}

/**
 * set_portal / set_checkpoint: edit `object` (a uuid) or place a new one, then write its record. ONE undo
 * step (a batch when none is open: the create + the record's props entry).
 * @param {'portal' | 'checkpoint'} key @param {any} args @param {CreateBase} createBase
 */
async function levelObjectTool(key, args, createBase) {
	const a = args ?? {};
	const table = tableNow();
	const rec = key === 'portal' ? planPortalRecord(a, table) : planCheckpointRecord(a);
	if ('error' in rec) return { error: rec.error };
	let uuid = '';
	/** @type {any} */
	let place = null;
	if (a.object !== undefined) {
		const object = objectOf(String(a.object));
		if (!object) return { error: 'object: no object ' + String(a.object).slice(0, 40) + ' (list_scene)' };
		if (!object.userData?.[key]) return { error: 'object: ' + (object.name || 'that object') + ' is not a ' + key + ' (leave object out to place a new one)' };
		uuid = object.uuid;
	} else {
		place = planLevelObjectPlace(a);
		if ('error' in place) return { error: place.error };
	}
	const ownBatch = !historyBatchOpen();
	if (ownBatch) beginHistoryBatch();
	/** @type {any} */
	let made = null;
	try {
		if (place) {
			const kind = key === 'portal' ? 'Portal' : 'Checkpoint';
			made = createBase({ kind: 'primitive', primitive: kind, ...place.spec }, [kind]);
			if (made?.error) return { error: made.error };
			uuid = made.uuid;
		} else if (a.name !== undefined) {
			const { renameObject } = await import('$lib/objectActions');
			renameObject(uuid, String(a.name).slice(0, 120));
		}
		const { setLevelObjectRecord } = await import('$lib/gameLevels/objectEdit.js');
		const next = Object.keys(rec.patch).length ? setLevelObjectRecord(uuid, key, rec.patch) : objectOf(uuid)?.userData?.[key];
		const warnings = [...('warnings' in rec ? /** @type {string[]} */ (rec.warnings) : []), ...(made?.warnings ?? [])];
		return {
			updated: [{ uuid, [key]: true, ok: true }],
			uuid,
			name: objectOf(uuid)?.name ?? '',
			[key]: next,
			...(made?.placed ? { placed: made.placed } : {}),
			...(warnings.length ? { warnings } : {}),
			note:
				key === 'portal'
					? describePortal(next, table)
					: 'Stepping on it saves this player\'s progress here' + (next?.show === false ? ' (silently, no message)' : '') + '.'
		};
	} finally {
		if (ownBatch) endHistoryBatch(key === 'portal' ? 'Portal' : 'Checkpoint');
	}
}

/** @param {any} args */
async function setLoadingTool(args) {
	const a = args ?? {};
	const table = tableNow();
	const keys = ['preset', 'background', 'image', 'logo', 'textColor', 'bar', 'tips', 'item', 'title', 'clear'];
	if (!keys.some((k) => a[k] !== undefined)) return { loading: table?.loading ?? null, note: table?.loading ? 'Loading screen: ' + table.loading.preset + '.' : 'No loading screen set: level changes show the default bar.' };
	const plan = planLoading(a, table);
	if ('error' in plan) return { error: plan.error };
	const h = await import('$lib/gameLevels/history.js');
	const next = h.commitLevels(plan.table);
	return { updated: [{ loading: true, ok: true }], loading: next?.loading ?? null, note: next?.loading ? 'Every level change shows the ' + next.loading.preset + ' loading screen (only when the load takes a moment).' : 'Loading screen back to the default bar.' };
}

/** @param {string} name @param {any} args @param {CreateBase} [createBase] */
export async function levelsTool(name, args, createBase) {
	switch (name) {
		case 'set_levels':
			return setLevelsTool(args ?? {});
		case 'set_portal':
		case 'set_checkpoint':
			if (!createBase) return { error: name + ' needs the scene' };
			return levelObjectTool(name === 'set_portal' ? 'portal' : 'checkpoint', args, createBase);
		case 'set_loading':
			return setLoadingTool(args ?? {});
		default:
			return { error: 'unknown levels tool ' + name };
	}
}

const ROW = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'a stable id (default: from the name)' },
		name: { type: 'string' },
		scene: { type: 'string', description: 'a project scene name: the level is that scene' },
		spawn: { type: 'string', description: 'the name of an object to start at (a Checkpoint, a Portal or any marker), in the level\'s scene' },
		goal: { type: 'string', description: 'one line the player reads' }
	}
};

const TRIPLE = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const PLACE = {
	position: { ...TRIPLE, description: 'its base [x, y, z] (a new one)' },
	at: { type: 'object', description: 'placement like create_objects: {ping: "latest"} = at the person\'s ping' },
	yaw: { type: 'number', description: 'turn in radians; its arrow points -Z at 0 (arriving players face the arrow)' },
	face_user: { type: 'boolean' },
	name: { type: 'string' },
	object: { type: 'string', description: 'uuid of an existing one to change (leave out to place a new one)' }
};
const LOADING = {
	preset: { type: 'string', enum: LOADING_PRESETS },
	background: { type: 'string', description: '#rrggbb' },
	image: { type: 'string', description: 'an image URL or library item (the image preset)' },
	logo: { type: 'string' },
	textColor: { type: 'string' },
	bar: { type: 'object', properties: { style: { type: 'string', enum: BAR_STYLES }, color: { type: 'string' } } },
	tips: { type: 'array', items: { type: 'string' } },
	title: { type: 'string' }
};

export const LEVELS_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_levels',
			description:
				'The game\'s ONE Levels table: the levels in play order, each {name, scene (a project scene), spawn (an object name to start at), goal}; keep = what carries from level to level (' +
				KEEP_KINDS.join(', ') +
				', or "var:<name>" for a named variable; New game resets them); unlock = ' +
				UNLOCK_RULES.join(' | ') +
				'. levels replaces the list, add appends, update [{id, …}] patches, remove [ids] drops, clear: true removes the table; no field reads it. The Go to level / Next level / Finish level nodes and portals use this same table. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					levels: { type: 'array', items: ROW },
					add: { type: 'array', items: ROW },
					update: { type: 'array', items: ROW },
					remove: { type: 'array', items: { type: 'string' } },
					keep: { type: 'array', items: { type: 'string' } },
					unlock: { type: 'string', enum: UNLOCK_RULES },
					clear: { type: 'boolean' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_portal',
			description:
				'A Portal: a doorway that takes the player who walks through it somewhere else, ONE player at a time. Target: level (a Levels-table row id or name), or scene (a project scene) and / or spawn (an object name to arrive at), or back: true (where they came from). transition = ' +
				PORTAL_TRANSITIONS.join(' | ') +
				' (VR always fades); loading = this portal\'s own loading screen. New: position or at; change one: object (uuid). What the game keeps (set_levels keep) carries through. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					...PLACE,
					show: { type: 'boolean', description: 'false = invisible in Play (still works): a trigger inside your own doorway' },
					level: { type: 'string' },
					scene: { type: 'string' },
					spawn: { type: 'string' },
					back: { type: 'boolean' },
					transition: { type: 'string', enum: PORTAL_TRANSITIONS },
					loading: { type: ['object', 'null'], properties: LOADING }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_checkpoint',
			description:
				'A Checkpoint pad: stepping on it saves THAT player\'s progress there; after a fall (or Back to checkpoint, or reloading an exported game) they come back to it. New: position or at; change one: object (uuid). label = what the flash says. One undo step.',
			parameters: { type: 'object', properties: { ...PLACE, label: { type: 'string' }, show: { type: 'boolean', description: 'false = no message when reached (it still saves)' } } }
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_loading',
			description:
				'The loading screen every level change shows (only when the load takes a moment; at least 0.4 s once shown): preset ' +
				LOADING_PRESETS.join(' | ') +
				', background, image, logo, bar {style, color}, tips (lines that rotate), title; clear: true = the default bar. Fields you leave out stay. Needs a Levels table (set_levels). No field reads it. One undo step.',
			parameters: { type: 'object', properties: { ...LOADING, clear: { type: 'boolean' } } }
		}
	}
];

export const LEVELS_PROMPT =
	'\n\nLevels: set_levels writes the game\'s one Levels table (order, scene or spawn, goals, what carries across levels); the Kit: Levels nodes and portals follow it. set_portal places a doorway to a level / scene / spot, set_checkpoint a save pad, set_loading the loading screen.';
