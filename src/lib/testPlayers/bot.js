// 61 G3 — TEST WITH PLAYERS: WHAT A BOT FRAME DOES BESIDES BEING AN APP. Loaded only in a bot frame
// (peerHandler, beside localLink.js). A bot is a whole app instance that joined the host over the local
// link like any guest; this adds the few things a person would otherwise do in it:
//   - a PLAYER bot enters Play once it has joined (flat: there is no gesture, and no headset)
//   - it is silent (every bus at 0 — four copies of the game's sound is not a test of anything)
//   - the host's commands: leave (Stop test: the bot's own Leave, so its goodbye clears it everywhere),
//     play / editor, and focus (Drive)

import { get } from 'svelte/store';
import { LINK_TAG } from './seams.js';
import { botMayApply } from './roles.js';

// Everything else is a dynamic import inside startBot: peerHandler loads this module lazily, and a lazy
// chunk's STATIC graph is what Vite lists in the importer's preload table (peerHandler is in the boot).

/** @type {{test: string, role: string, n: number} | null} */
let me = null;
/** the other bots' roles, from the host (`roles` command) @type {Record<string, any>} */
let roles = {};

/** @param {{test: string, role: string, n: number}} bot */
export async function startBot(bot) {
	if (me) return;
	me = bot;
	// the roles map can arrive while the imports below load: keep it from the first message
	window.addEventListener('message', (e) => {
		if (e.source !== window.parent || e.origin !== location.origin) return;
		const d = e.data;
		if (d && d[LINK_TAG] === 1 && d.kind === 'cmd' && d.test === bot.test && d.cmd === 'roles' && d.arg && typeof d.arg === 'object') roles = { ...d.arg };
	});
	const [{ peers }, { isLocked }, { sessionHost }, { BUS_NAMES, setBusLevel }, { requestPlay, exitPlay }, { setTestPlayersGate }, { playModeOf }] = await Promise.all([
		import('../../stores/appStore'),
		import('../../stores/sceneStore'),
		import('../connectionState.js'),
		import('../audioEngine.js'),
		import('../playMode.js'),
		import('../cloudHooks.js'),
		import('../gamePresence.js')
	]);
	// the same receive-side gate the host holds, for messages from the OTHER bots (the host is not in the map)
	setTestPlayersGate((peerId, type) => {
		const role = roles[peerId];
		return role ? botMayApply(role, type, playModeOf(peerId) === 'playing') : true;
	});
	/** has this bot joined the host's session (an open link to the peer that approved it)? */
	const joined = () => {
		/** @type {any} */
		const pc = get(peers);
		const host = get(sessionHost);
		return !!host && !!pc?.openedPeers?.has(host);
	};
	for (const name of BUS_NAMES) setBusLevel(name, 0);
	document.documentElement.dataset.tpBot = bot.role;
	// a player plays, once joined
	if (bot.role === 'player') {
		const tick = setInterval(() => {
			if (!joined()) return;
			clearInterval(tick);
			requestPlay({ flat: true });
		}, 250);
	}
	window.addEventListener('message', (e) => {
		if (e.source !== window.parent || e.origin !== location.origin) return;
		const d = e.data;
		if (!d || d[LINK_TAG] !== 1 || d.kind !== 'cmd' || d.test !== bot.test) return;
		/** @type {any} */
		const pc = get(peers);
		if (d.cmd === 'leave') {
			if (get(isLocked) === true) exitPlay();
			try {
				pc?.leaveSession?.();
			} catch (error) {
				console.error('bot leave failed', error);
			}
		} else if (d.cmd === 'play') {
			requestPlay({ flat: true });
		} else if (d.cmd === 'editor') {
			if (get(isLocked) === true) exitPlay();
		} else if (d.cmd === 'focus') {
			window.focus();
			/** @type {HTMLElement | null} */ (document.querySelector('canvas'))?.focus?.();
		}
	});
}
