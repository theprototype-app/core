// 56 C8 test fixtures — a minimal but REAL EXIF APP1 segment with a GPS IFD (latitude/longitude as
// RATIONAL triples, the way a phone camera writes them), spliced into a JPEG after SOI. Used by the
// unit test (tpchat attach strip) and by build-gps-jpeg.mjs, which writes the committed fixtures.
// Imports nothing.

/** @param {number} lat @param {number} lon @param {string} [make] @returns {Uint8Array} the APP1 segment */
export function gpsApp1(lat, lon, make = 'OPPO') {
	/** @type {number[]} */
	const tiff = [];
	const u16 = (/** @type {number} */ v) => tiff.push(v & 255, (v >> 8) & 255);
	const u32 = (/** @type {number} */ v) => tiff.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
	const dms = (/** @type {number} */ deg) => {
		const a = Math.abs(deg);
		const d = Math.floor(a);
		const m = Math.floor((a - d) * 60);
		const s = Math.round(((a - d) * 60 - m) * 60 * 100);
		return [d, 1, m, 1, s, 100];
	};
	const makeBytes = [...make].map((c) => c.charCodeAt(0)).concat(0);
	// layout: header(8) | IFD0 (2 + 3*12 + 4 = 42) | GPS IFD (2 + 5*12 + 4 = 66) | data
	const ifd0 = 8;
	const gpsIfd = ifd0 + 42;
	let data = gpsIfd + 66;
	const makeAt = data;
	data += makeBytes.length + (makeBytes.length & 1);
	const latAt = data;
	data += 24;
	const lonAt = data;
	data += 24;
	tiff.push(0x49, 0x49, 0x2a, 0x00); // "II*\0"
	u32(ifd0);
	// IFD0
	u16(3);
	u16(0x010f), u16(2), u32(makeBytes.length), u32(makeAt); // Make
	u16(0x0112), u16(3), u32(1), u16(1), u16(0); // Orientation = 1
	u16(0x8825), u16(4), u32(1), u32(gpsIfd); // GPSInfo IFD pointer
	u32(0);
	// GPS IFD
	u16(5);
	u16(0x0000), u16(1), u32(4), tiff.push(2, 3, 0, 0); // GPSVersionID
	u16(0x0001), u16(2), u32(2), tiff.push(lat >= 0 ? 0x4e : 0x53, 0, 0, 0); // N/S
	u16(0x0002), u16(5), u32(3), u32(latAt);
	u16(0x0003), u16(2), u32(2), tiff.push(lon >= 0 ? 0x45 : 0x57, 0, 0, 0); // E/W
	u16(0x0004), u16(5), u32(3), u32(lonAt);
	u32(0);
	tiff.push(...makeBytes);
	if (makeBytes.length & 1) tiff.push(0);
	for (const v of dms(lat)) u32(v);
	for (const v of dms(lon)) u32(v);
	const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0" + TIFF
	const len = body.length + 2;
	return Uint8Array.from([0xff, 0xe1, (len >> 8) & 255, len & 255, ...body]);
}

/** JPEG bytes with the APP1 inserted right after SOI @param {Uint8Array} jpeg @param {Uint8Array} app1 */
export function spliceApp1(jpeg, app1) {
	if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
	const out = new Uint8Array(jpeg.length + app1.length);
	out.set(jpeg.subarray(0, 2), 0);
	out.set(app1, 2);
	out.set(jpeg.subarray(2), 2 + app1.length);
	return out;
}
