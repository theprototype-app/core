// 36-share (B13) — the COMMUNITY GALLERY submission, its browser half: the open scene as the
// gallery's `.tpscene` (Save's own payload + zip writer — the file is exactly a saved one), a
// 480×270 thumbnail from the viewport, entry.json and the gallery.json row, packed into one zip
// laid out the way the repo wants it. Shape and rules: galleryCore.js. Nothing here talks to the
// network; the submission flow is GitHub's own pages, opened by the person's click.
import { get } from 'svelte/store';
import { globalRenderer, globalScene, globalCamera, isVRMode, TControls } from '../../stores/sceneStore';
import { HELPER_LAYER, withMarkersHidden } from '../helperLayer';
import { currentLevel } from '../levels';
import { APP_VERSION } from '../version.js';
import { buildEntry, galleryRow, validateEntry, gallerySlug, submissionReadme, uploadUrl, THUMB_SIZE, THUMB_CAP } from './galleryCore.js';

/**
 * A fresh frame of the viewport, centre-cropped to 480×270. webp when the browser encodes it,
 * png otherwise, stepping the webp quality down until it fits the gallery's 512 KB. Null in VR /
 * before the renderer exists.
 * @returns {Promise<{blob: Blob, name: string} | null>}
 */
export async function captureGalleryThumb() {
	const r = /** @type {any} */ (get(globalRenderer));
	const scene = get(globalScene);
	const cam = get(globalCamera);
	if (!r || !scene || !cam || get(isVRMode)) return null;
	const c = document.createElement('canvas');
	c.width = THUMB_SIZE.w;
	c.height = THUMB_SIZE.h;
	const ctx = c.getContext('2d');
	if (!ctx) return null;
	// a gallery card is a viewer's picture: no grid, no gizmo, no helper layer, no camera markers
	// for this one render (put back straight after; render and read in the same task — the
	// drawing buffer is not preserved)
	const tc = /** @type {any} */ (get(TControls));
	const hide = [tc?.getHelper?.() ?? tc, /** @type {any} */ (scene).getObjectByName?.('editor-grid')].filter((n) => n?.visible);
	for (const n of hide) n.visible = false;
	const cameraAny = /** @type {any} */ (cam);
	const mask = cameraAny.layers?.mask;
	cameraAny.layers?.disable(HELPER_LAYER);
	try {
		withMarkersHidden(() => r.render(scene, cam));
		const src = r.domElement;
		const scale = Math.max(THUMB_SIZE.w / src.width, THUMB_SIZE.h / src.height);
		const w = src.width * scale;
		const h = src.height * scale;
		ctx.drawImage(src, (THUMB_SIZE.w - w) / 2, (THUMB_SIZE.h - h) / 2, w, h);
	} finally {
		for (const n of hide) n.visible = true;
		if (cameraAny.layers && mask !== undefined) cameraAny.layers.mask = mask;
	}
	for (const q of [0.85, 0.7, 0.5]) {
		const webp = /** @type {Blob | null} */ (await new Promise((res) => c.toBlob(res, 'image/webp', q)));
		if (webp && webp.type === 'image/webp' && webp.size <= THUMB_CAP) return { blob: webp, name: 'thumb.webp' };
		if (webp && webp.type !== 'image/webp') break;
	}
	const png = /** @type {Blob | null} */ (await new Promise((res) => c.toBlob(res, 'image/png')));
	return png ? { blob: png, name: 'thumb.png' } : null;
}

/**
 * Build the submission zip.
 * @param {{title: string, author: string, license: string, description?: string, tags?: string[] | string,
 *   slug?: string, thumb?: {blob: Blob, name: string} | null}} meta
 * @returns {Promise<{ok: true, blob: Blob, fileName: string, slug: string, entry: import('./galleryCore.js').GalleryEntry,
 *   row: any, rowText: string, sceneBytes: number, thumbName: string, uploadUrl: string} | {ok: false, errors: string[]}>}
 */
export async function buildGallerySubmission(meta) {
	const entry = buildEntry({ ...meta, appVersion: APP_VERSION });
	const slug = gallerySlug(meta.slug || entry.title);
	const early = validateEntry(slug, entry);
	if (early.length) return { ok: false, errors: early };

	const { buildSessionPayload, exportSessionZip } = await import('../sessions');
	const payload = buildSessionPayload(String(entry.title || get(currentLevel)?.name || 'Untitled'));
	const scene = /** @type {Uint8Array} */ (await exportSessionZip(payload, { assets: true, flow: true, packs: false }));
	const thumb = meta.thumb ?? (await captureGalleryThumb());
	if (!thumb) return { ok: false, errors: ['Could not take a thumbnail from the viewport (leave VR and try again).'] };
	const thumbBytes = new Uint8Array(await thumb.blob.arrayBuffer());
	const errors = validateEntry(slug, entry, { sceneBytes: scene.byteLength, thumbBytes: thumbBytes.byteLength });
	if (errors.length) return { ok: false, errors };

	const row = galleryRow(slug, entry, { thumbName: thumb.name, bytes: scene.byteLength });
	const rowText = JSON.stringify(row, null, '\t');
	const { zipSync, strToU8 } = await import('fflate');
	// stored, not deflated: the .tpscene is a zip already and the thumbnail is compressed
	const zipped = zipSync(
		{
			[slug]: {
				'scene.tpscene': scene,
				[thumb.name]: thumbBytes,
				'entry.json': strToU8(JSON.stringify(entry, null, '\t') + '\n')
			},
			'gallery-row.json': strToU8(rowText + '\n'),
			'HOW-TO-SUBMIT.txt': strToU8(submissionReadme(slug, thumb.name))
		},
		{ level: 0 }
	);
	return {
		ok: true,
		blob: new Blob([/** @type {BlobPart} */ (zipped)], { type: 'application/zip' }),
		fileName: `${slug}-gallery-submission.zip`,
		slug,
		entry,
		row,
		rowText,
		sceneBytes: scene.byteLength,
		thumbName: thumb.name,
		uploadUrl: uploadUrl(slug)
	};
}
