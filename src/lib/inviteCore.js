// 55 A4 — invite links for people and AI agents: the PURE half (imports nothing, so the
// unit layer runs it under plain node; `inviteStore.js` is the stateful half).
//
// The scheme is the room-code rule (roadmap 29, cloud `roomAccess.js`) with a random token
// in place of a typed code:
//   token  = 128 random bits, base64url — lives ONLY in the link's hash, which browsers never
//            send to a server, and is consumed (replaceState) the moment the app reads it
//   key    = sha256('tpinv1:' + token)            the host keeps it, on its own device
//   id     = sha256('tpinvid:' + token)[0..12)     names the invite on the dial (not secret)
//   proof  = sha256(key + ':' + joinerId + ':' + hostId)   what the joiner's dial carries
// The token itself is never sent and never logged. The proof is bound to BOTH peer ids, so
// a proof lifted off the signaling server is useless to any other peer id (a replay from
// another id fails the compare), and only the host — the one peer holding the key — can
// check it. No valid proof, no auto-grant: a failed check is the normal approval card.
//
// The host verifies RECEIVE-SIDE and synchronously (a dial is decided the moment it
// arrives), hence the small synchronous SHA-256 below — the same function, digest for
// digest, as the cloud plugin's `roomAccess.sha256HexSync` (the unit test pins vectors).

/** expiry choices offered by the sheet (ms) */
export const INVITE_EXPIRY = Object.freeze({ '10m': 10 * 60_000, '30m': 30 * 60_000, '24h': 24 * 60 * 60_000 });
export const DEFAULT_EXPIRY = '30m';
/** "Can be used by" choices */
export const INVITE_USES = Object.freeze([1, 5, 10, 25]);
/** how long a spent/expired/revoked record is kept so Users can still say "used by …" */
export const KEEP_AFTER_MS = 24 * 60 * 60_000;
/** a used-by name is the joiner's claim — shown as text only, and short */
export const NAME_MAX = 32;

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** SHA-256 of a string's UTF-8 bytes, hex — synchronous. @param {string} str */
export function sha256HexSync(str) {
	const msg = new TextEncoder().encode(String(str));
	const bitLen = msg.length * 8;
	const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
	padded.set(msg);
	padded[msg.length] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
	dv.setUint32(padded.length - 4, bitLen >>> 0);
	const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const W = new Uint32Array(64);
	const rotr = (/** @type {number} */ x, /** @type {number} */ n) => (x >>> n) | (x << (32 - n));
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
			const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
			W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
	}
	return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** equal-length compare that does not stop at the first difference. @param {any} a @param {any} b */
export function sameHex(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** a fresh token: 128 random bits, base64url (22 chars) @returns {string} */
export function newToken() {
	const b = new Uint8Array(16);
	globalThis.crypto.getRandomValues(b);
	let s = '';
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** what a token may look like (base64url, 16-64 chars) — anything else is not a token @param {any} t */
export const isToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t);

/** @param {string} token */
export const inviteKey = (token) => sha256HexSync('tpinv1:' + token);
/** @param {string} token */
export const inviteId = (token) => sha256HexSync('tpinvid:' + token).slice(0, 12);
/** @param {string} key @param {string} joinerId @param {string} hostId */
export const inviteProof = (key, joinerId, hostId) =>
	sha256HexSync(String(key) + ':' + String(joinerId).toLowerCase() + ':' + String(hostId).toLowerCase());

/**
 * The joiner's half: what its dial to `hostId` carries, as `metadata.invite`.
 * @param {string} token @param {string} joinerId @param {string} hostId
 * @returns {{v: 1, i: string, p: string} | null}
 */
export function dialInvite(token, joinerId, hostId) {
	if (!isToken(token) || !joinerId || !hostId) return null;
	return { v: 1, i: inviteId(token), p: inviteProof(inviteKey(token), joinerId, hostId) };
}

/**
 * @typedef {{ peerId: string, name: string, at: number, kind: string }} InviteUse
 * @typedef {{ id: string, key: string, kind: 'person'|'agent', role: 'edit'|'view', createdAt: number,
 *   expiresAt: number, maxUses: number, uses: InviteUse[], revoked: boolean, revokedAt?: number }} InviteRecord
 */

/**
 * The host's record for a fresh token.
 * @param {string} token
 * @param {{ kind?: string, role?: string, expiry?: string, maxUses?: number }} opts
 * @param {number} [now]
 * @returns {InviteRecord}
 */
export function makeRecord(token, opts = {}, now = Date.now()) {
	const kind = opts.kind === 'agent' ? 'agent' : 'person';
	// View is preselected for people, Edit for agents (owner, 2026-10-22); the host may pick either
	const role = opts.role === 'edit' || opts.role === 'view' ? opts.role : kind === 'agent' ? 'edit' : 'view';
	const ms = INVITE_EXPIRY[/** @type {keyof typeof INVITE_EXPIRY} */ (opts.expiry ?? DEFAULT_EXPIRY)] ?? INVITE_EXPIRY[DEFAULT_EXPIRY];
	const maxUses = INVITE_USES.includes(Number(opts.maxUses)) ? Number(opts.maxUses) : 1;
	return { id: inviteId(token), key: inviteKey(token), kind, role, createdAt: now, expiresAt: now + ms, maxUses, uses: [], revoked: false };
}

/** @param {InviteRecord} r @param {number} [now] */
export function inviteState(r, now = Date.now()) {
	if (r.revoked) return 'revoked';
	if (now >= r.expiresAt) return 'expired';
	if (r.uses.length >= r.maxUses) return 'used';
	return 'active';
}

/**
 * THE HOST'S CHECK of one incoming dial. `peerId` is the dialer as the signaling server
 * named it (trusted); `meta` is the dial's `invite` metadata (untrusted).
 *   ok:true  — admit with `record.role`; `again` = this peer already used it (a re-dial
 *              after a drop or a reload on the same id), which costs no new use
 *   ok:false — reason: 'none' (no invite on the dial) | 'unknown' | 'revoked' | 'expired' |
 *              'bad-proof' (wrong token, or a proof made for another peer id) | 'used'
 * The order matters: a revoked or expired invite says so even to a peer that used it.
 * @param {InviteRecord[]} records @param {any} meta @param {string} peerId @param {string} hostId
 * @param {number} [now]
 * @returns {{ ok: true, record: InviteRecord, again: boolean } | { ok: false, reason: string, record?: InviteRecord }}
 */
export function checkInvite(records, meta, peerId, hostId, now = Date.now()) {
	const m = meta && typeof meta === 'object' ? meta : null;
	if (!m || m.v !== 1 || typeof m.i !== 'string' || typeof m.p !== 'string') return { ok: false, reason: 'none' };
	const record = (records ?? []).find((r) => r && r.id === m.i);
	if (!record) return { ok: false, reason: 'unknown' };
	if (record.revoked) return { ok: false, reason: 'revoked', record };
	if (now >= record.expiresAt) return { ok: false, reason: 'expired', record };
	if (!sameHex(m.p, inviteProof(record.key, peerId, hostId))) return { ok: false, reason: 'bad-proof', record };
	const id = String(peerId).toLowerCase();
	if (record.uses.some((u) => u.peerId === id)) return { ok: true, record, again: true };
	if (record.uses.length >= record.maxUses) return { ok: false, reason: 'used', record };
	return { ok: true, record, again: false };
}

/**
 * Spend one use (a fresh peer only — `checkInvite` said `again:false`). Returns a NEW record.
 * @param {InviteRecord} r @param {string} peerId @param {{ name?: string, kind?: string }} [who] @param {number} [now]
 * @returns {InviteRecord}
 */
export function spendUse(r, peerId, who = {}, now = Date.now()) {
	const id = String(peerId).toLowerCase();
	if (r.uses.some((u) => u.peerId === id)) return r;
	const name = String(who.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
	const kind = who.kind === 'agent' ? 'agent' : 'person';
	return { ...r, uses: [...r.uses, { peerId: id, name, at: now, kind }] };
}

/** @param {InviteRecord} r @param {number} [now] @returns {InviteRecord} */
export const revokeRecord = (r, now = Date.now()) => (r.revoked ? r : { ...r, revoked: true, revokedAt: now });

/** a used-by name for an earlier use, filled in when the joiner's profile arrives @param {InviteRecord} r @param {string} peerId @param {string} name */
export function nameUse(r, peerId, name) {
	const id = String(peerId).toLowerCase();
	const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
	if (!clean || !r.uses.some((u) => u.peerId === id && u.name !== clean)) return r;
	return { ...r, uses: r.uses.map((u) => (u.peerId === id ? { ...u, name: clean } : u)) };
}

/** drop records nobody needs to see any more (ended more than KEEP_AFTER_MS ago) @param {InviteRecord[]} list @param {number} [now] */
export function pruneRecords(list, now = Date.now()) {
	return (list ?? []).filter((r) => {
		if (!r || typeof r.id !== 'string' || typeof r.key !== 'string') return false;
		const ended = r.revoked ? r.revokedAt ?? r.expiresAt : r.expiresAt;
		return now - ended < KEEP_AFTER_MS;
	});
}

/** "used by Claude (E6F54)" — the label Users and the sheet show for one use @param {InviteUse} u */
export function useLabel(u) {
	const id = String(u.peerId).slice(0, 5).toUpperCase();
	const name = u.name || (u.kind === 'agent' ? 'AI agent' : '');
	return name ? name + ' (' + id + ')' : id;
}

/**
 * The hash grammar (shared with tools/agent `link.js`):
 *   #<peerId>[&agent][&invite=<token>][&<key>[=<value>]…][~srv=<…>]
 * `peerId` is what the existing readers dial; everything after the first `&` up to the
 * `~` tail is a flag/param list. `srv` is left to `parseInviteHash` (peerServer.js).
 * @param {string} rawHash
 * @returns {{ peerId: string, agent: boolean, invite: string | null, params: Record<string, string>, tail: string }}
 */
export function parseHashParams(rawHash) {
	const h = String(rawHash ?? '').replace(/^#/, '');
	const t = h.indexOf('~');
	const head = t < 0 ? h : h.slice(0, t);
	const tail = t < 0 ? '' : h.slice(t);
	const [peerId, ...rest] = head.split('&');
	/** @type {Record<string, string>} */
	const params = {};
	for (const seg of rest) {
		if (!seg) continue;
		const eq = seg.indexOf('=');
		const k = (eq < 0 ? seg : seg.slice(0, eq)).toLowerCase();
		if (k) params[k] = eq < 0 ? '' : seg.slice(eq + 1);
	}
	const invite = isToken(params.invite) ? params.invite : null;
	return { peerId: peerId ?? '', agent: 'agent' in params, invite, params, tail };
}

/**
 * The hash to leave behind once the app has read it: the bare id (+ the `~srv` tail when
 * asked) — never the token. `&agent` stays readable through `bootHash()` instead.
 * @param {string} rawHash @param {{ keepTail?: boolean }} [opt]
 */
export function scrubHash(rawHash, opt = {}) {
	const p = parseHashParams(rawHash);
	if (!p.peerId) return '';
	return '#' + p.peerId + (opt.keepTail ? p.tail : '');
}

/**
 * The link the sheet copies. `origin` is location.origin + pathname; `srvTail` is the
 * `~srv=…` tail the existing Copy-link builds (empty on a default build).
 * @param {string} base @param {string} hostId @param {string} token @param {'person'|'agent'} kind @param {string} [srvTail]
 */
export function inviteLink(base, hostId, token, kind, srvTail = '') {
	return String(base) + '#' + String(hostId).toUpperCase() + (kind === 'agent' ? '&agent' : '') + '&invite=' + token + (srvTail || '');
}

/** the ready MCP command for an agent link (55 F1: `@theprototype/agent`) @param {string} link */
export const mcpCommand = (link) => "claude mcp add theprototype -- npx -y @theprototype/agent mcp '" + link + "'";

/** one sentence for any chat @param {string} link @param {'person'|'agent'} kind */
export const chatSentence = (link, kind) =>
	kind === 'agent' ? 'Join my theprototype session and build with me: ' + link : 'Join my theprototype session: ' + link;
