// 61-nav (roadmap 61 G10) — THE NPC TOOL: game_setup {npc} (an action of 85's game_setup family, no new
// connector tool name). It makes any object an enemy exactly the way the "Make this an enemy" sheet does:
// the sheet and this call share ONE recipe, the navigation module's `apply(uuid, spec)` registered through
// `api.registerObjectAction` — so "the sheet builds the same guard" holds by construction. The module is
// installed from the gallery on first use (only scenes with NPCs pay for it).
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore.js';

export const NPC_TOOL_NAMES = ['set_npc'];

/** @param {string} uuid */
const objectOf = (uuid) =>
	/** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid);

/** the fields the recipe reads (the module normalizes and clamps every one) */
const SPEC_KEYS = [
	'path',
	'sight',
	'hearing',
	'chase',
	'attack',
	'speed',
	'run',
	'giveUp',
	'alert',
	'remove'
];

/**
 * @param {string} name @param {any} args
 * @returns {Promise<any>}
 */
export async function npcTool(name, args) {
	if (name !== 'set_npc') return { error: 'unknown npc tool ' + name };
	const a = args ?? {};
	const uuid = typeof a.object === 'string' ? a.object : '';
	if (!uuid) return { error: 'object: the uuid of the object to make an enemy (list_scene)' };
	const object = objectOf(uuid);
	if (!object) return { error: 'object: no object ' + uuid.slice(0, 40) + ' (list_scene)' };
	if (object.userData?.terrain)
		return { error: 'object: a terrain cannot walk — pick the object that should be the enemy' };
	const { ensureNavigationModule, NAV_MODULE_ID } = await import('../npcEntry.js');
	const wasLoaded = (await import('../moduleSDK.js')).isModuleLoaded?.(NAV_MODULE_ID) ?? false;
	const got = await ensureNavigationModule({ ask: false });
	if ('error' in got) return { error: got.error };
	if (typeof got.action.apply !== 'function')
		return {
			error:
				'The Navigation module on this device is too old for game_setup {npc} — update it (Modules ▸ User).'
		};
	/** @type {Record<string, any>} */
	const spec = {};
	for (const k of SPEC_KEYS) if (a[k] !== undefined) spec[k] = a[k];
	let result;
	try {
		result = await got.action.apply(uuid, spec);
	} catch (error) {
		return {
			error:
				'The enemy recipe failed: ' +
				(error instanceof Error ? error.message : String(error)).slice(0, 200)
		};
	}
	if (!result || result.error) return { error: result?.error ?? 'The enemy recipe did nothing.' };
	const warnings = [...(Array.isArray(result.warnings) ? result.warnings : [])];
	if (!wasLoaded)
		warnings.unshift(
			'Installed the Navigation module on this device; every player needs it (the scene asks them when they open it).'
		);
	return {
		updated: [{ uuid, ok: true }],
		npc: result.npc ?? null,
		note: result.note ?? '',
		...(warnings.length ? { warnings } : {})
	};
}

export const NPC_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_npc',
			description:
				'Make an object an ENEMY (an NPC): it walks the navmesh (baked from the scene, round walls), patrols a Path, ' +
				'sees the player in a cone (sight angle + range, blocked by walls), hears noises (hearing radius; louder noises reach further), ' +
				'chases, attacks in attack range (an "attack" event every attack.every s), gives up after giveUp s without the player and walks ' +
				'back to its path or home spot. A target it cannot reach stops it at the closest point with an "unreachable" event. ' +
				'path = a Path object uuid, "new" (a loop path around it) or "none" (guard the spot). Fields you leave out keep their value ' +
				'(the defaults on a new enemy). remove: true makes it an ordinary object again. Same as the object menu\'s "Make this an enemy" sheet. One undo step (two with path "new": the path, then the enemy).',
			parameters: {
				type: 'object',
				properties: {
					object: { type: 'string', description: 'the uuid of the object that becomes the enemy' },
					path: { type: 'string', description: 'a Path object uuid, "new" or "none"' },
					sight: {
						type: 'object',
						properties: {
							angle: { type: 'number', description: 'degrees, 10..360 (default 100)' },
							range: { type: 'number', description: 'm (default 12)' }
						}
					},
					hearing: {
						type: 'number',
						description: 'm, how far a normal noise is heard (default 6)'
					},
					chase: {
						type: 'number',
						description: 'm, it gives up when the player gets further than this (default 25)'
					},
					attack: {
						type: 'object',
						properties: {
							range: { type: 'number', description: 'm (default 1.6)' },
							every: { type: 'number', description: 's between attacks (default 1)' }
						}
					},
					speed: { type: 'number', description: 'walking speed on patrol, m/s (default 1.6)' },
					run: { type: 'number', description: 'chase speed, m/s (default 3.6)' },
					giveUp: {
						type: 'number',
						description: 's without seeing or hearing the player before it returns (default 4)'
					},
					alert: {
						type: 'number',
						description: 's it looks toward a noise before searching (default 1.5)'
					},
					remove: { type: 'boolean' }
				},
				required: ['object']
			}
		}
	}
];

export const NPC_PROMPT =
	'\n\nEnemies: set_npc (game_setup {npc}) makes any object an enemy that patrols a Path, sees and hears the player, chases, attacks, ' +
	'gives up and returns — wire its "attack" event (an On NPC Event node) to damage, a sound or a HUD. Use it instead of building chases from Path patrol + sensors.';
