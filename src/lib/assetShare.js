import { get, writable } from 'svelte/store';
import { peers, showToast } from '../stores/appStore';
import { explorerFolders, explorerItems, itemBlob, itemByHash, addItemFromBytes, hashBytes } from './explorer';
import { projectManifest } from './projectManifest';
import { idbGet, idbPut } from './idb';
import {
	beginTransfer,
	activateTransfer,
	progressTransfer,
	finishTransfer,
	failTransfer,
	transfers
} from './transferLedger';

// Shared assets (97): the Explorer library is local, but any file a node USES
// is shared — bytes travel keyed by content hash, PUSHED once on assign and
// PULLED on demand by any peer missing the hash (late joiners, autosave
// restores, session loads). Received files land in the receiver's Explorer
// under a built-in 'Shared' folder so they are visible and reusable.

/**
 * R22-R8: 25 MB, up from 5. The old number existed because ONE message had to hold the
 * whole file; with slices it does not, so the share cap now matches `MAX_ITEM_BYTES` —
 * the Explorer's own import limit — and a file you were allowed to import is a file you
 * are allowed to share. Raising it was not the point of chunking, but it was the most
 * user-visible thing chunking unlocked.
 */
export const MAX_SHARED_BYTES = 25 * 1024 * 1024;

// R22 round 9: `sharedFolderId` is GONE, along with the last thing in the app that could
// create a `Shared` folder. Round 2 narrowed it to "only when the asset has nowhere else
// to go"; round 9 removed the nowhere — see `destinationFor` below.

/**
 * Where should arriving bytes land? The shared index has the answer whenever the file is
 * one somebody shared: its row names a folder, and that folder has already been adopted
 * (folder rows are applied before item rows). Only bytes with NO row fall back.
 *
 * Read through the store rather than importing sharedLibrary: that module imports THIS
 * one, and the row we need is a plain lookup in a document we can already see.
 * @param {string} hash @returns {string | null}
 */
function destinationFor(hash) {
	/** @type {any} */
	const doc = get(projectManifest);
	const row = (doc?.items ?? []).find((/** @type {any} */ r) => r?.hash === hash);
	if (row) {
		const folder = row.folderId
			? get(explorerFolders).find((f) => f.id === row.folderId)
			: null;
		// the row's own folder when we have it, else the library ROOT — never a `Shared`
		// folder, because a shared file has a home the project agrees on
		return folder?.id ?? null;
	}
	// R22 round 9 — THE REPORTED STRAY `Shared` FOLDER, and the second half of its cure.
	//
	// This fallback was the ONLY thing in the app that created that folder, and by round 4
	// it had outlived its reason: every shared file carries placement, cascade publishes
	// the ancestors, so a row's own folder is always resolvable. What still arrives with no
	// row is a SCENE ASSET pushed by `sceneMusic` / `shaderTextures` / `hudImages` /
	// `handModels` / the LUT — bytes the scene needs, pushed on assign and again on the
	// handshake, which is why the folder reappeared around connect time. `markSharedForScene`
	// (below) gives those a row, so this line is now only reached by a hash nothing on the
	// wire describes.
	//
	// It lands at the library ROOT. "Shared" is a meaningful, replicated word in this batch
	// — a share flag, two dot colours, a filter — and a folder wearing it that carries none
	// of that is the kind of thing a user reads as a bug, which is exactly what happened.
	return null;
}

/**
 * R22 round 9: a file whose BYTES we are pushing is part of the project by definition, so
 * it gets an index row. Called from `sendAsset`, which is the one path every scene-asset
 * push goes through (a texture assigned to a shader, the scene's music, a HUD image, a
 * hand model, a colour LUT).
 *
 * Sharing the NAME is strictly less exposure than sharing the bytes, and the bytes have
 * already gone — so this cannot leak anything the push did not. It also makes the receiver
 * able to FILE the arriving file, which is what the stray `Shared` folder was standing in
 * for. An explicit unshare still wins: `markSharedForScene` refuses a record whose `share`
 * is already set either way, so a file somebody deliberately unshared is not re-shared by
 * the scene continuing to reference it.
 *
 * A DYNAMIC import, because sharedLibrary imports THIS module — a static edge would close
 * the cycle (the documented moduleSDK rule).
 * @param {string} hash
 */
async function markSharedForScene(hash) {
	try {
		const item = itemByHash(hash);
		// only a record with NO decision on it: absent = local and never asked about
		if (!item || item.share) return;
		// ...and only a VISIBLE one. `itemByHash` searches the hidden shelf too, where a
		// record is either an old scene version or a file somebody deleted for everyone —
		// and `shareItem` clears the deleted-log entry, so marking one of those would
		// un-delete a file because the scene still happens to reference it.
		if (!get(explorerItems).some((i) => i.id === item.id)) return;
		/** @type {any} */
		const mod = await import('./sharedLibrary');
		mod.shareItem?.(item.id);
	} catch {}
}

/** Push an item's bytes to every peer @param {string} hash */
/**
 * Push an item's bytes to every peer, SLICED (R22-R8) so each one has a progress row.
 *
 * Per CONNECTION rather than one broadcast, which is a real change: `peer.send` fans out
 * internally, and a fan-out cannot be paced against any one channel's buffer or
 * reported as separate transfers. The loop is what makes backpressure and per-peer
 * progress possible at all.
 * @param {string} hash
 */
export async function sendAsset(hash) {
	const item = itemByHash(hash);
	/** @type {any} */
	const peer = get(peers);
	if (!item || !peer) return;
	// give it a row BEFORE the bytes travel, so the receiver can file it (see above)
	await markSharedForScene(hash);
	const blob = await itemBlob(item.id);
	if (!blob) return;
	if (blob.size > MAX_SHARED_BYTES) {
		showToast(item.name + ' is over the ' + Math.round(MAX_SHARED_BYTES / 1048576) + ' MB sharing limit — peers will not receive it');
		return;
	}
	const conns = Object.entries(peer.connections ?? {});
	for (const [peerId, conn] of conns)
		if (/** @type {any} */ (conn)?.open) await sendSliced(conn, item, blob, peerId);
}

/** @type {Set<string>} hashes already asked for (one ask per session) */
const pendingRequests = new Set();

/**
 * Pull missing bytes from the mesh, once per hash.
 *
 * R22 round 12 — IT ONLY COUNTS AS AN ASK IF AN ASK WENT OUT. `pendingRequests` used
 * to be armed BEFORE the queue was consulted, so a call that sent nothing still burned
 * the one-ask-per-session slot and POISONED the hash for the rest of the session. The
 * reachable case is not exotic: applying a shared index while no connection is open
 * (an idb-restored manifest at boot, a .tp open, a document that arrived and was
 * applied before the mesh settled) runs `autoPullMissing` over every remote row with
 * zero open peers — after which the connect-edge sweep, the index-arrival sweep and
 * the user's own Download button all early-returned on `pendingRequests.has(hash)`
 * and the file could never be fetched again without a reload.
 *
 * The invariant is now: a hash is in `pendingRequests` IFF a request left this machine
 * and has not resolved — which is what every deleter of that set already assumes
 * (applyAssetFile, chunk completion, applyAssetMissing, the stall sweep, reviveHash).
 * @param {string} hash @returns {boolean} did a request actually leave
 */
export function requestAsset(hash) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer || !hash || pendingRequests.has(hash) || itemByHash(hash)) return false;
	// R22-R8: through the QUEUE, not straight onto the wire. Auto-download can name two
	// hundred hashes at once (a shared folder), and two hundred simultaneous requests is
	// how you make every one of them slow.
	const sent = enqueuePull(hash);
	if (sent) pendingRequests.add(hash);
	return sent;
}

/** Receive pushed bytes -> Shared folder (content-hash dedup) @param {any} data */
export async function applyAssetFile(data) {
	if (!data?.hash || !data?.buffer) return;
	pendingRequests.delete(data.hash);
	if (itemByHash(data.hash)) return;
	// binarypack may deliver a typed-array VIEW into a larger buffer — slice
	// the exact bytes or the content hash comes out wrong
	const raw = data.buffer;
	const buffer =
		raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	// R22-R8: the single-shot path still gets a ledger row, so a small file and an older
	// peer's whole-file answer both appear in the log rather than arriving invisibly
	// ...and the same on the single-shot path, for the same reason
	const tx =
		pullsInFlight.get(data.hash)?.tx ??
		beginTransfer({
			hash: data.hash,
			name: data.name ?? 'shared-asset',
			dir: 'in',
			size: buffer.byteLength
		});
	activateTransfer(tx, buffer.byteLength);
	await addItemFromBytes(buffer, data.name ?? 'shared-asset', destinationFor(data.hash));
	finishTransfer(tx);
	settlePull(data.hash);
}

/**
 * Answer a peer's pull. Replies over OUR stable outgoing connection to that
 * peer (the incoming conn a request arrives on can be a stale duplicate from
 * the connect dance — sendAnnotations pattern).
 * @param {string} peerId @param {any} data
 */
export async function answerAssetRequest(peerId, data) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn?.open) return;
	const item = itemByHash(data?.hash);
	const blob = item ? await itemBlob(item.id) : null;
	// R22-R8 (round 4): SAY NO. Silence used to be the only answer for a hash we do not
	// hold, so the asker had to discover it with a timer — and could not tell "nobody
	// has this" from "the one peer who has it is slow". One tiny message removes the
	// guess entirely.
	if (!blob || blob.size > MAX_SHARED_BYTES) {
		conn.send({ type: 'assetmissing', hash: String(data?.hash ?? '') });
		return;
	}
	// ...and QUEUE the send: the cap belongs on outgoing bytes, which is the only
	// scarce thing here, rather than on the asker's questions
	sendQueue.push({ conn, item, blob, peerId });
	pumpSendQueue();
}

// ---- R22 round 2: THUMBNAILS TRAVEL --------------------------------------------
//
// THE REPORT: a shared file shows an icon until you download it, and only then grows a
// picture. Which is exactly what the code did — a thumbnail is DERIVED from the bytes by
// `writeItemNow`, and a peer that has no bytes has nothing to derive it from.
//
// Two ways to fix it and only one of them is cheap. Putting the thumbnail ON THE INDEX
// ROW would bloat a document that re-replicates in full on every share toggle: measured
// 2-6 KB per 128px webp dataURL, so a fifty-file library would put a quarter of a
// megabyte on the wire every time somebody pressed Share. That is the same reasoning
// `shaderTextures` used to refuse an embedded dataURL for a graph texture.
//
// So thumbnails ride their own tiny channel, addressed by the same content hash as the
// bytes: ONE new message type (`assetthumb`) plus an additive `thumb` flag on the
// existing `getasset`, which an older peer simply answers with the whole file — a
// correct, merely wasteful, degradation.
//
// The cache is LOCAL and idb-backed: a thumbnail is a derived picture, never project
// data, and re-deriving it after a reload would need bytes this peer does not have.

const THUMB_KEY = 'explorer:thumbs';
/** how many remote thumbnails to keep. A bound, not a policy — each is a few KB, and the
 * oldest are dropped first, which is right because the newest are what is on screen. */
const THUMB_CAP = 500;

/** hash -> dataURL, for files we do NOT hold. @type {import('svelte/store').Writable<Record<string, string>>} */
export const sharedThumbs = writable({});

let thumbsLoaded = false;
/** Load the cache once. Idempotent. */
export async function loadSharedThumbs() {
	if (thumbsLoaded || typeof indexedDB === 'undefined') return;
	thumbsLoaded = true;
	try {
		const stored = await idbGet(THUMB_KEY);
		if (stored && typeof stored === 'object') sharedThumbs.set(stored);
	} catch {}
}

let thumbSaveTimer = /** @type {any} */ (null);
function persistThumbs() {
	// debounced: a burst of arriving thumbnails is one write, not one write each
	clearTimeout(thumbSaveTimer);
	thumbSaveTimer = setTimeout(() => {
		try {
			void idbPut(THUMB_KEY, get(sharedThumbs));
		} catch {}
	}, 400);
}

/** @type {Set<string>} hashes whose thumbnail we have already asked for (one ask per session) */
const thumbAsked = new Set();

/**
 * Ask the mesh for the PICTURE of a hash, not the file. Safe to call per render — the
 * guard is the same one-ask-per-session rule `requestAsset` uses, so a grid of fifty
 * remote cards produces fifty requests once and none afterwards.
 * @param {string} hash
 */
export function requestAssetThumb(hash) {
	const h = String(hash ?? '').trim();
	if (!h || thumbAsked.has(h)) return;
	if (get(sharedThumbs)[h] || itemByHash(h)) return; // have the picture, or the file
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	thumbAsked.add(h);
	// `thumb` is ADDITIVE on the existing request: a peer on an older build ignores it
	// and answers with the whole file, which is wasteful and not wrong
	peer.send({ type: 'getasset', hash: h, thumb: true });
}

/**
 * Push the picture of an item we hold to every peer. Called when a file is SHARED, so a
 * peer's card has something to show before anybody asks — the push half of golden rule
 * 9, one payload size down.
 * @param {string} hash
 */
export function sendAssetThumb(hash) {
	const item = itemByHash(hash);
	/** @type {any} */
	const peer = get(peers);
	if (!item?.thumbnail || !peer) return;
	peer.send({ type: 'assetthumb', hash: item.hash, thumb: item.thumbnail });
}

/** Receive one. @param {any} data */
export function applyAssetThumb(data) {
	const hash = String(data?.hash ?? '').trim();
	const thumb = String(data?.thumb ?? '');
	// a dataURL and nothing else: this string goes straight into an <img src>, so anything
	// that is not an inline image is refused rather than rendered
	if (!hash || !thumb.startsWith('data:image/')) return;
	if (thumb.length > 200000) return; // a 128px webp is a few KB; this is not one
	sharedThumbs.update((map) => {
		if (map[hash] === thumb) return map;
		const next = { ...map, [hash]: thumb };
		const keys = Object.keys(next);
		if (keys.length > THUMB_CAP) for (const k of keys.slice(0, keys.length - THUMB_CAP)) delete next[k];
		return next;
	});
	persistThumbs();
}

/**
 * Answer a peer's thumbnail request over our stable outgoing connection (the
 * answerAssetRequest rule, verbatim — an incoming conn can be a stale duplicate).
 * @param {string} peerId @param {any} data
 */
export function answerAssetThumbRequest(peerId, data) {
	const item = itemByHash(data?.hash);
	if (!item?.thumbnail) return; // no picture to give; another peer may have one
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn?.open) return;
	conn.send({ type: 'assetthumb', hash: item.hash, thumb: item.thumbnail });
}

/** Drop the cached picture for a hash we now hold the FILE for — the real item's own
 * thumbnail is better (it is the one this machine rendered) and keeping both means two
 * sources of truth for one card. @param {string} hash */
export function forgetSharedThumb(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return;
	sharedThumbs.update((map) => {
		if (!(h in map)) return map;
		const next = { ...map };
		delete next[h];
		return next;
	});
	persistThumbs();
}

// ---- R22-R8: CHUNKED TRANSFER, and why it is worth its own protocol -------------
//
// THE MEASUREMENT FIRST, because this project has a standing rule about building a
// protocol for a phantom: peerjs ALREADY chunks binary internally, and a single 12 MB
// message has been measured going through intact. So chunking buys nothing for
// THROUGHPUT. What it buys is three things one message cannot:
//
//   1. PROGRESS. peerjs's own chunking is invisible to us — no byte counts, no events —
//      so a per-file bar is impossible without slicing the file ourselves. That is the
//      whole reason this exists.
//   2. INTEGRITY. Reassembly ends with a hash check against the hash we asked for, which
//      the single-shot path never did. A truncated or crossed transfer is now caught
//      rather than stored.
//   3. THE 5 MB CAP. `MAX_SHARED_BYTES` existed because one message had to hold the whole
//      file. With slices it does not, so the share cap now matches the Explorer's own
//      import cap and a 20 MB model can finally be shared.
//
// THE COST, honestly: three correctness surfaces that a single send did not have.
//   · BACKPRESSURE. Twenty sends in a tight loop can outrun the DataChannel's buffer, so
//     `pace()` waits on `bufferedAmount` before each slice.
//   · PARTIAL STATE. A sender that leaves mid-file strands buffers, so an incoming
//     transfer with no slice for STALL_MS is abandoned and freed.
//   · ORDERING. A DataConnection is ordered, but the applier is written not to care: a
//     slice is filed by its own `seq`, and completion is "every index present".
//
// AN OLDER PEER is unaffected in both directions. It answers `getasset` with a whole
// `assetfile`, which we still accept; and it ignores `assetstart`/`assetchunk`, so it
// simply never receives a chunked file rather than receiving a broken one. That is a
// degradation, and it is the one golden rule 4 already licenses (peers assume the same
// app version).

/** slice size. 256 KB is comfortably inside a DataChannel message limit while keeping the
 * slice COUNT low enough that per-slice overhead stays noise (a 20 MB file is 80 sends). */
export const CHUNK_BYTES = 256 * 1024;
/** below this, one message is simply cheaper than announcing a transfer */
const SINGLE_SHOT_BYTES = 192 * 1024;
/** an incoming transfer with no slice for this long is abandoned */
const STALL_MS = 20000;
/**
 * ...but a request NOBODY ANSWERED is a different thing, and it needs a much shorter
 * fuse. A pull holds one of `MAX_CONCURRENT_PULLS` slots from the moment it is sent, so
 * three dead hashes — a file whose only holder left, a hash from a peer that cleared its
 * library — starve every real download behind them for the whole stall window. Measured
 * as exactly that: three unanswerable pulls and the next file never moved.
 */
const REQUEST_MS = 6000;
/**
 * A hash nobody answered, and when we gave up on it. Without this, auto-download
 * re-queues a dead hash on every single index change — which is a retry loop that never
 * ends and permanently occupies the queue it is starving.
 * @type {Map<string, number>} */
const deadHashes = new Map();
/** how long a dead hash stays dead. Long enough to stop a loop, short enough that a peer
 * who arrives WITH the file is not locked out for the session. */
const DEAD_MS = 45000;
/** keep the DataChannel buffer under this before queueing another slice */
const BUFFER_HIGH = 4 * 1024 * 1024;

/**
 * R22-R8 (round 4) — TWO CAPS, BECAUSE THERE ARE TWO SCARCE THINGS, and conflating them
 * is what caused the starvation bug.
 *
 * A REQUEST is about forty bytes. Capping requests to limit bandwidth was always aiming
 * at the wrong object: it meant a hash nobody could answer occupied one of three slots
 * until a timer expired, so three dead hashes stopped every real download behind them.
 * Requests are now unlimited — asking two hundred questions at once costs 8 KB.
 *
 * What is actually scarce is a SENDER's outgoing bandwidth, so the cap moved to where
 * the bytes are: `answerAssetRequest` queues, and at most SEND_CONCURRENCY files stream
 * at a time. That is also the only place it can work — a receiver cannot cap what a
 * sender chooses to push at it.
 */
const SEND_CONCURRENCY = 3;

/** hash -> reassembly state @type {Map<string, {name: string, size: number, chunks: number,
 *  parts: (Uint8Array|null)[], have: number, bytes: number, tx: string, at: number}>} */
const incoming = new Map();

/**
 * Hashes we have asked for and not yet resolved. `waiting` is the set of peers that have
 * neither sent the file nor said they lack it — when it EMPTIES, every peer has answered
 * "no" and the pull is dead in milliseconds rather than on a six-second guess.
 * @type {Map<string, {tx: string, waiting: Set<string>}>} */
const pullsInFlight = new Map();

/** outgoing sends waiting for a slot @type {{conn: any, item: any, blob: Blob, peerId: string}[]} */
let sendQueue = [];
/** how many `sendSliced` calls are running right now */
let sending = 0;

/** Wait for the send buffer to drain enough. Resolves immediately when the channel does
 * not expose one (a stubbed conn in a test, a future transport).
 * @param {any} conn */
async function pace(conn) {
	const ch = conn?.dataChannel;
	if (!ch || typeof ch.bufferedAmount !== 'number') return;
	for (let i = 0; i < 600 && ch.bufferedAmount > BUFFER_HIGH; i++)
		await new Promise((r) => setTimeout(r, 25));
}

/**
 * Send one file over `conn`, sliced, with a ledger row tracking it. The single-shot path
 * survives for small files: announcing a transfer that completes in one message is pure
 * ceremony, and the receiver's `assetfile` handler already reports it.
 * @param {any} conn @param {any} item @param {Blob} blob @param {string} peerId
 */
async function sendSliced(conn, item, blob, peerId) {
	const size = blob.size;
	const tx = beginTransfer({ hash: item.hash, name: item.name, dir: 'out', size, peer: peerId });
	try {
		if (size <= SINGLE_SHOT_BYTES) {
			activateTransfer(tx, size);
			conn.send({ type: 'assetfile', hash: item.hash, name: item.name, buffer: await blob.arrayBuffer() });
			finishTransfer(tx);
			return;
		}
		const chunks = Math.ceil(size / CHUNK_BYTES);
		conn.send({ type: 'assetstart', hash: item.hash, name: item.name, size, chunks });
		activateTransfer(tx, size);
		let sent = 0;
		for (let seq = 0; seq < chunks; seq++) {
			if (!conn.open) throw new Error('connection closed');
			await pace(conn);
			const slice = blob.slice(seq * CHUNK_BYTES, Math.min(size, (seq + 1) * CHUNK_BYTES));
			const bytes = await slice.arrayBuffer();
			conn.send({ type: 'assetchunk', hash: item.hash, seq, buffer: bytes });
			sent += slice.size;
			progressTransfer(tx, sent, size);
		}
		finishTransfer(tx);
	} catch (e) {
		failTransfer(tx, /** @type {any} */ (e)?.message ?? 'send failed');
	}
}

/** Receive an announcement: open the reassembly buffer and the ledger row. @param {any} data */
export function applyAssetStart(data) {
	const hash = String(data?.hash ?? '').trim();
	const chunks = Number(data?.chunks) || 0;
	const size = Number(data?.size) || 0;
	if (!hash || chunks <= 0 || size <= 0) return;
	if (itemByHash(hash)) return; // already here; the sender is behind, not wrong
	if (size > MAX_SHARED_BYTES) return;
	const name = String(data?.name ?? 'shared-asset');
	const held = incoming.get(hash);
	if (held) {
		// a second announcement for a transfer already running: the first sender may have
		// stalled, so take the newer one rather than interleaving two sets of slices
		failTransfer(held.tx, 'restarted by the sender');
	}
	// REUSE THE PULL'S ROW. A pull and the transfer that answers it are ONE thing to a
	// person watching a progress bar, and opening a second row left the first stuck at
	// 'queued' forever — which is why two shared files reported "2 files, 50%" with both
	// already downloaded. A row is only minted here for an UNSOLICITED push.
	const tx = pullsInFlight.get(hash)?.tx ?? beginTransfer({ hash, name, dir: 'in', size });
	incoming.set(hash, {
		name,
		size,
		chunks,
		parts: new Array(chunks).fill(null),
		have: 0,
		bytes: 0,
		tx,
		at: Date.now()
	});
	activateTransfer(tx, size);
}

/** Receive one slice; on the last one, verify and store. @param {any} data */
export async function applyAssetChunk(data) {
	const hash = String(data?.hash ?? '').trim();
	const seq = Number(data?.seq);
	const state = hash ? incoming.get(hash) : null;
	if (!state || !Number.isInteger(seq) || seq < 0 || seq >= state.chunks) return;
	if (state.parts[seq]) return; // a duplicate slice is not progress
	const raw = data.buffer;
	if (!raw) return;
	// binarypack delivers a VIEW into a larger buffer — slice the exact bytes or the
	// reassembled hash will not be the hash we asked for (the documented assetShare rule)
	const view =
		raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	state.parts[seq] = view;
	state.have++;
	state.bytes += view.byteLength;
	state.at = Date.now();
	progressTransfer(state.tx, state.bytes, state.size);
	if (state.have < state.chunks) return;

	incoming.delete(hash);
	const whole = new Uint8Array(state.bytes);
	let at = 0;
	for (const part of state.parts) {
		if (!part) return failTransfer(state.tx, 'a slice was missing');
		whole.set(part, at);
		at += part.byteLength;
	}
	// INTEGRITY, which the single-shot path never had: the bytes must hash to the hash we
	// were promised, or this is not the file and storing it would poison every peer that
	// later pulls it from us
	const digest = await hashBytes(whole.buffer);
	if (digest !== hash) {
		failTransfer(state.tx, 'content hash did not match');
		return;
	}
	pendingRequests.delete(hash);
	deadHashes.delete(hash);
	unavailableHashes.update((u) => {
		if (!u.has(hash)) return u;
		const next = new Set(u);
		next.delete(hash);
		return next;
	});
	await addItemFromBytes(whole.buffer, state.name, destinationFor(hash));
	finishTransfer(state.tx);
	settlePull(hash);
}

/** Abandon transfers that have gone quiet, freeing their buffers. */
export function sweepStalledTransfers() {
	const now = Date.now();
	for (const [hash, state] of [...incoming])
		if (now - state.at > STALL_MS) {
			incoming.delete(hash);
			failTransfer(state.tx, 'the sender went quiet');
			pendingRequests.delete(hash);
			settlePull(hash);
		}
	for (const [hash, state] of [...pullsInFlight]) {
		const tx = state.tx;
		const row = get(transfers).find((t) => t.id === tx);
		// 'queued' means the request went out and not one byte came back, so REQUEST_MS
		// applies; a row that reached 'active' is mid-transfer and gets the stall window
		if (row && row.state === 'queued' && now - row.at > REQUEST_MS) {
			failTransfer(tx, 'nobody answered');
			pendingRequests.delete(hash);
			deadHashes.set(hash, now);
			markUnavailable(hash);
			settlePull(hash);
		}
	}
	for (const [hash, at] of [...deadHashes]) if (now - at > DEAD_MS) deadHashes.delete(hash);
}

/** One pull resolved (or died). @param {string} hash */
function settlePull(hash) {
	const state = pullsInFlight.get(hash);
	pullsInFlight.delete(hash);
	// belt and braces: if the row somehow survived (a path that stored the bytes without
	// going through finishTransfer), close it here rather than leaving the summary
	// permanently one file short of done
	if (state) {
		const row = get(transfers).find((t) => t.id === state.tx);
		if (row && (row.state === 'queued' || row.state === 'active')) finishTransfer(state.tx);
	}
}

/**
 * Ask every open peer for one hash. No cap: see SEND_CONCURRENCY.
 *
 * R22 round 12: it REPORTS whether anything left. The ledger row is minted below the
 * open-connection check on purpose — a row for a request that was never sent is a
 * spinner nobody can resolve — and the same rule now travels back up to the callers,
 * so `pendingRequests` and the Explorer's pending-pull marks cannot arm either.
 * @param {string} hash @returns {boolean} did a request actually leave
 */
function askFor(hash) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer || pullsInFlight.has(hash) || itemByHash(hash)) return false;
	const open = Object.entries(peer.connections ?? {}).filter(
		([, c]) => /** @type {any} */ (c)?.open
	);
	if (!open.length) return false;
	const row = sharedRowFor(hash);
	const tx = beginTransfer({
		hash,
		name: row?.name ?? hash,
		dir: 'in',
		size: Number(row?.size) || 0
	});
	pullsInFlight.set(hash, { tx, waiting: new Set(open.map(([id]) => id)) });
	for (const [, conn] of open) /** @type {any} */ (conn).send({ type: 'getasset', hash });
	return true;
}

/**
 * A peer says it does not hold a hash. When the LAST one says so the pull is over, and
 * we know it rather than waiting to find out — which is the difference between a file
 * that is genuinely gone and one whose only holder is slow.
 * @param {string} peerId @param {any} data
 */
export function applyAssetMissing(peerId, data) {
	const hash = String(data?.hash ?? '').trim();
	const state = hash ? pullsInFlight.get(hash) : null;
	if (!state) return;
	state.waiting.delete(String(peerId));
	if (state.waiting.size) return; // somebody may still answer
	failTransfer(state.tx, 'no peer has this file');
	pendingRequests.delete(hash);
	deadHashes.set(hash, Date.now());
	markUnavailable(hash);
	settlePull(hash);
}

/**
 * R22 round 5 — WHAT IF THE ONLY PEER WHO HAD IT LEFT?
 *
 * The real answer is REDUNDANCY, and it already ships: auto-download is on by default,
 * so every peer holds every shared file and one leaving costs nothing. This is the
 * fallback for when it does not hold — a manual-download session, or a peer that left
 * before anybody fetched.
 *
 * There is nothing clever to do: nobody has the bytes. What the app CAN do is stop
 * pretending. An unavailable hash is recorded so the card can say so instead of looking
 * like a download that never finishes, and the mark is cleared whenever a NEW PEER
 * ARRIVES — they may be carrying it, and a session that never retries would keep telling
 * you a file is gone while the person holding it sits in the room.
 * @type {import('svelte/store').Writable<Set<string>>} */
export const unavailableHashes = writable(new Set());

/** @param {string} hash */
function markUnavailable(hash) {
	unavailableHashes.update((s) => (s.has(hash) ? s : new Set([...s, hash])));
}

/**
 * A peer joined (or rejoined). Everything we had given up on is worth one more ask —
 * this is the ONLY automatic retry, and it is triggered by new evidence rather than by a
 * timer, which is the difference between a retry and a loop.
 */
export function retryUnavailable() {
	const dead = [...get(unavailableHashes)];
	if (!dead.length) return 0;
	unavailableHashes.set(new Set());
	for (const hash of dead) {
		deadHashes.delete(hash);
		pendingRequests.delete(hash);
	}
	return dead.length;
}

/** Run queued sends up to the cap. @returns {void} */
function pumpSendQueue() {
	while (sending < SEND_CONCURRENCY && sendQueue.length) {
		const job = /** @type {any} */ (sendQueue.shift());
		sending++;
		void sendSliced(job.conn, job.item, job.blob, job.peerId).finally(() => {
			sending--;
			pumpSendQueue();
		});
	}
}

/** The index row for a hash, for a name and a size to show before anything arrives.
 * @param {string} hash */
function sharedRowFor(hash) {
	/** @type {any} */
	const doc = get(projectManifest);
	return (doc?.items ?? []).find((/** @type {any} */ r) => r?.hash === hash) ?? null;
}

/** Queue a pull. Replaces the bare send in `requestAsset` so a folder share cannot turn
 * into two hundred simultaneous requests. R22 round 12: the verdict is askFor's, not a
 * bare `true` — reaching the ask is not the same as sending one, and the difference is
 * exactly the no-open-connections case the callers must not record.
 * @param {string} hash @returns {boolean} did a request actually leave */
export function enqueuePull(hash) {
	const h = String(hash ?? '').trim();
	if (!h || itemByHash(h) || pullsInFlight.has(h)) return false;
	// a hash we recently gave up on stays out of the queue, or auto-download re-queues it
	// on every index change and the loop occupies the slot it is starving
	if (deadHashes.has(h)) return false;
	return askFor(h);
}

/** Forget that a hash was unanswerable — an explicit user request means try again
 * whatever happened last time. @param {string} hash */
export function reviveHash(hash) {
	deadHashes.delete(String(hash ?? '').trim());
	pendingRequests.delete(String(hash ?? '').trim());
}

/**
 * R22 round 6 — RETRY ONE FAILED PULL. The user pressed it, so every reason we had for
 * giving up is void: the dead-hash mark, the one-ask-per-session guard and the
 * unavailable flag all lift together. Anything less and the button would do nothing,
 * which is the failure mode a retry button exists to avoid.
 * @param {string} hash @returns {boolean} was a fresh ask sent
 */
export function retryPull(hash) {
	const h = String(hash ?? '').trim();
	if (!h || itemByHash(h)) return false;
	deadHashes.delete(h);
	pendingRequests.delete(h);
	unavailableHashes.update((u) => {
		if (!u.has(h)) return u;
		const next = new Set(u);
		next.delete(h);
		return next;
	});
	pullsInFlight.delete(h);
	askFor(h);
	return pullsInFlight.has(h);
}

/**
 * Stop waiting for one. INCOMING only, and deliberately: an outgoing stream is somebody
 * else's download, and cancelling it from this side would leave them with a file that
 * simply stops — a failure they cannot act on and did not ask for. A queued OUTGOING
 * send has not started, so that one can go.
 * @param {string} hash @returns {boolean}
 */
export function cancelPull(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return false;
	let stopped = false;
	// mid-reassembly: free the buffers
	const partial = incoming.get(h);
	if (partial) {
		incoming.delete(h);
		failTransfer(partial.tx, 'cancelled');
		stopped = true;
	}
	const waiting = pullsInFlight.get(h);
	if (waiting) {
		failTransfer(waiting.tx, 'cancelled');
		stopped = true;
	}
	pendingRequests.delete(h);
	settlePull(h);
	// a cancel is a decision, so it also stops auto-download re-asking on the next index
	// change — otherwise the file would come straight back and the button would read as
	// broken. An explicit retry lifts it.
	deadHashes.set(h, Date.now());
	// ...and drop it from the outgoing queue if we had not started sending yet
	const before = sendQueue.length;
	sendQueue = sendQueue.filter((j) => j.item?.hash !== h);
	if (sendQueue.length !== before) stopped = true;
	return stopped;
}

/** How many pulls are outstanding — the popover's "files left". */
export function pullBacklog() {
	return pullsInFlight.size;
}
