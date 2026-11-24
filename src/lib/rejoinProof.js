// A RELINK IS PROVEN, NOT CLAIMED. A LEAF (WebCrypto only).
//
// A page that comes back after a reload — a guest to its host, or guests to a host that reloaded —
// links again without a new approval only when both ends show they were in the session together a
// moment ago. The host gives each admitted guest its OWN secret over that guest's open link; a relink
// is then a challenge and an answer on the new link, both ways, before anything else crosses it:
// each side sends a fresh nonce, each answers with a MAC over its role, both ids and the other's nonce.
// A side that cannot answer is a stranger: the host takes the ordinary way in (card, invite, plugin),
// the guest stops and says so. The secret never leaves memory, sessionStorage and the one link it is
// for (no log, toast, URL, diagnostics or trace).

/** bytes of a per-guest secret and of a challenge nonce */
export const SECRET_BYTES = 32;
export const NONCE_BYTES = 16;
/** how long a relink may take to prove itself once its link is open */
export const PROOF_MS = 20000;
/** the message types of the exchange; nothing else crosses a link that has not proven itself */
export const PROOF_TYPES = new Set(['rjc', 'rjp', 'rjs']);
/** the two that are the exchange itself (read at the receive head, before any gate) */
export const EXCHANGE_TYPES = new Set(['rjc', 'rjp']);

const subtle = () => /** @type {SubtleCrypto | undefined} */ (globalThis.crypto?.subtle);

/** @param {Uint8Array} bytes @returns {string} */
export function toB64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s);
}

/** @param {unknown} s @param {number} [len] exact byte length wanted @returns {Uint8Array | null} */
export function fromB64(s, len) {
	if (typeof s !== 'string' || s.length > 128 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
	let bin;
	try {
		bin = atob(s);
	} catch {
		return null;
	}
	if (len !== undefined && bin.length !== len) return null;
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** @param {number} n */
function randomBytes(n) {
	const b = new Uint8Array(n);
	globalThis.crypto.getRandomValues(b);
	return b;
}

/** a fresh per-guest secret, base64 */
export const mintSecret = () => toB64(randomBytes(SECRET_BYTES));
/** a fresh challenge nonce, base64 */
export const mintNonce = () => toB64(randomBytes(NONCE_BYTES));

/** is `s` the shape of a secret we would have minted @param {unknown} s */
export const isSecret = (s) => fromB64(s, SECRET_BYTES) !== null;

/** @param {'host' | 'guest'} role @param {string} ownId @param {string} otherId @param {Uint8Array} nonce */
function transcript(role, ownId, otherId, nonce) {
	const head = new TextEncoder().encode(`tp-rejoin-1\n${role}\n${ownId}\n${otherId}\n`);
	const out = new Uint8Array(head.length + nonce.length);
	out.set(head, 0);
	out.set(nonce, head.length);
	return out;
}

/** @param {string} secret */
async function keyOf(secret) {
	const raw = fromB64(secret, SECRET_BYTES);
	const s = subtle();
	if (!raw || !s) return null;
	return s.importKey('raw', /** @type {BufferSource} */ (raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Our answer to the other side's challenge. @param {string} secret @param {'host' | 'guest'} role OUR role
 * @param {string} ownId @param {string} otherId @param {string} theirNonce @returns {Promise<string | null>}
 */
export async function answerFor(secret, role, ownId, otherId, theirNonce) {
	const nonce = fromB64(theirNonce, NONCE_BYTES);
	if (!nonce) return null;
	try {
		const key = await keyOf(secret);
		const s = subtle();
		if (!key || !s) return null;
		return toB64(new Uint8Array(await s.sign('HMAC', key, transcript(role, ownId, otherId, nonce))));
	} catch {
		return null;
	}
}

/**
 * Does `answer` prove the other side holds `secret` for THIS challenge. Constant time (subtle.verify).
 * @param {string} secret @param {'host' | 'guest'} theirRole @param {string} theirId @param {string} ownId
 * @param {string} myNonce the challenge WE sent @param {unknown} answer @returns {Promise<boolean>}
 */
export async function verifyAnswer(secret, theirRole, theirId, ownId, myNonce, answer) {
	const mac = fromB64(answer, 32);
	const nonce = fromB64(myNonce, NONCE_BYTES);
	if (!mac || !nonce) return false;
	try {
		const key = await keyOf(secret);
		const s = subtle();
		if (!key || !s) return false;
		return await s.verify('HMAC', key, /** @type {BufferSource} */ (mac), transcript(theirRole, theirId, ownId, nonce));
	} catch {
		return false;
	}
}
