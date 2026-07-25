import { writable, get } from 'svelte/store';

/**
 * Peer signaling-server selection + ICE (STUN/TURN) config.
 *
 * Three modes:
 *  - 'default' : use the self-hosted server baked in at build time (VITE_PEER_*),
 *                and FALL BACK to the public PeerJS cloud if it can't be reached.
 *                If no self-hosted server is configured, this is just the public cloud.
 *  - 'public'  : always the public PeerJS cloud, no fallback (there's nothing to fall
 *                back FROM).
 *  - 'custom'  : the user's own server from the Settings fields. NO fallback — if the
 *                user pins a server, we honour it and surface errors instead of silently
 *                using someone else's infra.
 *
 * The self-hosted values live in `.env` (gitignored); Vite inlines VITE_* at build time.
 * See .env.example.
 */

/** @param {string} s @returns {string[]} */
function splitUrls(s) {
	return (s || '')
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);
}

/** Build RTCIceServer[] from a config shape (env or custom). @param {any} c */
function iceServers(c) {
	const list = [];
	const stun = splitUrls(c.stunUrls);
	if (stun.length) list.push({ urls: stun });
	const turn = splitUrls(c.turnUrls);
	if (turn.length && c.turnUsername) {
		list.push({ urls: turn, username: c.turnUsername, credential: c.turnCredential || '' });
	}
	return list;
}

/** Build a `new Peer(id, options)` options object from a server config shape. @param {any} c */
function serverOptions(c) {
	/** @type {Record<string, any>} */
	const opts = {
		host: c.host,
		port: Number(c.port) || 443,
		secure: c.secure !== false,
		path: c.path || '/peerjs'
	};
	if (c.key) opts.key = c.key;
	const ice = iceServers(c);
	if (ice.length) opts.config = { iceServers: ice };
	return opts;
}

// --- self-hosted defaults, inlined from the environment at build time -------
const ENV = {
	host: import.meta.env.VITE_PEER_HOST || '',
	port: import.meta.env.VITE_PEER_PORT || 443,
	path: import.meta.env.VITE_PEER_PATH || '/peerjs',
	secure: import.meta.env.VITE_PEER_SECURE !== 'false',
	key: import.meta.env.VITE_PEER_KEY || '',
	stunUrls: import.meta.env.VITE_STUN_URLS || '',
	turnUrls: import.meta.env.VITE_TURN_URLS || '',
	turnUsername: import.meta.env.VITE_TURN_USERNAME || '',
	turnCredential: import.meta.env.VITE_TURN_CREDENTIAL || ''
};

/** True when a self-hosted server was configured at build time. */
export const HAS_SELF_HOSTED = !!ENV.host;

/** The self-hosted host, for display in Settings (empty string if none). */
export const SELF_HOSTED_HOST = ENV.host;

// The local-dev signaling server (npm run peer on :9001), used only in default
// mode when the app is served from a non-production hostname.
const LOCAL_DEV_OPTIONS = { secure: true, host: 'localhost', port: 9001 };

const LS_KEY = 'peerServerConfig';

function defaults() {
	return {
		/** @type {'default'|'public'|'custom'} */
		mode: 'default',
		custom: {
			host: '',
			port: 443,
			path: '/peerjs',
			secure: true,
			key: '',
			stunUrls: '',
			turnUrls: '',
			turnUsername: '',
			turnCredential: ''
		}
	};
}

function load() {
	if (typeof localStorage === 'undefined') return defaults();
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			return { ...defaults(), ...parsed, custom: { ...defaults().custom, ...(parsed.custom || {}) } };
		}
	} catch {
		/* ignore malformed */
	}
	return defaults();
}

/** @type {import('svelte/store').Writable<any>} */
export const peerServerConfig = writable(load());
peerServerConfig.subscribe((v) => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(v));
	} catch {
		/* storage full / disabled */
	}
});

/**
 * Human-readable description of the RESOLVED signaling server, for the Connect
 * indicator (I5). Mirrors resolvePeerOptions' branch logic so the label always
 * matches the server actually used. `didFallback` is layered on by peerHandler once
 * a self-hosted server proves unreachable.
 * @typedef {'self-hosted'|'public'|'custom'|'local'} PeerServerKind
 * @typedef {{ kind: PeerServerKind, label: string, host: string, port: number, path: string, didFallback: boolean }} PeerServerStatus
 */

// --- invite-link server override (CN-3, roadmap #14) -------------------------
//
// A share link can pin the signaling world it was minted in: `#A1B2C~srv=public`
// or `#A1B2C~srv=<encoded host[:port][path]>`. The joiner applies the override
// BEFORE creating its Peer (peerHandler parses the hash at constructor-top — the
// peer.on('open') hash flow runs too late for server selection). Session-only,
// never persisted, and it never falls back: a pinned invite server must not
// silently land the joiner in a different world.

/** @type {{ forcePublic?: boolean, custom?: any } | null} */
let inviteOverride = null;

/** Install (or clear with null) the session-only invite server override. @param {any} ov */
export function applyInviteServerOverride(ov) {
	inviteOverride = ov || null;
}

/** Split a location.hash into peer id + optional invite server tail.
 * @param {string} rawHash @returns {{ peerId: string, srv: string | null }} */
export function parseInviteHash(rawHash) {
	const h = (rawHash || '').replace(/^#/, '');
	const i = h.indexOf('~');
	if (i < 0) return { peerId: h, srv: null };
	const peerId = h.slice(0, i);
	const m = /(?:^|~)srv=([^~]*)/.exec(h.slice(i));
	return { peerId, srv: m ? m[1] : null };
}

/** Decode a `~srv=` value into an override shape. @param {string} srv */
export function decodeInviteServer(srv) {
	if (!srv) return null;
	if (srv === 'public') return { forcePublic: true };
	const raw = decodeURIComponent(srv);
	// host[:port][/path]
	const m = /^([^:/]+)(?::(\d+))?(\/.*)?$/.exec(raw);
	if (!m) return null;
	return {
		custom: {
			host: m[1],
			port: Number(m[2]) || 443,
			path: m[3] || '/peerjs',
			secure: true
		}
	};
}

/**
 * The `~srv=` tail for a copied invite link — EMPTY when the resolved server is
 * what a fresh default build would resolve anyway (self-hosted default, plain
 * public with nothing configured, local dev). Only fallback / explicit-public /
 * custom servers get encoded.
 * @param {PeerServerStatus | null} status @returns {string}
 */
export function inviteServerParam(status) {
	if (!status) return '';
	if (status.kind === 'self-hosted' || status.kind === 'local') return '';
	if (status.kind === 'public') {
		// only meaningful when the default build would NOT have picked public
		return status.didFallback || HAS_SELF_HOSTED ? '~srv=public' : '';
	}
	// custom
	const port = status.port && status.port !== 443 ? ':' + status.port : '';
	const path = status.path && status.path !== '/peerjs' && status.path !== '/' ? status.path : '';
	return '~srv=' + encodeURIComponent(status.host + port + path);
}

/**
 * The REST endpoint used to measure signaling-server reachability/ping — the
 * peerjs INFO route (`GET <path>` returns server JSON, e.g.
 * https://peerjs.theprototype.app/peerjs). Public cloud maps to its real API host.
 * @param {PeerServerStatus | null} status @returns {string | null}
 */
export function peerServerPingUrl(status) {
	if (!status) return null;
	if (status.kind === 'public') return 'https://0.peerjs.com/';
	const port = status.port && status.port !== 443 ? ':' + status.port : '';
	const path = status.path && status.path !== '/' ? status.path : '';
	return `https://${status.host}${port}${path}`;
}

/**
 * The peerjs DISCOVERY endpoint (`GET <path>/<key>/peers`) — 200 = discovery on,
 * 401 = off. Best-effort probe target for the info drawer.
 * @param {PeerServerStatus | null} status @param {string=} key @returns {string | null}
 */
export function peerServerPeersUrl(status, key = 'peerjs') {
	// the PUBLIC PeerJS cloud has no discovery endpoint — probing it just logs a
	// noisy 404, so skip it (discovery shows as "—").
	if (!status || status.kind === 'public') return null;
	const base = peerServerPingUrl(status);
	if (!base) return null;
	return base.replace(/\/$/, '') + '/' + key + '/peers';
}

/**
 * @param {{ isLocalDev?: boolean, forcePublic?: boolean }} [ctx]
 * @returns {PeerServerStatus}
 */
export function describePeerServer(ctx = {}) {
	const { isLocalDev = false, forcePublic = false } = ctx;
	const publicCloud = () => ({
		kind: /** @type {PeerServerKind} */ ('public'),
		label: 'public cloud',
		host: 'PeerJS public cloud',
		port: 443,
		path: '/',
		didFallback: false
	});

	if (forcePublic) return publicCloud();

	// invite override wins for the session (CN-3)
	if (inviteOverride) {
		if (inviteOverride.forcePublic) return publicCloud();
		const c = inviteOverride.custom || {};
		if (c.host) {
			return {
				kind: 'custom',
				label: 'invite server',
				host: c.host,
				port: Number(c.port) || 443,
				path: c.path || '/peerjs',
				didFallback: false
			};
		}
	}

	const cfg = get(peerServerConfig);
	if (cfg.mode === 'public') return publicCloud();

	if (cfg.mode === 'custom') {
		const c = cfg.custom || {};
		if (!c.host) return publicCloud(); // misconfigured -> public
		return {
			kind: 'custom',
			label: 'custom',
			host: c.host,
			port: Number(c.port) || 443,
			path: c.path || '/peerjs',
			didFallback: false
		};
	}

	// default mode
	if (isLocalDev) {
		return {
			kind: 'local',
			label: 'local dev',
			host: LOCAL_DEV_OPTIONS.host,
			port: LOCAL_DEV_OPTIONS.port,
			path: '/peerjs',
			didFallback: false
		};
	}
	if (HAS_SELF_HOSTED) {
		return {
			kind: 'self-hosted',
			label: 'self-hosted',
			host: ENV.host,
			port: Number(ENV.port) || 443,
			path: ENV.path || '/peerjs',
			didFallback: false
		};
	}
	return publicCloud();
}

/**
 * The signaling server currently in use, for the Connect indicator. peerHandler
 * updates this on peer creation and again if the self-hosted server falls back to
 * the public cloud. Starts null (unknown) until the first PeerConnection is built.
 * @type {import('svelte/store').Writable<PeerServerStatus|null>}
 */
export const peerServerStatus = writable(null);

/**
 * Resolve the `new Peer(id, options)` options for the current settings.
 * @param {{ isLocalDev?: boolean, forcePublic?: boolean }} [ctx]
 * @returns {{ options: any, canFallback: boolean }}
 *   options === undefined  => the public PeerJS cloud (new Peer(id) with defaults)
 *   canFallback === true   => on an early server error, retry against the public cloud
 */
export function resolvePeerOptions(ctx = {}) {
	const { isLocalDev = false, forcePublic = false } = ctx;
	if (forcePublic) return { options: undefined, canFallback: false };

	// invite override wins for the session (CN-3) — and never falls back: a pinned
	// invite server must not silently land the joiner in a different world.
	if (inviteOverride) {
		if (inviteOverride.forcePublic) return { options: undefined, canFallback: false };
		const c = inviteOverride.custom || {};
		if (c.host) return { options: serverOptions(c), canFallback: false };
	}

	const cfg = get(peerServerConfig);

	if (cfg.mode === 'public') return { options: undefined, canFallback: false };

	if (cfg.mode === 'custom') {
		const c = cfg.custom || {};
		if (!c.host) return { options: undefined, canFallback: false }; // misconfigured -> public, no fallback
		return { options: serverOptions(c), canFallback: false };
	}

	// default
	if (isLocalDev) return { options: LOCAL_DEV_OPTIONS, canFallback: false };
	if (HAS_SELF_HOSTED) return { options: serverOptions(ENV), canFallback: true };
	return { options: undefined, canFallback: false };
}
