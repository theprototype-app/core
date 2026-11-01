// Roadmap 86 B1/B2 — THE RELAY CLIENT: the person's tab ⇄ its Durable Object. Imports only the pure
// protocol (the unit layer's entry rule); the socket, the pairing call and the clock are handed in, so
// every transition is tested against fakes.
//
//   idle ─connect─▶ pairing ─token─▶ connecting ─hello/ready─▶ connected
//                      │                 │                         │ blip (any close the DO did not mean)
//                      ▼                 ▼                         ▼
//                    error            closed(reason)  ◀─4001/4002/4003─  reconnecting ─backoff─▶ pairing
//
// · THE TOKEN NEVER RIDES THE URL (it would land in logs): it is the first frame, `hello`.
// · A blip heals on its own: back off 1 s → 30 s and pair again with `resume` = the connection id, so
//   the DO keeps the same connection (a fresh single-use token each time).
// · Revoked / replaced / refused are FINAL: the person must press Connect again (Settings may have
//   revoked it on purpose, or another tab took over).
// · Disconnect is the kill switch: `bye`, close, and every listener hears it at once (in-flight calls
//   are cancelled by the dispatcher on that edge).

import {
	parseFrame,
	helloFrame,
	stateFrame,
	PING_TEXT,
	PONG_TEXT,
	byeFrame,
	closeReason,
	shouldReconnect,
	PING_MS,
	HELLO_TIMEOUT_MS,
	RECONNECT_FIRST_MS,
	RECONNECT_MAX_MS,
	CLOSE
} from './protocol.js';

/**
 * @typedef {'idle'|'pairing'|'connecting'|'connected'|'reconnecting'|'closed'|'error'} RelayPhase
 * @typedef {{id: string, client: string, scopes: string[], lastUsed: number}} Grant
 * @typedef {{phase: RelayPhase, reason: string, message: string, connection: {id: string, client: string, account: string} | null,
 *   connections: Grant[], code: string, attempt: number, retryAt: number, since: number, rttMs: number}} RelayState
 * @typedef {{send: (text: string) => void, close: (code?: number, reason?: string) => void,
 *   onopen: any, onmessage: any, onclose: any, onerror: any}} SocketLike
 * @typedef {{wsUrl: string, pairingToken: string, code?: string, replaces?: boolean, connections?: Grant[]}} Pairing
 */

/** the words the tab shows for a final close @type {Record<string, string>} */
export const CLOSE_WORDS = {
	revoked: 'Claude’s access was revoked (Settings ▸ Connected apps). Press Connect Claude to connect again.',
	replaced: 'Claude is now connected in another tab. Press Connect Claude here to bring it back to this tab.',
	refused: 'The connection was refused — the pairing expired. Press Connect Claude to try again.'
};

/** backoff before reconnect attempt n (1-based) @param {number} n */
export function backoffMs(n) {
	return Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** Math.max(0, n - 1));
}

/**
 * @param {{
 *   pair: (resume: string|null) => Promise<Pairing>,
 *   openSocket: (url: string) => SocketLike,
 *   appVersion: string,
 *   toolNames: () => string[],
 *   onCall?: (frame: {id: string, tool: string, args: any, timeoutMs: number|null, scope: 'read'|'edit', connection: string}) => void,
 *   confirmReplace?: () => Promise<boolean>,
 *   onCancel?: (id: string) => void,
 *   onState?: (s: RelayState) => void,
 *   onDown?: () => void,
 *   visible?: () => boolean,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (t: any) => void
 * }} deps
 */
export function createRelayClient(deps) {
	const now = deps.now ?? (() => Date.now());
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));

	/** @type {RelayState} */
	let state = { phase: 'idle', reason: '', message: '', connection: null, connections: [], code: '', attempt: 0, retryAt: 0, since: now(), rttMs: 0 };
	/** @type {SocketLike | null} */
	let socket = null;
	/** bumps on every new attempt / disconnect: a late callback from an older attempt is ignored */
	let generation = 0;
	/** @type {any} */ let helloTimer = null;
	/** @type {any} */ let pingTimer = null;
	/** @type {any} */ let retryTimer = null;
	let missedPongs = 0;
	/** when the last ping left (the round trip is measured here: the DO's pong carries nothing) */
	let pingSentAt = 0;
	/** connected at least once since the person pressed Connect: later failures retry instead of stopping */
	let everConnected = false;

	/** @param {Partial<RelayState>} patch */
	function set(patch) {
		const wasUp = state.phase === 'connected';
		const phase = patch.phase ?? state.phase;
		state = { ...state, ...patch, since: phase !== state.phase ? now() : state.since };
		if (wasUp && state.phase !== 'connected') {
			try {
				deps.onDown?.();
			} catch {}
		}
		try {
			deps.onState?.(state);
		} catch {}
	}

	function clearTimers() {
		for (const t of [helloTimer, pingTimer, retryTimer]) if (t) clearTimer(t);
		helloTimer = pingTimer = retryTimer = null;
	}

	/** close the socket we hold without letting its onclose run the state machine */
	function dropSocket(/** @type {number} */ code = CLOSE.normal) {
		const s = socket;
		socket = null;
		if (!s) return;
		s.onopen = s.onmessage = s.onclose = s.onerror = null;
		try {
			s.close(code);
		} catch {}
	}

	/** @param {string} text */
	function send(text) {
		if (!socket || state.phase !== 'connected') return false;
		try {
			socket.send(text);
			return true;
		} catch {
			return false;
		}
	}

	/** a blip: back off and pair again (or stop, before the first success) @param {string} why */
	function retry(why) {
		clearTimers();
		dropSocket(4000);
		if (!everConnected) {
			set({ phase: 'error', reason: 'unreachable', message: why, connection: null });
			return;
		}
		const attempt = state.attempt + 1;
		const wait = backoffMs(attempt);
		set({ phase: 'reconnecting', reason: 'blip', message: why, attempt, retryAt: now() + wait });
		const gen = generation;
		retryTimer = setTimer(() => {
			retryTimer = null;
			if (gen === generation) void attempt_();
		}, wait);
	}

	async function attempt_() {
		const gen = ++generation;
		const resume = state.connection?.id ?? null;
		set({ phase: everConnected ? 'reconnecting' : 'pairing', message: '' });
		/** @type {Pairing} */
		let p;
		try {
			p = await deps.pair(resume);
		} catch (e) {
			if (gen !== generation) return;
			const msg = e instanceof Error ? e.message : String(e);
			// signed out / no account: nothing to retry until the person signs in
			if (/** @type {any} */ (e)?.code === 'signin') {
				clearTimers();
				set({ phase: 'closed', reason: 'signin', message: msg, connection: null });
				return;
			}
			retry(msg || 'Could not reach theprototype’s connector service.');
			return;
		}
		if (gen !== generation) return;
		if (!p || typeof p.wsUrl !== 'string' || typeof p.pairingToken !== 'string' || !/^wss:\/\/|^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(p.wsUrl)) {
			retry('The connector service answered without a usable pairing.');
			return;
		}
		// 86-a Δ2: another tab holds the link — ask before taking it (a resume never replaces)
		if (p.replaces === true && !everConnected) {
			const ok = deps.confirmReplace ? await deps.confirmReplace().catch(() => false) : false;
			if (gen !== generation) return;
			if (!ok) {
				finish('normal', '');
				return;
			}
		}
		set({
			phase: everConnected ? 'reconnecting' : 'connecting',
			code: typeof p.code === 'string' ? p.code.slice(0, 16) : '',
			connections: Array.isArray(p.connections) ? p.connections : state.connections
		});
		/** @type {SocketLike} */
		let s;
		try {
			s = deps.openSocket(p.wsUrl);
		} catch (e) {
			retry(e instanceof Error ? e.message : String(e));
			return;
		}
		socket = s;
		s.onopen = () => {
			if (gen !== generation) return;
			try {
				s.send(helloFrame(p.pairingToken, deps.appVersion, deps.toolNames()));
			} catch {}
			helloTimer = setTimer(() => {
				helloTimer = null;
				if (gen === generation && state.phase !== 'connected') retry('The connector service did not answer.');
			}, HELLO_TIMEOUT_MS);
		};
		s.onmessage = (/** @type {any} */ ev) => {
			if (gen !== generation) return;
			const f = parseFrame(ev?.data);
			if (!f) return; // not ours: ignored, never echoed
			switch (f.type) {
				case 'ready':
					if (helloTimer) clearTimer(helloTimer);
					helloTimer = null;
					everConnected = true;
					missedPongs = 0;
					set({ phase: 'connected', reason: '', message: '', connection: f.connection, connections: f.connections, attempt: 0, retryAt: 0 });
					send(stateFrame(deps.visible ? deps.visible() : true));
					schedulePing(gen);
					return;
				case 'refused':
					finish('refused', f.reason);
					return;
				case 'call':
					if (state.phase === 'connected') deps.onCall?.(f);
					return;
				case 'cancel':
					deps.onCancel?.(f.id);
					return;
				case 'revoked':
					// 86-a Δ5: one grant went; the link stays while others remain (the last one closes 4001)
					set({ connections: state.connections.filter((g) => g.id !== f.connection) });
					return;
				case 'ping':
					send(PONG_TEXT);
					return;
				case 'pong':
					missedPongs = 0;
					if (pingSentAt) set({ rttMs: Math.max(0, now() - pingSentAt) });
					pingSentAt = 0;
					return;
			}
		};
		s.onclose = (/** @type {any} */ ev) => {
			if (gen !== generation) return;
			socket = null;
			const code = Number(ev?.code) || 1006;
			if (shouldReconnect(code)) retry('The connection dropped — reconnecting.');
			else finish(closeReason(code), String(ev?.reason ?? ''));
		};
		s.onerror = () => {
			/* onclose follows and decides */
		};
	}

	/** @param {number} gen */
	function schedulePing(gen) {
		if (pingTimer) clearTimer(pingTimer);
		pingTimer = setTimer(() => {
			pingTimer = null;
			if (gen !== generation || state.phase !== 'connected') return;
			if (missedPongs >= 2) {
				retry('The connection stopped answering — reconnecting.');
				return;
			}
			missedPongs++;
			pingSentAt = now();
			send(PING_TEXT);
			schedulePing(gen);
		}, PING_MS);
	}

	/** a FINAL close: no reconnect @param {string} reason @param {string} detail */
	function finish(reason, detail) {
		clearTimers();
		dropSocket();
		generation++;
		everConnected = false;
		if (reason === 'normal') {
			set({ phase: 'idle', reason: '', message: '', connection: null, connections: [], attempt: 0 });
			return;
		}
		set({ phase: 'closed', reason, message: CLOSE_WORDS[reason] ?? detail ?? '', connection: null, connections: [], attempt: 0 });
	}

	return {
		/** start (or restart) pairing — the Connect Claude press */
		connect() {
			if (state.phase === 'connected' || state.phase === 'pairing' || state.phase === 'connecting') return;
			clearTimers();
			dropSocket();
			everConnected = false;
			state = { ...state, connection: null, attempt: 0 };
			void attempt_();
		},
		/** the kill switch: say bye, close, stop retrying */
		disconnect() {
			if (socket && state.phase === 'connected') {
				try {
					socket.send(byeFrame());
				} catch {}
			}
			finish('normal', '');
		},
		/** send one frame (a result); false when not connected */
		send,
		/** the page's visibility changed: tell the DO (it answers "your tab is in the background") @param {boolean} visible */
		setVisible(visible) {
			send(stateFrame(visible));
		},
		state: () => state
	};
}
