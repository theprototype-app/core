// The data-channel codec every PeerJS link of this app uses (registered through the Peer's public
// `serializers` option in peerHandler).
//
// It reads and writes the SAME wire format as PeerJS 1.5's own binary connection, so a peer on an older
// build reads what this one sends and this one reads what an older build sends, byte for byte. What it
// adds is limits on the RECEIVE side:
//   * a frame has a size cap, and every length it states is checked against the bytes that actually
//     arrived, so a count can never make the decoder do more work than the frame has bytes; the objects
//     one message may create are counted against a budget (a one-byte value can be a whole JS object);
//     nesting has a depth limit; map keys are strings (all a sender ever writes), never `__proto__`
//   * a message sent in pieces is joined only within fixed limits: a piece is real bytes of bounded size,
//     its index and count are checked, a bounded number of messages and bytes may be in flight per link
//     (pieces of several messages can interleave: the app's links are reliable but UNORDERED, PeerJS's
//     default), a joined message has a total size cap and is never itself a piece
//   * only the first data channel of a link is used; another one the far side announces is closed
//   * whatever codec name a dial asks for, the link uses this codec
// A frame that breaks a rule is dropped and reported through `setFrameRefusalHandler`; the link stays up.
//
// A LEAF: imports only peerjs.
import * as peerjs from 'peerjs';

// The browser build gets peerjs's ES module; the server-side prerender loads its CommonJS build, whose named
// exports Node cannot see (they are getters on module.exports), so both shapes are read here. Plain member
// reads on the namespace, so the bundler can still leave peerjs's unused exports out.
/** @type {typeof import('peerjs').BufferedConnection} */
const BufferedConnection = peerjs.BufferedConnection ?? /** @type {any} */ (peerjs.default)?.BufferedConnection;
/** @type {typeof import('peerjs').util} */
const util = peerjs.util ?? /** @type {any} */ (peerjs.default)?.util;

/** the piece size PeerJS 1.5 sends with (its chunkedMTU) */
export const PIECE_BYTES = 16300;

export const FRAME_LIMITS = {
	/** largest single frame: a sender splits anything over PIECE_BYTES, so a real frame is ~16 KB */
	frameBytes: 1024 * 1024,
	/** largest piece accepted (a sender on another PeerJS 1.x version may use a different piece size) */
	pieceBytes: 64 * 1024,
	/** largest message joined from pieces: above the app's biggest messages (a 50 MB session, the 64 MB
	 * object cap of wireBudget) */
	messageBytes: 96 * 1024 * 1024,
	/** pieces in one message: messageBytes in PeerJS's piece size, rounded up */
	pieces: 8192,
	/** messages being joined at once per link (pieces can interleave on an unordered link) */
	partials: 64,
	/** bytes held for messages being joined, all messages of one link together */
	heldBytes: 96 * 1024 * 1024,
	/** objects one decoded message may create (maps, arrays, non-empty strings, a map key only the first
	 * time it appears; a binary value counts 2). Measured worst case at the cap: ~430 MB held and ~1.5 s
	 * for a 96 MB message built of empty values. A scene object is at most 200,000 nodes (loadGuard's
	 * MAX_NODES) at a handful of objects each. */
	objects: 3_000_000,
	/** nesting depth of one decoded value */
	depth: 512
};

/** @type {(peerId: string, reason: string) => void} */
let refuse = () => {};
/** Who hears about a dropped frame (peerHandler counts it in wireErrors). @param {(peerId: string, reason: string) => void} fn */
export function setFrameRefusalHandler(fn) {
	refuse = typeof fn === 'function' ? fn : () => {};
}

class FrameError extends Error {
	/** @param {string} reason */
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
}

/**
 * Decode one frame of the PeerJS binary format. Throws a FrameError when a stated length runs past the
 * bytes there are, when the message would create too many objects, when nesting is too deep, or when a map
 * key is not a plain string. Binary values come back as ArrayBuffers for an ArrayBuffer input and as
 * Uint8Arrays for a Uint8Array input — what PeerJS gives for a single frame and for a joined message.
 * @param {ArrayBuffer | Uint8Array} input @param {{depth?: number, objects?: number}} [limits]
 */
export function decodeFrame(input, limits = {}) {
	const joined = input instanceof Uint8Array;
	if (!joined && !(input instanceof ArrayBuffer)) throw new FrameError('not-bytes');
	const maxDepth = limits.depth ?? FRAME_LIMITS.depth;
	let objects = limits.objects ?? FRAME_LIMITS.objects;
	const view = joined ? input : new Uint8Array(input);
	/** @type {Map<string, string>} */
	const keys = new Map();
	const length = view.length;
	let index = 0;
	/** @param {number} cost */
	const spend = (cost) => {
		objects -= cost;
		if (objects < 0) throw new FrameError('objects');
	};

	/** @param {number} n */
	const need = (n) => {
		if (!(n >= 0) || index + n > length) throw new FrameError('short');
	};
	const u8 = () => {
		need(1);
		return view[index++];
	};
	const u16 = () => {
		need(2);
		const v = view[index] * 256 + view[index + 1];
		index += 2;
		return v;
	};
	const u32 = () => {
		need(4);
		const v = ((view[index] * 256 + view[index + 1]) * 256 + view[index + 2]) * 256 + view[index + 3];
		index += 4;
		return v;
	};
	const u64 = () => {
		need(8);
		let v = 0;
		for (let i = 0; i < 8; i++) v = v * 256 + view[index + i];
		index += 8;
		return v;
	};
	/** @param {number} size */
	const raw = (size) => {
		need(size);
		spend(2);
		const out = joined ? view.slice(index, index + size) : /** @type {ArrayBuffer} */ (input).slice(index, index + size);
		index += size;
		return out;
	};
	/** the PeerJS decoder's own string rules, kept as they are so a string reads the same as before; built
	 * from chunks rather than one code point at a time (that makes a rope with a node per character)
	 * @param {number} size */
	const str = (size) => {
		need(size);
		if (size === 0) return '';
		spend(1);
		const end = index + size;
		const at = (/** @type {number} */ i) => (i < end ? view[i] : 0);
		let i = index;
		/** @type {string[]} */
		const parts = [];
		/** @type {number[]} */
		let codes = [];
		while (i < end) {
			const c = view[i];
			let code;
			if (c < 0xa0) {
				code = c;
				i++;
			} else if ((c ^ 0xc0) < 0x20) {
				code = ((c & 0x1f) << 6) | (at(i + 1) & 0x3f);
				i += 2;
			} else if ((c ^ 0xe0) < 0x10) {
				code = ((c & 0x0f) << 12) | ((at(i + 1) & 0x3f) << 6) | (at(i + 2) & 0x3f);
				i += 3;
			} else {
				code = ((c & 0x07) << 18) | ((at(i + 1) & 0x3f) << 12) | ((at(i + 2) & 0x3f) << 6) | (at(i + 3) & 0x3f);
				i += 4;
			}
			if (code > 0x10ffff) throw new FrameError('string');
			codes.push(code);
			if (codes.length === 4096) {
				parts.push(String.fromCodePoint(...codes));
				codes = [];
			}
		}
		if (codes.length) parts.push(String.fromCodePoint(...codes));
		index = end;
		return parts.length === 1 ? parts[0] : parts.join('');
	};
	/** @param {number} size @param {number} depth */
	const array = (size, depth) => {
		// every element takes at least one byte
		if (size > length - index) throw new FrameError('count');
		spend(1);
		const out = new Array(size);
		for (let i = 0; i < size; i++) out[i] = value(depth);
		return out;
	};
	/** @param {number} size @param {number} depth */
	const map = (size, depth) => {
		// every entry takes at least two bytes (a key and a value)
		if (size * 2 > length - index) throw new FrameError('count');
		spend(1);
		/** @type {Record<string, any>} */
		const out = {};
		for (let i = 0; i < size; i++) {
			let key = value(depth);
			if (typeof key !== 'string' || key === '__proto__') throw new FrameError('key');
			// a key seen before in this message is shared, not kept twice, and costs nothing: a scene's
			// thousands of objects repeat the same few dozen keys
			const seen = keys.get(key);
			if (seen !== undefined) {
				key = seen;
				if (key !== '') objects += 1;
			} else if (keys.size < 4096) keys.set(key, key);
			out[key] = value(depth);
		}
		return out;
	};
	const f32 = () => {
		const v = u32();
		const sign = v >> 31;
		const exp = ((v >> 23) & 0xff) - 127;
		const fraction = (v & 0x7fffff) | 0x800000;
		return (sign === 0 ? 1 : -1) * fraction * 2 ** (exp - 23);
	};
	const f64 = () => {
		const h = u32();
		const l = u32();
		const sign = h >> 31;
		const exp = ((h >> 20) & 0x7ff) - 1023;
		const hfrac = (h & 0xfffff) | 0x100000;
		return (sign === 0 ? 1 : -1) * (hfrac * 2 ** (exp - 20) + l * 2 ** (exp - 52));
	};
	/** @param {number} depth @returns {any} */
	function value(depth) {
		if (depth >= maxDepth) throw new FrameError('depth');
		const type = u8();
		if (type < 0x80) return type;
		if ((type ^ 0xe0) < 0x20) return (type ^ 0xe0) - 0x20;
		let size;
		if ((size = type ^ 0xa0) <= 0x0f) return raw(size);
		if ((size = type ^ 0xb0) <= 0x0f) return str(size);
		if ((size = type ^ 0x90) <= 0x0f) return array(size, depth + 1);
		if ((size = type ^ 0x80) <= 0x0f) return map(size, depth + 1);
		switch (type) {
			case 0xc0: return null;
			case 0xc1: return undefined;
			case 0xc2: return false;
			case 0xc3: return true;
			case 0xca: return f32();
			case 0xcb: return f64();
			case 0xcc: return u8();
			case 0xcd: return u16();
			case 0xce: return u32();
			case 0xcf: return u64();
			case 0xd0: { const v = u8(); return v < 0x80 ? v : v - 256; }
			case 0xd1: { const v = u16(); return v < 0x8000 ? v : v - 65536; }
			case 0xd2: { const v = u32(); return v < 2 ** 31 ? v : v - 2 ** 32; }
			case 0xd3: { const v = u64(); return v < 2 ** 63 ? v : v - 2 ** 64; }
			case 0xd4: case 0xd5: case 0xd6: case 0xd7: return undefined;
			case 0xd8: return str(u16());
			case 0xd9: return str(u32());
			case 0xda: return raw(u16());
			case 0xdb: return raw(u32());
			case 0xdc: return array(u16(), depth + 1);
			case 0xdd: return array(u32(), depth + 1);
			case 0xde: return map(u16(), depth + 1);
			case 0xdf: return map(u32(), depth + 1);
		}
		// 0xc4-0xc9: not written by any sender; the PeerJS decoder returned undefined
		return undefined;
	}
	return value(0);
}

/**
 * The pieces of messages in flight on one link, with the limits above. `add` answers the joined bytes when a
 * message is complete, null while it is not, and throws a FrameError (dropping that message) on a broken rule.
 * @param {Partial<typeof FRAME_LIMITS>} [limits]
 */
export function createJoiner(limits = {}, onDrop = (/** @type {string} */ _reason) => {}) {
	const L = { ...FRAME_LIMITS, ...limits };
	/** @type {Map<number, {total: number, got: (ArrayBuffer | undefined)[], count: number, bytes: number}>} */
	const partials = new Map();
	/** bytes held across every message being joined */
	let held = 0;
	const forget = (/** @type {number} */ id) => {
		const entry = partials.get(id);
		if (!entry) return;
		held -= entry.bytes;
		partials.delete(id);
	};
	/** the message waiting longest makes way; counted, since it is lost @param {number} keep */
	const dropOldest = (keep) => {
		for (const oldest of partials.keys()) {
			if (oldest === keep) continue;
			forget(oldest);
			onDrop('piece-dropped');
			return true;
		}
		return false;
	};
	return {
		get size() {
			return partials.size;
		},
		get held() {
			return held;
		},
		clear() {
			partials.clear();
			held = 0;
		},
		/** @param {any} piece the decoded record `{__peerData: id, n, total, data}` @returns {Uint8Array | null} */
		add(piece) {
			const id = piece.__peerData;
			const { n, total, data } = piece;
			if (!Number.isSafeInteger(id) || id <= 0) throw new FrameError('piece-id');
			const fail = (/** @type {string} */ reason) => {
				forget(id);
				throw new FrameError(reason);
			};
			if (!Number.isInteger(total) || total < 1 || total > L.pieces) fail('piece-total');
			if (!Number.isInteger(n) || n < 0 || n >= total) fail('piece-index');
			if (!(data instanceof ArrayBuffer) || data.byteLength > L.pieceBytes) fail('piece-data');
			let entry = partials.get(id);
			if (!entry) {
				while (partials.size >= L.partials && dropOldest(id));
				entry = { total, got: [], count: 0, bytes: 0 };
				partials.set(id, entry);
			}
			if (entry.total !== total) fail('piece-total');
			if (entry.got[n] !== undefined) fail('piece-again');
			if (entry.bytes + data.byteLength > L.messageBytes) fail('piece-size');
			while (held + data.byteLength > L.heldBytes && dropOldest(id));
			entry.bytes += data.byteLength;
			held += data.byteLength;
			entry.got[n] = data;
			entry.count++;
			if (entry.count < entry.total) return null;
			forget(id);
			const out = new Uint8Array(entry.bytes);
			let offset = 0;
			for (const buf of entry.got) {
				const b = /** @type {ArrayBuffer} */ (buf);
				out.set(new Uint8Array(b), offset);
				offset += b.byteLength;
			}
			return out;
		}
	};
}

/** a plain decoded record (not an array, not a binary value) */
const isRecord = (/** @type {any} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ArrayBuffer);

/**
 * The connection class. It extends PeerJS's exported BufferedConnection exactly the way PeerJS's own binary
 * connection does, so sending, buffering and closing are PeerJS's.
 *
 * Per-link state is not a class field: PeerJS's constructor already runs `_initializeDataChannel` for a
 * link we dial, BEFORE a subclass field initialiser would run, so that state is created on first use.
 * `serialization` is the one field; nothing reads it before the constructor returns.
 */
export class SafeBinaryConnection extends BufferedConnection {
	/** what the dial tells the far side; set after PeerJS's constructor, as PeerJS's own binary connection does */
	serialization = 'binary';

	/** @returns {ReturnType<typeof createJoiner>} */
	get _joiner() {
		const self = /** @type {any} */ (this);
		return (self.__joiner ??= createJoiner({}, (reason) => this._refuse(reason)));
	}

	/** @param {string} reason */
	_refuse(reason) {
		try {
			refuse(String(/** @type {any} */ (this).peer), reason);
		} catch {
			/* a reporting failure never breaks the link */
		}
	}

	/** only the first channel of a link carries it; a later one the far side announces is closed @param {RTCDataChannel} dc */
	_initializeDataChannel(dc) {
		const self = /** @type {any} */ (this);
		if (self.__channel && self.__channel !== dc) {
			this._refuse('channel');
			try {
				dc.close();
			} catch {
				/* already closed */
			}
			return;
		}
		self.__channel = dc;
		// @ts-ignore -- PeerJS internal, the one BufferedConnection hook every connection class overrides
		super._initializeDataChannel(dc);
	}

	/** @param {{data: any}} e */
	_handleDataMessage({ data }) {
		if (data instanceof ArrayBuffer && data.byteLength > FRAME_LIMITS.frameBytes) {
			this._refuse('frame-size');
			return;
		}
		let value;
		try {
			value = decodeFrame(data);
		} catch (e) {
			this._refuse(e instanceof FrameError ? e.reason : 'decode');
			return;
		}
		this._deliver(value, false);
	}

	/** @param {any} value @param {boolean} joined */
	_deliver(value, joined) {
		if (value === null || value === undefined) {
			this._refuse('empty');
			return;
		}
		const peerData = isRecord(value) && Object.hasOwn(value, '__peerData') ? value.__peerData : undefined;
		if (!peerData) {
			// @ts-ignore -- EventEmitter
			this.emit('data', value);
			return;
		}
		if (isRecord(peerData) && peerData.type === 'close') {
			// @ts-ignore -- PeerJS's own close
			this.close();
			return;
		}
		if (joined) {
			// a joined message is never itself a piece
			this._refuse('piece-nested');
			return;
		}
		let bytes;
		try {
			bytes = this._joiner.add(value);
		} catch (e) {
			this._refuse(e instanceof FrameError ? e.reason : 'piece');
			return;
		}
		if (!bytes) return;
		let whole;
		try {
			// read from the joined bytes as PeerJS does, so binary values inside come back as Uint8Arrays
			whole = decodeFrame(bytes);
		} catch (e) {
			this._refuse(e instanceof FrameError ? e.reason : 'decode');
			return;
		}
		this._deliver(whole, true);
	}

	/** @param {any} [options] */
	close(options) {
		// @ts-ignore -- PeerJS's own close
		super.close(options);
		/** @type {any} */ (this).__joiner?.clear();
	}

	// ---- sending: PeerJS 1.5's binary connection, unchanged ----

	/** @param {any} data @param {boolean} chunked */
	_send(data, chunked) {
		const blob = util.pack(data);
		if (blob instanceof Promise) return this._sendBlob(blob);
		if (!chunked && blob.byteLength > PIECE_BYTES) {
			this._sendPieces(blob);
			return;
		}
		// @ts-ignore -- BufferedConnection
		this._bufferedSend(blob);
	}

	/** @param {Promise<ArrayBuffer | SharedArrayBuffer>} pending */
	async _sendBlob(pending) {
		const blob = await pending;
		if (blob.byteLength > PIECE_BYTES) {
			this._sendPieces(blob);
			return;
		}
		// @ts-ignore -- BufferedConnection
		this._bufferedSend(blob);
	}

	/** @param {ArrayBuffer | SharedArrayBuffer} blob */
	_sendPieces(blob) {
		const self = /** @type {any} */ (this);
		const id = (self.__sentMessages = (self.__sentMessages ?? 0) + 1);
		const total = Math.ceil(blob.byteLength / PIECE_BYTES);
		for (let n = 0, start = 0; start < blob.byteLength; n++, start += PIECE_BYTES) {
			this.send({ __peerData: id, n, data: blob.slice(start, Math.min(blob.byteLength, start + PIECE_BYTES)), total }, true);
		}
	}
}

/**
 * The `serializers` option for `new Peer(id, options)`: every codec name a dial may ask for, including the
 * names every object inherits, maps to this one class.
 */
export function peerSerializers() {
	/** @type {Record<string, typeof SafeBinaryConnection>} */
	const out = {};
	const names = ['default', 'binary', 'binary-utf8', 'raw', 'json', ...Object.getOwnPropertyNames(Object.prototype)];
	for (const name of names) Object.defineProperty(out, name, { value: SafeBinaryConnection, enumerable: true, writable: true, configurable: true });
	return out;
}
