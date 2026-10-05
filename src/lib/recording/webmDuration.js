// 36-share (B13) — write the Duration a MediaRecorder webm is missing. PURE (imports nothing).
//
// Chrome's MediaRecorder streams its webm with an unknown-size Segment and no Segment▸Info▸Duration,
// because it cannot know the length while it writes. A <video> then reports `duration = Infinity`
// until it has been seeked to the end, the Explorer cannot say how long a recording is, and some
// players refuse to show a scrubber at all. After the recording stops we DO know the length, so we
// patch the one element in: an 11-byte Duration (float64) appended to Info, Info's size re-encoded,
// and the Segment's size grown with it when the Segment has one (Firefox writes a known size).
//
// Deliberately narrow: an EBML walk over the header, the Segment and Info only — no Cluster is
// read. A file with a SeekHead before Info would have its seek offsets shifted by the insert, so
// such a file is returned unchanged (MediaRecorder writes none); an existing Duration is
// overwritten in place (no size change, always safe).

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;

/**
 * An element ID at `pos` (the marker bits kept, as the spec writes IDs).
 * @param {Uint8Array} b @param {number} pos @returns {{id: number, len: number} | null}
 */
function readId(b, pos) {
	const first = b[pos];
	if (first === undefined) return null;
	let len = 1;
	while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
	if (len > 4 || pos + len > b.length) return null;
	let id = 0;
	for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
	return { id, len };
}

/**
 * A size vint at `pos`. `unknown` = every value bit set (a live stream's Segment/Cluster).
 * @param {Uint8Array} b @param {number} pos @returns {{value: number, len: number, unknown: boolean} | null}
 */
function readSize(b, pos) {
	const first = b[pos];
	if (first === undefined || first === 0) return null;
	let len = 1;
	while (!(first & (0x80 >> (len - 1)))) len++;
	if (pos + len > b.length) return null;
	let value = first & (0xff >> len);
	let allOnes = value === 0xff >> len;
	for (let i = 1; i < len; i++) {
		value = value * 256 + b[pos + i];
		if (b[pos + i] !== 0xff) allOnes = false;
	}
	return { value, len, unknown: allOnes };
}

/**
 * Encode `value` as a size vint `len` bytes wide, or null when it does not fit.
 * @param {number} value @param {number} len @returns {Uint8Array | null}
 */
function encodeSize(value, len) {
	// the all-ones pattern means "unknown", so the largest storable value is one less
	if (len < 1 || len > 8 || value >= 2 ** (7 * len) - 1) return null;
	const out = new Uint8Array(len);
	let v = value;
	for (let i = len - 1; i >= 0; i--) {
		out[i] = v % 256;
		v = Math.floor(v / 256);
	}
	out[0] |= 0x80 >> (len - 1);
	return out;
}

/** @param {Uint8Array} b @param {number} pos @param {number} len */
function readUint(b, pos, len) {
	let v = 0;
	for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];
	return v;
}

/**
 * Walk to Segment▸Info. Null when the bytes are not a webm this patcher understands.
 * @param {Uint8Array} b
 */
function locate(b) {
	const head = readId(b, 0);
	if (!head || head.id !== ID_EBML) return null;
	const headSize = readSize(b, head.len);
	if (!headSize || headSize.unknown) return null;
	let pos = head.len + headSize.len + headSize.value;
	const seg = readId(b, pos);
	if (!seg || seg.id !== ID_SEGMENT) return null;
	const segSizeAt = pos + seg.len;
	const segSize = readSize(b, segSizeAt);
	if (!segSize) return null;
	pos = segSizeAt + segSize.len;
	let seekHead = false;
	while (pos < b.length) {
		const el = readId(b, pos);
		if (!el) return null;
		const size = readSize(b, pos + el.len);
		if (!size) return null;
		if (el.id === ID_INFO) {
			if (size.unknown) return null;
			const dataAt = pos + el.len + size.len;
			if (dataAt + size.value > b.length) return null;
			return { segSizeAt, segSize, seekHead, infoAt: pos, infoIdLen: el.len, infoSize: size, dataAt };
		}
		if (el.id === ID_CLUSTER || size.unknown) return null;
		if (el.id === ID_SEEKHEAD) seekHead = true;
		pos += el.len + size.len + size.value;
	}
	return null;
}

/**
 * The children of Info we care about.
 * @param {Uint8Array} b @param {number} start @param {number} end
 */
function readInfo(b, start, end) {
	let scale = 1000000;
	/** @type {{at: number, len: number} | null} */
	let duration = null;
	let pos = start;
	while (pos < end) {
		const el = readId(b, pos);
		if (!el) break;
		const size = readSize(b, pos + el.len);
		if (!size || size.unknown) break;
		const dataAt = pos + el.len + size.len;
		if (el.id === ID_TIMECODE_SCALE && size.value >= 1 && size.value <= 8) scale = readUint(b, dataAt, size.value) || scale;
		if (el.id === ID_DURATION && (size.value === 4 || size.value === 8)) duration = { at: dataAt, len: size.value };
		pos = dataAt + size.value;
	}
	return { scale, duration };
}

/**
 * The Duration a webm declares, in milliseconds, or null (absent / not a webm).
 * @param {Uint8Array} bytes @returns {number | null}
 */
export function readWebmDuration(bytes) {
	const loc = locate(bytes);
	if (!loc) return null;
	const info = readInfo(bytes, loc.dataAt, loc.dataAt + loc.infoSize.value);
	if (!info.duration) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset + info.duration.at, info.duration.len);
	const ticks = info.duration.len === 8 ? view.getFloat64(0) : view.getFloat32(0);
	return (ticks * info.scale) / 1e6;
}

/**
 * Return the webm with its Duration set to `durationMs`. Returns the INPUT unchanged when the file
 * is not one this can patch safely (the caller keeps a playable, merely duration-less, file).
 * @param {Uint8Array} bytes @param {number} durationMs @returns {Uint8Array}
 */
export function fixWebmDuration(bytes, durationMs) {
	if (!(durationMs > 0) || !Number.isFinite(durationMs)) return bytes;
	const loc = locate(bytes);
	if (!loc) return bytes;
	const infoEnd = loc.dataAt + loc.infoSize.value;
	const info = readInfo(bytes, loc.dataAt, infoEnd);
	const ticks = (durationMs * 1e6) / info.scale;
	if (info.duration) {
		const out = bytes.slice();
		const view = new DataView(out.buffer, out.byteOffset + info.duration.at, info.duration.len);
		if (info.duration.len === 8) view.setFloat64(0, ticks);
		else view.setFloat32(0, ticks);
		return out;
	}
	if (loc.seekHead) return bytes;
	const element = new Uint8Array(11);
	element[0] = 0x44;
	element[1] = 0x89;
	element[2] = 0x88; // size 8
	new DataView(element.buffer).setFloat64(3, ticks);
	const newInfoSize = loc.infoSize.value + element.length;
	const infoSizeBytes = encodeSize(newInfoSize, loc.infoSize.len) ?? encodeSize(newInfoSize, 8);
	if (!infoSizeBytes) return bytes;
	const grow = element.length + (infoSizeBytes.length - loc.infoSize.len);
	/** @type {Uint8Array | null} */
	let segSizeBytes = null;
	if (!loc.segSize.unknown) {
		segSizeBytes = encodeSize(loc.segSize.value + grow, loc.segSize.len);
		if (!segSizeBytes) return bytes;
	}
	const sizeAt = loc.infoAt + loc.infoIdLen;
	const out = new Uint8Array(bytes.length + grow);
	out.set(bytes.subarray(0, sizeAt), 0);
	if (segSizeBytes) out.set(segSizeBytes, loc.segSizeAt);
	let w = sizeAt;
	out.set(infoSizeBytes, w);
	w += infoSizeBytes.length;
	out.set(bytes.subarray(loc.dataAt, infoEnd), w);
	w += infoEnd - loc.dataAt;
	out.set(element, w);
	w += element.length;
	out.set(bytes.subarray(infoEnd), w);
	return out;
}
