// 86-fix N2 — what a `join_session` link may be, as a PURE function (unit-tested). A remote caller hands the
// tab a string; this decides, before anything is shown, whether it names a session on THIS app at all:
//
//   · https://<this app's origin>/#F0FD3[&invite=…][~srv=…]  — the share / invite link
//   · #F0FD3…  or a bare session id (F0FD3, F0FD3&invite=…)
//
// Anything else (another site, no session in it, an id outside the PeerJS shape) is refused with a reason.
// The answer is the HASH the app's own pasted-link path reads (inviteLinks.handleInviteHash), plus the facts
// the Join / Cancel card names. Imports nothing.

/** how long a link may be (an invite token + a server tail fit easily) */
export const MAX_LINK = 2048;
/** a PeerJS id as this app mints and accepts them (case-insensitive) */
const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * @param {any} raw the link the caller passed
 * @param {string[]} origins the origins whose links name a session here (this tab's own, plus the app's)
 * @returns {{hash: string, id: string, invite: boolean, server: boolean} | {error: string}}
 */
export function parseJoinLink(raw, origins) {
	const text = typeof raw === 'string' ? raw.trim() : '';
	if (!text) return { error: 'link is empty — pass the session link the person gave you (https://theprototype.app/#ABCDE)' };
	if (text.length > MAX_LINK) return { error: 'that link is too long to be a session link' };
	let hash = '';
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
		/** @type {URL} */
		let url;
		try {
			url = new URL(text);
		} catch {
			return { error: 'that is not a link this app can read' };
		}
		if (!origins.includes(url.origin)) return { error: 'that link is not a theprototype session link (' + url.origin.slice(0, 60) + ')' };
		hash = url.hash;
		if (!hash || hash === '#') return { error: 'that link has no session in it — a session link ends in #ABCDE' };
	} else hash = text.startsWith('#') ? text : '#' + text;
	const body = hash.slice(1);
	const head = body.split('~')[0];
	const id = head.split('&')[0].toLowerCase();
	if (!SESSION_ID.test(id)) return { error: 'that link does not name a session (expected an id like ABCDE after the #)' };
	return { hash, id, invite: /(^|&)invite=[^&~]+/i.test(head), server: /(^|~)srv=/i.test(body.slice(head.length)) };
}
