// 92 — THE GAME MENUS TOOLS (game_setup {title, pause, saves}: actions of 85's game_setup family, no new
// connector tool names).
//
//   set_title_screen  (game_setup {title})  the game's title screen: title, subtitle, background (the scene /
//                                           a colour / a library image), shown on editor Play or not; clear
//   set_pause_menu    (game_setup {pause})  whether the pause menu pauses the game (alone only — a shared
//                                           game keeps running) + "Auto-admit while playing"
//   set_save_slots    (game_setup {saves})  three save slots on / off
//
// Every write goes through the scene's play block (gameMenus.setGameMenus): saved with the scene, replicated
// with the scene-settings singleton, exported with the game. No field = read the current setting.
import { get } from 'svelte/store';
import { scenePhysicsState_ } from '$lib/scenePhysics';
import { setGameMenus } from '$lib/gameMenusPlan.js';
import { menusRules, menusNewer, TITLE_BACKGROUNDS } from '$lib/gameMenusCore.js';

export const MENUS_TOOL_NAMES = ['set_title_screen', 'set_pause_menu', 'set_save_slots'];

const current = () => get(scenePhysicsState_)?.play?.menus ?? null;

/** @param {any} rules */
function describe(rules) {
	const parts = [];
	parts.push(rules.title ? 'title screen "' + (rules.title.title || 'the scene name') + '"' : 'no title screen');
	parts.push(rules.pause ? 'the menu pauses (when alone)' : 'the menu does not pause');
	parts.push(rules.saves ? 'three save slots' : 'no save slots');
	if (rules.autoAdmit) parts.push('auto-admit while playing');
	return parts.join(', ') + '.';
}

/** @param {any} a */
function titleTool(a) {
	const keys = ['title', 'subtitle', 'background', 'color', 'image', 'editor', 'clear', 'on'];
	if (!keys.some((k) => a[k] !== undefined)) return { menus: menusRules(current()), note: describe(menusRules(current())) };
	if (a.clear === true || a.on === false) {
		setGameMenus({ title: null });
		return { updated: [{ title: true, ok: true }], menus: menusRules(current()), note: 'The title screen is off: Play starts the game straight away.' };
	}
	if (a.background !== undefined && !TITLE_BACKGROUNDS.includes(a.background)) return { error: 'background: one of ' + TITLE_BACKGROUNDS.join(' | ') };
	if (a.color !== undefined && !/^#[0-9a-f]{3,8}$/i.test(String(a.color))) return { error: 'color: a hex colour like #102030' };
	/** @type {any} */
	const patch = { ...(current()?.title ?? {}), on: true };
	for (const k of ['title', 'subtitle', 'background', 'color', 'image']) if (a[k] !== undefined) patch[k] = a[k] === null ? undefined : a[k];
	if (a.editor !== undefined) patch.editor = a.editor !== false;
	if (a.image !== undefined && a.background === undefined && a.image) patch.background = 'image';
	setGameMenus({ title: patch });
	const rules = menusRules(current());
	return { updated: [{ title: true, ok: true }], menus: rules, note: 'Title screen set: play links and exported games open on it' + (rules.title?.editor === false ? '.' : ', and so does Play here.') };
}

/** @param {any} a */
function pauseTool(a) {
	if (a.pauses === undefined && a.autoAdmit === undefined) return { menus: menusRules(current()), note: describe(menusRules(current())) };
	/** @type {any} */
	const patch = {};
	if (a.pauses !== undefined) patch.pause = { on: a.pauses !== false };
	if (a.autoAdmit !== undefined) patch.autoAdmit = a.autoAdmit === true;
	setGameMenus(patch);
	return { updated: [{ pause: true, ok: true }], menus: menusRules(current()), note: describe(menusRules(current())) };
}

/** @param {any} a */
function savesTool(a) {
	if (a.on === undefined) return { menus: menusRules(current()), note: describe(menusRules(current())) };
	setGameMenus({ saves: a.on === false ? null : { on: true } });
	return {
		updated: [{ saves: true, ok: true }],
		menus: menusRules(current()),
		note: a.on === false ? 'Save slots are off.' : 'Players get three save slots in the menu (Save game / Load game) and Continue on the title screen; a checkpoint saves into the slot in use.'
	};
}

/** @param {string} name @param {any} args */
export async function menusTool(name, args) {
	const a = args ?? {};
	if (menusNewer(current())) return { error: 'This game’s menus were made with a newer version of the app; update the app to change them.' };
	switch (name) {
		case 'set_title_screen':
			return titleTool(a);
		case 'set_pause_menu':
			return pauseTool(a);
		case 'set_save_slots':
			return savesTool(a);
		default:
			return { error: 'unknown menus tool ' + name };
	}
}

export const MENUS_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_title_screen',
			description:
				'The game\'s title screen (a start screen with Continue / Play / Load game / Settings): title, subtitle, background ' +
				TITLE_BACKGROUNDS.join(' | ') +
				' (scene = the game\'s own scene dimmed behind it), color (for color), image (a library image hash, for image), editor (false = not shown when you press Play in the editor; play links and exports always open on it); clear: true = no title screen. Fields you leave out stay. No field reads it.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					subtitle: { type: 'string' },
					background: { type: 'string', enum: TITLE_BACKGROUNDS },
					color: { type: 'string', description: 'a hex colour, #102030' },
					image: { type: 'string', description: 'a library image hash' },
					editor: { type: 'boolean' },
					clear: { type: 'boolean' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_pause_menu',
			description:
				'The pause menu every game has (Esc / Start / the Menu button): pauses = false keeps the game running while the menu is open (it only ever pauses when nobody else is playing); autoAdmit = true lets people who ask to join in while the host plays (AI agents and blocked people still ask). No field reads it.',
			parameters: { type: 'object', properties: { pauses: { type: 'boolean' }, autoAdmit: { type: 'boolean' } } }
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_save_slots',
			description:
				'Three named save slots for the game (time, level, a picture): on = true adds Save game / Load game to the menu and Continue to the title screen; a Checkpoint then saves into the slot in use. Saved on the player\'s device. No field reads it.',
			parameters: { type: 'object', properties: { on: { type: 'boolean' } } }
		}
	}
];

export const MENUS_PROMPT =
	'\n\nGame menus: set_title_screen gives the game a start screen (exports and play links open on it), set_pause_menu decides whether the menu pauses (only when alone) and auto-admit while playing, set_save_slots adds three save slots.';
