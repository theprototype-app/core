// 102b-play row 2 — INFO POINTS: notes a scene's VISITORS can open in the play app.
//
// A note (annotationsHandler) is a reviewer's tool: pinned to an object, threaded replies, the
// editor's popover. Marking one "show to visitors" (`visitors: true`) makes it an info point:
// the play app lists it, its pin stays clickable there, and its card shows the title, the text,
// ONE picture and — when the author saved a framing — a "Show the view" button. Every other note
// stays out of the play app (a published scene is not a review session).
//
// THE PICTURE is a small data URL ON THE NOTE, not an Explorer hash: the play app has no
// library to resolve a hash from without a peer, and an info point must work with no live
// session (the touch-texture precedent: data URLs on this side of 160 KB). It is downscaled
// before it is stored (longest side 960 px, JPEG), and the boundary below refuses anything that
// is not a base64 PNG / JPEG / WebP image under the cap — an <img src> is the only place it
// goes, but a hostile peer must not be able to put an address there.
//
// A LEAF: no imports, so the annotations normalizer, the popover and the play app all reach it.

/** characters, not bytes: ~210 KB of image once decoded */
export const MAX_PICTURE_CHARS = 280_000;
export const PICTURE_MAX_SIDE = 960;
const PICTURE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** @param {any} v @returns {string | null} */
export function normalizePicture(v) {
	if (typeof v !== 'string' || v.length > MAX_PICTURE_CHARS) return null;
	return PICTURE_RE.test(v) ? v : null;
}

/**
 * Fold the two info-point fields onto a normalized note IN PLACE: both present only when set,
 * so every other note stays byte-identical. normalizeAnnotation calls this.
 * @param {any} out the note being normalized @param {any} raw what came in
 */
export function applyInfoPointFields(out, raw) {
	if (raw?.visitors === true) out.visitors = true;
	else delete out.visitors;
	const picture = normalizePicture(raw?.picture);
	if (picture) out.picture = picture;
	else delete out.picture;
	return out;
}

/** the notes the play app shows, in the drawer's order (oldest first) @param {any[]} list */
export function visitorNotes(list) {
	return (Array.isArray(list) ? list : []).filter((note) => note && note.visitors === true);
}

/** a visitor's title for a note: its name, else the first line of its text, else a number
 * @param {any} note @param {number} index */
export function infoTitle(note, index) {
	const name = typeof note?.name === 'string' ? note.name.trim() : '';
	if (name) return name;
	const first = typeof note?.text === 'string' ? note.text.trim().split('\n')[0].slice(0, 60) : '';
	return first || 'Info point ' + (index + 1);
}

/**
 * Shrink an image file into a data URL the boundary accepts (browser only). Longest side
 * PICTURE_MAX_SIDE, JPEG at falling quality until it fits; null when it cannot be read or fit.
 * @param {Blob} file @returns {Promise<string | null>}
 */
export async function pictureFromFile(file) {
	if (!file || !/^image\//.test(file.type || '')) return null;
	/** @type {ImageBitmap | null} */
	let bitmap = null;
	try {
		bitmap = await createImageBitmap(file);
		const scale = Math.min(1, PICTURE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, w, h);
		for (const quality of [0.85, 0.72, 0.6, 0.45]) {
			const url = normalizePicture(canvas.toDataURL('image/jpeg', quality));
			if (url) return url;
		}
		return null;
	} catch {
		return null;
	} finally {
		bitmap?.close?.();
	}
}
