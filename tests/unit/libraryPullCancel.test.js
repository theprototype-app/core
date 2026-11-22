// 54i row t (56b-int F11 follow-up): CANCEL STOPS A LIBRARY PULL THAT IS ALREADY IN FLIGHT.
// The real pull path (assetShare: enqueuePull -> getasset -> assetstart / assetchunk / assetfile ->
// landBytes) over a fake transport whose "host" stalls: it answers only when the test feeds it.
// Before the fix `cancelPull` freed the buffers and failed the row, but it never told the sender,
// and a file that started (or a single-shot answer that came) after the cancel opened a fresh
// transfer and landed in the Library anyway.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writable, get } from 'svelte/store';
import { createHash } from 'node:crypto';

/** what landed in the "Library" @type {{name: string, bytes: number}[]} */
const landed = [];

vi.mock('../../src/stores/appStore.js', () => ({ peers: writable(null), showToast: () => {} }));
vi.mock('../../src/lib/explorer.js', () => ({
	explorerFolders: writable([]),
	explorerItems: writable([]),
	itemBlob: async () => null,
	itemByHash: () => null,
	itemById: () => null,
	addItemFromBytes: async (/** @type {ArrayBuffer} */ buf, /** @type {string} */ name) => {
		landed.push({ name, bytes: buf.byteLength });
		return { id: 'x' };
	},
	replaceItemBytes: async () => {},
	hashBytes: async (/** @type {ArrayBuffer} */ buf) => createHash('sha256').update(new Uint8Array(buf)).digest('hex')
}));
vi.mock('../../src/lib/projectManifest.js', () => ({ projectManifest: writable({ items: [] }), isSyntheticId: () => false, itemRowLive: () => true }));
vi.mock('../../src/lib/idb.js', () => ({ idbGet: async () => null, idbPut: async () => {} }));

const { peers } = await import('../../src/stores/appStore.js');
const share = await import('../../src/lib/assetShare.js');
const { transfers } = await import('../../src/lib/transferLedger.js');

/** the host's side of the link: everything we sent it @type {any[]} */
let sentToHost = [];
const HOST = 'host-peer';

/** a file of `chunks` slices, and its content hash @param {number} chunks @param {number} seed */
function file(chunks, seed) {
	const bytes = new Uint8Array(chunks * share.CHUNK_BYTES - 7).map((_, i) => (i * 31 + seed) & 255);
	return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}
/** @param {Uint8Array} bytes @param {number} seq */
const slice = (bytes, seq) => bytes.slice(seq * share.CHUNK_BYTES, (seq + 1) * share.CHUNK_BYTES);
/** @param {{bytes: Uint8Array, hash: string}} f */
const start = (f) => share.applyAssetStart({ hash: f.hash, name: 'big.glb', size: f.bytes.byteLength, chunks: Math.ceil(f.bytes.byteLength / share.CHUNK_BYTES) }, HOST);
/** @param {{bytes: Uint8Array, hash: string}} f @param {number} from */
async function rest(f, from) {
	const n = Math.ceil(f.bytes.byteLength / share.CHUNK_BYTES);
	for (let seq = from; seq < n; seq++) await share.applyAssetChunk({ hash: f.hash, seq, buffer: slice(f.bytes, seq) });
}
const rowFor = (/** @type {string} */ hash) => get(transfers).filter((t) => t.hash === hash && t.dir === 'in');

beforeEach(() => {
	landed.length = 0;
	sentToHost = [];
	peers.set(/** @type {any} */ ({ peer: { id: 'me' }, connections: { [HOST]: { open: true, peer: HOST, send: (/** @type {any} */ m) => sentToHost.push(m) } } }));
});

describe('cancelPull on a library pull already in flight', () => {
	it('control: an uncancelled pull lands once', async () => {
		const f = file(3, 1);
		expect(share.enqueuePull(f.hash)).toBe(true);
		expect(sentToHost.map((m) => m.type)).toEqual(['getasset']);
		start(f);
		await rest(f, 0);
		expect(landed).toHaveLength(1);
	});

	it('mid-transfer: the sender is told to stop, and a restarted send does not land', async () => {
		const f = file(3, 2);
		share.enqueuePull(f.hash);
		start(f);
		await share.applyAssetChunk({ hash: f.hash, seq: 0, buffer: slice(f.bytes, 0) }); // one slice in, then the host stalls
		expect(share.cancelPull(f.hash)).toBe(true);
		expect(rowFor(f.hash).at(-1)?.state).toBe('failed');
		// the host hears the cancel, so it stops streaming the rest into nothing
		expect(sentToHost.filter((m) => m.type === 'volcancel' && m.hash === f.hash)).toHaveLength(1);
		// the stalled sender wakes: the rest of the slices, then a fresh announcement of the whole file
		await rest(f, 1);
		start(f);
		await rest(f, 0);
		expect(landed).toHaveLength(0);
		expect(rowFor(f.hash).every((t) => t.state !== 'done')).toBe(true);
	});

	it('cancelled while the request waits in the sender queue: the late file does not land', async () => {
		const f = file(2, 3);
		share.enqueuePull(f.hash);
		expect(share.cancelPull(f.hash)).toBe(true);
		expect(sentToHost.some((m) => m.type === 'volcancel' && m.hash === f.hash)).toBe(true);
		start(f); // the queue reached our request after the cancel
		await rest(f, 0);
		expect(landed).toHaveLength(0);
	});

	it('a late single-shot answer does not land either', async () => {
		const small = new Uint8Array(4000).map((_, i) => i & 255);
		const hash = createHash('sha256').update(small).digest('hex');
		share.enqueuePull(hash);
		share.cancelPull(hash);
		await share.applyAssetFile({ hash, name: 'small.png', buffer: small.buffer }, HOST);
		expect(landed).toHaveLength(0);
	});

	it('cancelled while the last slice is being checked: nothing lands', async () => {
		const f = file(2, 4);
		share.enqueuePull(f.hash);
		start(f);
		await share.applyAssetChunk({ hash: f.hash, seq: 0, buffer: slice(f.bytes, 0) });
		const last = share.applyAssetChunk({ hash: f.hash, seq: 1, buffer: slice(f.bytes, 1) }); // hashing (async)...
		share.cancelPull(f.hash); // ...when the person presses Cancel
		await last;
		expect(landed).toHaveLength(0);
	});

	it('an explicit retry after a cancel asks again and lands', async () => {
		const f = file(2, 5);
		share.enqueuePull(f.hash);
		share.cancelPull(f.hash);
		expect(share.enqueuePull(f.hash)).toBe(false); // auto-download does not re-ask a cancelled file
		expect(share.retryPull(f.hash)).toBe(true);
		start(f);
		await rest(f, 0);
		expect(landed).toHaveLength(1);
	});
});
