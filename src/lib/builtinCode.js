// 36-fb-code (F5): BUILT-IN NODES WITH CODE. "Player node, cannot edit code" (user, 2026-10-05):
// the "Player: walk" card in Mini Golf / Escape / Sky Run / Towers is a Character Controller — a
// built-in whose movement is core code — so double-click opened nothing and "Open code" was not
// offered. A built-in listed here carries an OPTIONAL `data.code` the runtime calls, and opens in
// the code workspace like a Script node: the same tab, Ctrl+S check, undo and replication. A node
// with no `data.code` shows TEMPLATE (an identity: it changes nothing), and the runtime then runs
// exactly the code it always ran (the parity contract of 21-E6).
//
// A LEAF: no imports — graphContract, codeWorkspace and flowRuntime all read it.

/**
 * @typedef {{
 *   title: string,
 *   template: string,
 *   engine?: string,
 *   help: string
 * }} BuiltinCode
 */

const PLAYER_TEMPLATE = `// Player — this Character Controller's code. It runs every frame on each player's own
// machine and returns how THIS player moves; Ctrl+S applies it on every peer.
//
//   settings  the card's values: { mode, speed, jumpHeight, eyeHeight, gravity }
//   input     this player's keys: { x, z } (-1..1), jump, sprint (Shift), crouch (Ctrl)
//   time      seconds since Play started
//
// Return only what you change; anything left out keeps the card's value.
// Try it: hold Shift to run.
//   if (input.sprint) return { speed: settings.speed * 1.8 };

return {};
`;

/** @type {Record<string, BuiltinCode>} */
export const BUILTIN_CODE = Object.freeze({
	charcontroller: {
		title: 'Player',
		template: PLAYER_TEMPLATE,
		// the engine it steers, readable (never editable) from the tab's toolbar
		engine: 'charController.js',
		help: 'settings, input, time → { mode, speed, jumpHeight, eyeHeight, gravity }'
	}
});

/** Is this a built-in node type whose code the user can edit? @param {string | undefined} type */
export function isBuiltinCodeType(type) {
	return Object.prototype.hasOwnProperty.call(BUILTIN_CODE, String(type ?? ''));
}

/**
 * The code a node SHOWS: its own `data.code`, else (a built-in that has none yet) the template.
 * @param {any} node @returns {string}
 */
export function codeOfNode(node) {
	const code = node?.data?.code;
	if (typeof code === 'string' && code.length) return code;
	return isBuiltinCodeType(node?.type) ? BUILTIN_CODE[node.type].template : String(code ?? '');
}

/** Does a built-in node actually RUN code (a saved, non-template body)? @param {any} node */
export function builtinCodeActive(node) {
	const code = node?.data?.code;
	return isBuiltinCodeType(node?.type) && typeof code === 'string' && code.trim() !== '' && code !== BUILTIN_CODE[node.type].template;
}

/** The keys a Player script may return, and how each is kept sane. A wrong type is dropped
 * (the card's value stays), a number is clamped to what the walker can use.
 * @type {Record<string, (v: any) => any>} */
const PLAYER_KEYS = {
	mode: (v) => (v === 'walk' || v === 'fly' ? v : undefined),
	speed: (v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 5) : undefined),
	jumpHeight: (v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 20) : undefined),
	eyeHeight: (v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0.1), 10) : undefined),
	gravity: (v) => (typeof v === 'boolean' ? v : undefined)
};

/**
 * Merge what a Player script returned over the card's settings. Unknown keys and wrong types
 * are ignored and reported (so a typo is a badge, not a silent no-op).
 * @param {Record<string, any>} settings @param {any} returned
 * @returns {{settings: Record<string, any>, problems: string[]}}
 */
export function mergePlayerResult(settings, returned) {
	if (returned === undefined || returned === null) return { settings, problems: [] };
	if (typeof returned !== 'object' || Array.isArray(returned))
		return { settings, problems: ['return an object like { speed: 0.2 }'] };
	const out = { ...settings };
	/** @type {string[]} */
	const problems = [];
	for (const [key, value] of Object.entries(returned)) {
		const keep = PLAYER_KEYS[key];
		if (!keep) {
			problems.push('unknown key "' + key + '" (use ' + Object.keys(PLAYER_KEYS).join(', ') + ')');
			continue;
		}
		const v = keep(value);
		if (v === undefined) problems.push('"' + key + '" has the wrong type');
		else out[key] = v;
	}
	return { settings: out, problems };
}
