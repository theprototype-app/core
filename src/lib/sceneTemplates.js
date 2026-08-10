import { writable, get } from 'svelte/store';
import { showToast, closeSelectionInspector } from '../stores/appStore.js';
import { objectsGroup } from '../stores/sceneStore';
import { isViewer, warnViewerReadOnly } from './objectPermissions';

// Templates modal content (roadmap: "Templates" sidebar row → General/Examples/
// Community tabs). Two content sources, no bytes in this repo beyond the bundled
// seed fallback:
//  - General templates + Examples: github.com/theprototype-app/scenes via the
//    tagged jsDelivr mirror (the PACKS_BASE pattern) with static/templates/ as
//    the offline/bundled fallback — same idiom as packs.js loadPacks().
//  - Community: the PR-gated github.com/theprototype-app/community-gallery repo.
//    gallery.json is read from raw.githubusercontent (fresh — merged PRs appear
//    within minutes, and it sends CORS *), while scene/thumb blobs ride the
//    jsDelivr @main mirror (12h cache is fine for content). Moderation is by
//    construction: nothing lists until a maintainer merges the PR.
// Loading goes through the EXISTING .tpscene path (importSessionZip →
// requestLoadSession): format confirm, "Backup before <name>" stash, replicated
// clear+rebuild, and the sessionproposal peer-consent flow all come for free.

/** Off-bundle base for curated templates/examples. Bump the tag when content
 * changes — jsDelivr caches tags aggressively, so released builds stay stable. */
export const SCENES_BASE = 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@v1';
/** Community manifest (raw = fresh + CORS; see header note). */
export const GALLERY_JSON_URL =
	'https://raw.githubusercontent.com/theprototype-app/community-gallery/main/gallery.json';
/** Community blob base (jsDelivr mirror of the gallery repo's main branch). */
export const GALLERY_BASE = 'https://cdn.jsdelivr.net/gh/theprototype-app/community-gallery@main';
/** Where the Community empty state sends contributors. */
export const SUBMIT_URL = 'https://github.com/theprototype-app/community-gallery';

/** normalized General-tab entries @type {import('svelte/store').Writable<any[]>} */
export const templates = writable([]);
/** normalized Examples-tab entries @type {import('svelte/store').Writable<any[]>} */
export const examples = writable([]);
/** 'idle' | 'loading' | 'ready' (remote) | 'fallback' (bundled seed) | 'error'
 * @type {import('svelte/store').Writable<string>} */
export const templatesState = writable('idle');
/** normalized Community-tab entries @type {import('svelte/store').Writable<any[]>} */
export const communityEntries = writable([]);
/** 'idle' | 'loading' | 'ready' | 'empty' | 'error'
 * @type {import('svelte/store').Writable<string>} */
export const communityState = writable('idle');
/** slug of the entry currently fetching/applying (per-card busy state)
 * @type {import('svelte/store').Writable<string | null>} */
export const loadingSlug = writable(null);

/** Resolve an index path against a CDN base: absolute http(s) URLs pass through
 * (big .tpscene files >~20MB point at raw.githubusercontent — the jsDelivr file
 * cap), app-origin '/...' paths pass through when base is empty (bundled seed).
 * The packs.js normalizeDefault resolver, shared shape.
 * @param {string} path @param {string} base */
export function resolveUrl(path, base) {
	if (!path) return '';
	if (/^https?:\/\//.test(path)) return path;
	if (!base) return path.startsWith('/') ? path : '/' + path;
	return `${base}/${path.replace(/^\//, '')}`;
}

/** Normalize an index/gallery entry to what the cards render.
 * @param {any} entry @param {string} base '' = bundled (app-origin paths) */
function normalizeEntry(entry, base) {
	return {
		slug: entry.slug || entry.title || 'scene',
		title: entry.title || entry.slug || 'Untitled',
		description: entry.description || '',
		author: entry.author || '',
		license: entry.license || '',
		tags: Array.isArray(entry.tags) ? entry.tags : [],
		bytes: entry.bytes || 0,
		sceneUrl: resolveUrl(entry.scene, base),
		thumbUrl: resolveUrl(entry.thumb, base)
	};
}

/** Load the General/Examples index: remote CDN first, the bundled
 * static/templates seed as the offline fallback (the loadPacks idiom).
 * Memoized — pass force to refetch (the Retry button). @param {boolean=} force */
export async function loadTemplatesIndex(force = false) {
	const state = get(templatesState);
	if (!force && (state === 'ready' || state === 'fallback' || state === 'loading')) return;
	templatesState.set('loading');
	try {
		const res = await fetch(`${SCENES_BASE}/index.json`);
		if (res.ok) {
			const data = await res.json();
			templates.set((data.templates || []).map((/** @type {any} */ e) => normalizeEntry(e, SCENES_BASE)));
			examples.set((data.examples || []).map((/** @type {any} */ e) => normalizeEntry(e, SCENES_BASE)));
			templatesState.set('ready');
			return;
		}
	} catch {
		/* CDN unreachable — fall back to the bundled seed below */
	}
	try {
		const res = await fetch('/templates/index.json');
		if (res.ok) {
			const data = await res.json();
			templates.set((data.templates || []).map((/** @type {any} */ e) => normalizeEntry(e, '')));
			examples.set((data.examples || []).map((/** @type {any} */ e) => normalizeEntry(e, '')));
			templatesState.set('fallback');
			return;
		}
	} catch {
		/* offline and nothing bundled */
	}
	templates.set([]);
	examples.set([]);
	templatesState.set('error');
}

/** Load the Community gallery manifest. Memoized — pass force to refetch.
 * 404 / unreachable / zero entries all land on the friendly empty/error states
 * (the repo may simply not have content yet). @param {boolean=} force */
export async function loadCommunityGallery(force = false) {
	const state = get(communityState);
	if (!force && (state === 'ready' || state === 'empty' || state === 'loading')) return;
	communityState.set('loading');
	try {
		const res = await fetch(GALLERY_JSON_URL);
		if (res.ok) {
			const data = await res.json();
			const list = (data.entries || []).map((/** @type {any} */ e) => normalizeEntry(e, GALLERY_BASE));
			communityEntries.set(list);
			communityState.set(list.length ? 'ready' : 'empty');
			return;
		}
		// a 404 just means no gallery published yet — same friendly empty state
		communityEntries.set([]);
		communityState.set(res.status === 404 ? 'empty' : 'error');
	} catch {
		communityEntries.set([]);
		communityState.set('error');
	}
}

/**
 * Fetch a remote .tpscene and load it through the existing session path
 * (format confirm → backup stash → replicated replace / peer proposal).
 * @param {any} entry a normalized entry @returns {Promise<boolean>} applied
 */
export async function loadRemoteScene(entry) {
	// viewers can't replace the shared scene — peers drop the broadcasts (cloud
	// capability gate), which would leave this client desynced. Inert without a
	// roles plugin (isViewer() is false when no rolesInfo).
	if (isViewer()) {
		warnViewerReadOnly('View-only — ask an editor to load a scene.');
		return false;
	}
	if (!entry?.sceneUrl) return false;
	loadingSlug.set(entry.slug);
	try {
		const res = await fetch(entry.sceneUrl);
		if (!res.ok) {
			showToast(`Could not fetch "${entry.title}" (${res.status})`);
			return false;
		}
		const { importSessionZip, requestLoadSession } = await import('./sessions');
		const payload = await importSessionZip(await res.arrayBuffer());
		if (!payload) return false; // V4: user declined a newer-format confirm — silent
		await requestLoadSession(payload.id);
		return true;
	} catch {
		showToast(`Could not load "${entry.title}" — check your connection`);
		return false;
	} finally {
		loadingSlug.set(null);
	}
}

/**
 * Confirm-and-clear the scene for everyone (the Sidebar "Clear Scene" flow,
 * shared with the modal's Blank card). Viewer-gated like loadRemoteScene.
 * Synchronous up to the confirm toast (suites snapshot it right after the
 * click); only the clear itself defers into a dynamic import so this
 * store-only module adds no static edge into the commandsHandler/history
 * import subtree (TDZ-cycle family).
 */
export function confirmClearScene() {
	if (isViewer()) {
		warnViewerReadOnly('View-only — ask an editor to clear the scene.');
		return;
	}
	const clear = () =>
		void import('./commandsHandler.svelte').then((m) => m.sceneCommand('/clear all'));
	const count = get(objectsGroup)?.children.length ?? 0;
	if (count === 0) {
		clear(); // still clears module content
		return;
	}
	showToast('Clear the scene for everyone? ' + count + ' object' + (count === 1 ? '' : 's') + ' will be removed.', [
		{
			label: 'Clear',
			action: () => {
				closeSelectionInspector();
				clear();
			}
		},
		{ label: 'Cancel', action: () => {} }
	]);
}
