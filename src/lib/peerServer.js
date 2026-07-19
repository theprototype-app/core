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
 * Resolve the `new Peer(id, options)` options for the current settings.
 * @param {{ isLocalDev?: boolean, forcePublic?: boolean }} [ctx]
 * @returns {{ options: any, canFallback: boolean }}
 *   options === undefined  => the public PeerJS cloud (new Peer(id) with defaults)
 *   canFallback === true   => on an early server error, retry against the public cloud
 */
export function resolvePeerOptions(ctx = {}) {
	const { isLocalDev = false, forcePublic = false } = ctx;
	if (forcePublic) return { options: undefined, canFallback: false };

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
