// mcp-fix — WHAT BECAME OF A JOIN. Imports nothing (unit-tested). joinSession hands in what the app can see each
// moment; `nextJoinState` says where the join stands, so `join_session`'s answer and status.lastJoinResult agree.
//
//   asking    the person pressed Join; the app is still asking them something (leave a session, another server)
//   dialing   the request went out; nothing has answered yet, so nobody knows the session exists
//   waiting   the host's page answered; the host has to press Approve
//   joined    in the session
//   failed    no such session online, the host said no, nobody answered, or the person backed out

/** how long a dial may go unanswered before join_session reports back (the Worker's budget for a call is 120 s) */
export const JOIN_DIAL_WAIT_MS = 15 * 1000;
/** how long the app's own questions (leave a session? another server?) may stay open */
export const JOIN_ASK_WAIT_MS = 120 * 1000;

/**
 * @typedef {{session: string, state: 'asking'|'dialing'|'waiting'|'joined'|'failed', note: string, at: number}} JoinResult
 */

/**
 * @param {JoinResult} was
 * @param {{requested: boolean, linkOpen: boolean, joined: boolean, now: number, startedAt: number}} facts
 *   `requested` = the app holds an outbound request for this session; `linkOpen` = its page answered; `joined` = in the session
 * @returns {JoinResult}
 */
export function nextJoinState(was, facts) {
	if (was.state === 'joined' || was.state === 'failed') return was;
	const at = facts.now;
	const to = (/** @type {JoinResult['state']} */ state, /** @type {string} */ note) => (state === was.state ? was : { session: was.session, state, note, at });
	if (facts.joined) return to('joined', 'This tab is in session ' + was.session + '.');
	if (facts.requested) return facts.linkOpen ? to('waiting', 'Session ' + was.session + ' answered. Its host has to press Approve.') : to('dialing', 'Asking for session ' + was.session + '. Nothing has answered yet.');
	if (was.state === 'asking') {
		return facts.now - facts.startedAt > JOIN_ASK_WAIT_MS ? to('failed', 'The person did not finish the app’s question, so this tab did not join.') : was;
	}
	// the request is gone and we are not in: peer-unavailable or an expiry ended it, or the host's page went away
	return to('failed', was.state === 'waiting' ? 'The host of session ' + was.session + ' did not let this tab in.' : 'No session ' + was.session + ' is online. Check the id with the person.');
}

/** Is this state one a caller still has to wait for? @param {JoinResult['state']} state */
export const joinSettled = (state) => state === 'joined' || state === 'failed';
