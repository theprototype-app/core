// 36-share (B13) — the COMMUNITY GALLERY submission, its pure half (imports nothing).
//
// The gallery is a GitHub repo (github.com/theprototype-app/community-gallery): a submission is a
// pull request adding ONE folder and ONE row, and its CI (scripts/validate.cjs) checks both. So
// this file is that repo's README turned into code — the folder shape, the entry.json fields in
// README order, the gallery.json row, the license allowlist and the size caps — and `validateEntry`
// refuses exactly what that CI would refuse, before the person has made a fork for nothing.
//
//   <slug>/scene.tpscene   the scene (Save's own bundle)
//   <slug>/thumb.webp      480×270 (png when the browser cannot encode webp), ≤ 512 KB
//   <slug>/entry.json      {title, author, license, description, tags, appVersion, created}
//   + a gallery.json row:  the same fields + slug first + scene/thumb repo paths + bytes
//
// The app never pushes anything: the person downloads the zip and presses GitHub's own buttons
// (the upload page forks the repo for a non-collaborator and proposes the pull request).

export const GALLERY_REPO = 'theprototype-app/community-gallery';
export const GALLERY_BRANCH = 'main';
export const GALLERY_LICENSES = Object.freeze([
	{ id: 'CC0-1.0', label: 'CC0 1.0', line: 'Public domain: anyone may use it, no credit needed.' },
	{ id: 'CC-BY-4.0', label: 'CC BY 4.0', line: 'Anyone may use and remix it, crediting you.' },
	{ id: 'MIT', label: 'MIT', line: 'Free to use and remix, with the notice kept.' }
]);
export const SCENE_CAP = 25 * 1024 * 1024;
export const THUMB_CAP = 512 * 1024;
export const THUMB_SIZE = Object.freeze({ w: 480, h: 270 });
export const MAX_TITLE = 80;
export const MAX_DESCRIPTION = 300;
export const MAX_TAGS = 6;
export const MAX_TAG_LENGTH = 24;
export const SUGGESTED_TAGS = Object.freeze(['showcase', 'game', 'building', 'nature', 'interior', 'vehicle', 'puzzle', 'vr', 'sci-fi', 'fantasy']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** lowercase letters, digits and single dashes, '' when nothing is left @param {string} s */
function dashed(s) {
	return String(s || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '') // the accent marks NFKD split off: é -> e, not e-
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** a gallery slug from a title (the folder name; 'scene' when the title has no letters) @param {string} s */
export function gallerySlug(s) {
	return dashed(s).slice(0, 48).replace(/-+$/g, '') || 'scene';
}

/** tags as the gallery wants them: lowercase-dashed, unique, ≤ 6, ≤ 24 chars @param {string | string[]} raw */
export function normalizeTags(raw) {
	const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,\n]/);
	/** @type {string[]} */
	const out = [];
	for (const t of list) {
		const tag = dashed(String(t)).slice(0, MAX_TAG_LENGTH).replace(/-+$/g, '');
		if (tag && !out.includes(tag)) out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

/** @typedef {{title: string, author: string, license: string, description: string, tags: string[], appVersion: string, created: string}} GalleryEntry */

/**
 * entry.json, fields in README order.
 * @param {{title: string, author: string, license: string, description?: string, tags?: string[] | string, appVersion?: string, created?: string | Date}} m
 * @returns {GalleryEntry}
 */
export function buildEntry(m) {
	const created = m.created instanceof Date ? m.created.toISOString().slice(0, 10) : String(m.created || new Date().toISOString().slice(0, 10));
	return {
		title: String(m.title || '').trim(),
		author: String(m.author || '').trim().replace(/^@/, ''),
		license: String(m.license || ''),
		description: String(m.description || '').trim(),
		tags: normalizeTags(m.tags ?? []),
		appVersion: String(m.appVersion || ''),
		created
	};
}

/**
 * The gallery.json row: slug first, the entry, then where the files live in the repo and how big
 * the scene is (CI compares `bytes` with the file).
 * @param {string} slug @param {GalleryEntry} entry @param {{thumbName: string, bytes: number}} files
 */
export function galleryRow(slug, entry, files) {
	return { slug, ...entry, scene: `${slug}/scene.tpscene`, thumb: `${slug}/${files.thumbName}`, bytes: files.bytes };
}

/**
 * What the gallery's CI would refuse (scripts/validate.cjs), as sentences. Empty = submittable.
 * @param {string} slug @param {GalleryEntry} entry @param {{sceneBytes?: number, thumbBytes?: number}} [sizes]
 */
export function validateEntry(slug, entry, sizes = {}) {
	/** @type {string[]} */
	const errors = [];
	if (!SLUG_RE.test(slug)) errors.push('The folder name must be lowercase letters, digits and dashes.');
	if (!entry.title) errors.push('Give it a title.');
	else if (entry.title.length > MAX_TITLE) errors.push(`The title is over ${MAX_TITLE} characters.`);
	if (!entry.author) errors.push('Say who made it (your GitHub handle).');
	else if (!/^[A-Za-z0-9-]{1,39}$/.test(entry.author)) errors.push('The author should be a GitHub handle: letters, digits and dashes.');
	if (!GALLERY_LICENSES.some((l) => l.id === entry.license)) errors.push('Pick one of the gallery licenses (CC0, CC BY or MIT).');
	if (entry.description.length > MAX_DESCRIPTION) errors.push(`The description is over ${MAX_DESCRIPTION} characters.`);
	if (typeof sizes.sceneBytes === 'number' && sizes.sceneBytes > SCENE_CAP) errors.push(`The scene file is ${(sizes.sceneBytes / 1048576).toFixed(1)} MB; the gallery takes up to 25 MB.`);
	if (typeof sizes.thumbBytes === 'number' && sizes.thumbBytes > THUMB_CAP) errors.push('The thumbnail is over 512 KB.');
	return errors;
}

/** GitHub's upload page for the new folder (forks + proposes a PR for a non-collaborator) @param {string} slug */
export function uploadUrl(slug) {
	return `https://github.com/${GALLERY_REPO}/upload/${GALLERY_BRANCH}/${encodeURIComponent(slug)}`;
}
/** GitHub's editor for the root gallery.json (the row goes into its `entries` array) */
export function editGalleryJsonUrl() {
	return `https://github.com/${GALLERY_REPO}/edit/${GALLERY_BRANCH}/gallery.json`;
}
/** the repo's own page (the README is the full guide) */
export function galleryRepoUrl() {
	return `https://github.com/${GALLERY_REPO}`;
}

/** the zip's own instructions @param {string} slug @param {string} thumbName */
export function submissionReadme(slug, thumbName) {
	return [
		'Submitting this scene to the ThePrototype community gallery',
		'============================================================',
		'',
		`This zip holds one gallery entry: the folder "${slug}/" (scene.tpscene, ${thumbName}, entry.json)`,
		'and gallery-row.json, the row to add to the gallery index.',
		'',
		`1. Open ${uploadUrl(slug)}`,
		`   and drag in the three files from the "${slug}" folder. GitHub forks the repo for you`,
		'   and offers to "Propose changes": do that, then open the pull request.',
		`2. Open ${editGalleryJsonUrl()} (on your fork's branch)`,
		'   and add the contents of gallery-row.json as one more item in the "entries" array',
		'   (mind the comma before it). Commit it to the same branch / pull request.',
		'3. The gallery CI checks the files, sizes and license; a maintainer reviews and merges.',
		'   Merged scenes appear in the app (logo menu > Templates > Community) within minutes.',
		'',
		`Rules and details: ${galleryRepoUrl()}#readme`,
		''
	].join('\n');
}
