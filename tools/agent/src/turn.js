// Short-lived TURN credentials for the wire engine (test flight 2 T4). Production's coturn has
// no static user: PocketBase mints `{urls, username, credential, ttl, expiresAt}` at
// `GET /api/tp/turn` (cloud pb/pb_hooks/turn.pb.js), and the browser engine inherits them from
// the page. The wire engine asks the same endpoint, and goes without relay when it cannot.
//
// A TURN entry needs BOTH halves: Chromium (and libwebrtc in @roamhq/wrtc) refuses the whole
// RTCPeerConnection over an entry with an empty username or credential, which would kill every
// connection while signaling looks healthy (core peerServer.js iceServers()). So a partial
// answer is no answer.

/**
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, nowS?: number }} [opts]
 * @returns {Promise<{ entry: {urls: string[], username: string, credential: string} | null, reason: string }>}
 */
export async function fetchTurn(url, opts = {}) {
	const f = opts.fetchImpl || globalThis.fetch;
	if (!url || typeof f !== 'function') return { entry: null, reason: 'no endpoint' };
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 5000);
	try {
		const res = await f(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
		if (!res.ok) return { entry: null, reason: 'HTTP ' + res.status };
		const c = await res.json();
		const urls = Array.isArray(c?.urls) ? c.urls.filter((u) => typeof u === 'string' && u) : typeof c?.urls === 'string' ? [c.urls] : [];
		const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
		if (!urls.length || typeof c.username !== 'string' || !c.username || typeof c.credential !== 'string' || !c.credential) {
			return { entry: null, reason: 'incomplete credential' };
		}
		if (c.expiresAt && Number(c.expiresAt) <= nowS) return { entry: null, reason: 'expired credential' };
		return { entry: { urls, username: c.username, credential: c.credential }, reason: 'ok' };
	} catch (e) {
		return { entry: null, reason: /** @type {any} */ (e)?.name === 'AbortError' ? 'timed out' : String(/** @type {any} */ (e)?.message || e) };
	} finally {
		clearTimeout(timer);
	}
}

/** RTCIceServer[] from STUN urls + an optional TURN entry. @param {string[]} stun @param {any} turn */
export function iceServersFrom(stun, turn) {
	/** @type {any[]} */
	const list = [];
	if (stun && stun.length) list.push({ urls: [...stun] });
	if (turn) list.push({ urls: [...turn.urls], username: turn.username, credential: turn.credential });
	return list;
}
