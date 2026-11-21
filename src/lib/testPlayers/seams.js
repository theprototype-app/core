// 61 G3 — Test with players: the two core seams, in a LEAF (imports nothing) so the runner (host.js) can
// install them without a static edge to peerHandler — a lazy chunk's static graph is what Vite lists to
// preload, and peerHandler's is the whole app (that list alone was 5 KB of the editor's boot).

/** the key every message of the local link carries (hub, bots, commands) */
export const LINK_TAG = '__tpLocalLink';

/** grafts the local link onto every Peer this tab makes while a test runs @type {((peer: any) => void) | null} */
export let peerWrap = null;
/** may this incoming conn be admitted without a card (a bot this tab started)? @type {((conn: any) => boolean) | null} */
export let botAdmit = null;

/** The runner installs both when a test starts and clears them on Stop. @param {((peer: any) => void) | null} wrap @param {((conn: any) => boolean) | null} admit */
export function setTestPlayersSeams(wrap, admit) {
	peerWrap = typeof wrap === 'function' ? wrap : null;
	botAdmit = typeof admit === 'function' ? admit : null;
}
