// Session links (roadmap 55 A3). An agent is handed what a person is handed: a link like
// `https://theprototype.app/#F0FD3&agent&invite=…` — or just the id `F0FD3`. This module turns
// either into the three things a bridge needs: the page to open (browser engine), the
// signaling server and the TURN endpoint (wire engine). Pure: no network, no peerjs.
//
// Hash grammar (the app's, see core src/lib/peerServer.js parseInviteHash + 55-invite):
//   #<peerId>[&agent][&invite=<token>][&<key>[=<value>]…][~srv=<host[:port][/path]|public>]
//
// THE TOKEN IS A SECRET. An invite token in a link auto-approves (and on cloud builds grants
// edit), so nothing here logs it: `redactLink` is what goes to stderr and into `status`.

/** Where theprototype.app's own sessions signal (test flight 2, T3): never the public cloud. */
export const PRODUCTION = Object.freeze({
	origin: 'https://theprototype.app',
	signaling: Object.freeze({ host: 'peerjs.theprototype.app', port: 443, path: '/peerjs', secure: true }),
	stun: Object.freeze(['stun:peerjs.theprototype.app:3478']),
	// PocketBase mints short-lived coturn credentials (cloud pb/pb_hooks/turn.pb.js, roadmap 36 B15)
	turnApi: 'https://pb.theprototype.app/api/tp/turn'
});

/** Hostnames that ARE theprototype.app's deployment (production, Pages previews, deployment ids). */
export function isProductionHost(hostname) {
	const h = String(hostname || '').toLowerCase();
	return (
		h === 'theprototype.app' ||
		h.endsWith('.theprototype.app') ||
		h === 'theprototype.pages.dev' ||
		h.endsWith('.theprototype.pages.dev')
	);
}

const PEER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

/**
 * Parse a session link or a bare peer id.
 * @param {string} input
 * @param {{ defaultOrigin?: string }} [opts]
 * @returns {{ origin: string, path: string, peerId: string, invite: string | null, agent: boolean,
 *   srv: string | null, extra: string[] }}
 */
export function parseLink(input, opts = {}) {
	let raw = String(input ?? '').trim();
	if (!raw) throw new Error('no session link or peer id given');
	const defaultOrigin = (opts.defaultOrigin || PRODUCTION.origin).replace(/\/+$/, '');

	let origin = defaultOrigin;
	let path = '/';
	let hash = '';
	if (raw.startsWith('#')) {
		hash = raw.slice(1);
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[^\s#/]+\.[^\s#/]+(:\d+)?(\/|#|$)/.test(raw)) {
		// a URL, with or without its scheme (`theprototype.app/#F0FD3` is what people paste)
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
		let u;
		try {
			u = new URL(raw);
		} catch {
			throw new Error('not a session link: ' + redactLink(String(input)));
		}
		if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('a session link is http(s): ' + u.protocol);
		origin = u.origin;
		path = u.pathname || '/';
		hash = u.hash.replace(/^#/, '');
	} else {
		hash = raw; // a bare id, possibly with the hash tail (`F0FD3&invite=…`)
	}

	// `~srv=` is the app's own server tail; everything else after the id is `&`-separated
	let srv = null;
	const tilde = hash.indexOf('~');
	let tail = '';
	if (tilde >= 0) {
		tail = hash.slice(tilde + 1);
		hash = hash.slice(0, tilde);
	}
	const [idPart, ...segments] = hash.split('&');
	for (const seg of tail.split(/[~&]/)) {
		if (seg.startsWith('srv=')) srv = seg.slice(4);
		else if (seg) segments.push(seg);
	}
	const peerId = decodeSafe(idPart).trim();
	if (!peerId) throw new Error('the link names no session: expected https://theprototype.app/#<id>');
	if (!PEER_ID.test(peerId)) throw new Error('not a session id: "' + peerId.slice(0, 40) + '"');

	let invite = null;
	let agent = false;
	/** @type {string[]} */
	const extra = [];
	for (const seg of segments) {
		if (!seg) continue;
		const eq = seg.indexOf('=');
		const key = (eq >= 0 ? seg.slice(0, eq) : seg).toLowerCase();
		if (key === 'invite' && eq >= 0) invite = seg.slice(eq + 1) || null;
		else if (key === 'agent') agent = true;
		else extra.push(seg);
	}
	// the app dials ids lower-cased (peerHandler `open`): so does the agent
	return { origin, path, peerId: peerId.toLowerCase(), invite, agent, srv, extra };
}

/** @param {string} s */
function decodeSafe(s) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * The page the browser engine opens: the link's own page with `&agent` (installs the app's
 * `window.tpAgent`, 55 A2) and the invite carried through. `compat` drops both — an app older
 * than 1.48 would read `id&agent` as the peer id and dial nobody.
 * @param {ReturnType<typeof parseLink>} link @param {{ compat?: boolean }} [opts]
 */
export function pageUrl(link, opts = {}) {
	let hash = link.peerId;
	if (!opts.compat) {
		hash += '&agent';
		if (link.invite) hash += '&invite=' + link.invite;
		for (const e of link.extra) hash += '&' + e;
	}
	if (link.srv) hash += '~srv=' + link.srv;
	return link.origin + (link.path || '/') + '#' + hash;
}

/** A link safe to print: the invite token becomes `…`. @param {string | ReturnType<typeof parseLink>} link */
export function redactLink(link) {
	if (typeof link === 'string') return link.replace(/(invite=)[^&~\s]*/gi, '$1…');
	return redactLink(pageUrl(link)).replace('&agent', link.agent ? '&agent' : '');
}

/** Decode a `~srv=` value the way the app does (peerServer.js decodeInviteServer). @param {string} srv */
export function decodeSrv(srv) {
	if (!srv) return null;
	if (srv === 'public') return { public: true };
	const raw = decodeSafe(srv);
	const m = /^([^:/]+)(?::(\d+))?(\/.*)?$/.exec(raw);
	if (!m) return null;
	return { host: m[1], port: Number(m[2]) || 443, path: m[3] || '/peerjs', secure: true };
}

/**
 * Signaling + ICE for the wire engine, from the link (T3/T4). Order: an explicit
 * `--peer-server` (the caller passes it as `override`) > the link's `~srv=` > the
 * deployment the link is on. A link on a host we do not know still gets production
 * signaling — that is what a default build of the app uses — flagged `guessed`.
 * `server: null` means the public PeerJS cloud, and only ever when asked for.
 * @param {ReturnType<typeof parseLink>} link
 * @param {{ override?: any, turnUrl?: string | false }} [opts]
 * @returns {{ server: any, stun: string[], turnApi: string | null, source: string, guessed: boolean }}
 */
export function endpointsFor(link, opts = {}) {
	const turnFlag = opts.turnUrl;
	const turn = (/** @type {string | null} */ dflt) => (turnFlag === false ? null : turnFlag || dflt);
	if (opts.override !== undefined) {
		if (opts.override === 'public' || opts.override?.public) return { server: null, stun: [], turnApi: turn(null), source: 'flag:public', guessed: false };
		return { server: opts.override, stun: [], turnApi: turn(null), source: 'flag', guessed: false };
	}
	const srv = link.srv ? decodeSrv(link.srv) : null;
	if (srv?.public) return { server: null, stun: [], turnApi: turn(null), source: 'link:public', guessed: false };
	if (srv) {
		const prod = isProductionHost(srv.host) || srv.host === PRODUCTION.signaling.host;
		return { server: srv, stun: prod ? [...PRODUCTION.stun] : [], turnApi: turn(prod ? PRODUCTION.turnApi : null), source: 'link:srv', guessed: false };
	}
	let host = '';
	try {
		host = new URL(link.origin).hostname;
	} catch {}
	const known = isProductionHost(host);
	return {
		server: { ...PRODUCTION.signaling },
		stun: [...PRODUCTION.stun],
		turnApi: turn(PRODUCTION.turnApi),
		source: known ? 'origin' : 'default',
		guessed: !known
	};
}

/** Loopback / dev origins whose certificate is the local dev cert. @param {string} origin */
export function isLocalOrigin(origin) {
	try {
		const u = new URL(origin);
		// `theprototype.app:5456` is how the e2e suite reaches a dev server (/etc/hosts → 127.0.0.1):
		// production never names a port
		return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname) || !!u.port;
	} catch {
		return false;
	}
}
