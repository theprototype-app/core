import { writable, get } from 'svelte/store';
import { showToast, closeSelectionInspector } from '../stores/appStore.js';
import { objectsGroup } from '../stores/sceneStore';
import { isViewer, warnViewerReadOnly } from './objectPermissions';
import { contentBase, fetchIndex, onContentStale } from './contentBase';
// 36 F20: a template's load is claimed at the click (a leaf: svelte/store only)
import { claimLoad, isLive, endLoad, updateLoad } from './sceneLoader';
// 28-A6: the Community source a cloud plugin may install (store-only, no cycle — the
// objectPermissions import above already reaches cloudHooks' family)
import { communityProvider, notifyTemplateOpen } from './cloudHooks';
import { primeLoadOrigin } from './gameIdentity.js';
// 33 (L3): the Clear scene modal's setup check and full clear (see confirmClearScene)
import * as sceneSwitch from './sceneSwitch';

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

/** Off-bundle base for curated templates/examples/games. A content release re-points
 * the ref in the scenes repo (`git tag -f format-2 && git push -f origin format-2`,
 * then purge) — jsDelivr caches a ref for up to 12 hours, so released builds stay
 * stable and the app picks the change up without a redeploy.
 *
 * C5.2: the ref tracks the INDEX FORMAT and a format bump takes a NEW ref, never a
 * reused one, so a deployed older build cannot be handed an index whose `games`
 * section it has no tab for. (Reusing the previous ref would push new-format content
 * at every build already in the wild.)
 *
 * 29f (#230): THE REF MUST NOT LOOK LIKE A VERSION. jsDelivr parses `v2` as a SEMVER
 * VERSION (`x-jsd-version-type: version`, `cache-control: immutable` for a year), so a
 * retag of `v2` was a no-op forever and four purges changed nothing — the Games tab
 * shipped three games while the feed had six. A ref jsDelivr cannot parse as a version
 * (`format-2`, tag or branch) is reported as type `branch` with a 12-hour s-maxage,
 * which is what makes the retag-and-purge ritual work. `scenes@v2` is a dead ref, left
 * where jsDelivr first resolved it for the builds that shipped against it;
 * `tests/unit/contentBase.test.js` asserts no semver-looking ref comes back. */
export const SCENES_BASE = contentBase(import.meta.env.VITE_SCENES_BASE, 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@format-2');
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
/** A7: normalized Games-tab entries. A game is a module PLUS a scene, so its rows
 * carry `modules` — the A6.2 requirement list, which the card shows and the load
 * path prompts about. Absent `games` in a v1 index leaves this empty, which is the
 * absent-means-absent rule and what keeps a deployed older index loading.
 * @type {import('svelte/store').Writable<any[]>} */
export const games = writable([]);
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
/** 28-A6: the provider's ONE notice row above the Community grid — `{text, href?}` or
 * null. Written only by loadCommunityGallery (from `provider.notice()`); always null in
 * the OSS build, so the modal renders no row.
 * @type {import('svelte/store').Writable<{text: string, href?: string} | null>} */
export const communityNotice = writable(null);

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
		// A7: {id, version}[] — the SAME shape moduleRequirements() derives and the
		// handshake sends, so the card, the prompt and the save all speak one language
		modules: Array.isArray(entry.modules)
			? entry.modules
					.filter((/** @type {any} */ m) => m && (typeof m === 'string' || m.id))
					.map((/** @type {any} */ m) =>
						typeof m === 'string' ? { id: m, version: '' } : { id: String(m.id), version: String(m.version ?? '') }
					)
			: [],
		bytes: entry.bytes || 0,
		sceneUrl: resolveUrl(entry.scene, base),
		thumbUrl: resolveUrl(entry.thumb, base)
	};
}

/**
 * A7: the union of tags across a tab's entries, for the chip row. Sorted so the
 * chips do not reshuffle between fetches, and DERIVED rather than a curated list —
 * a new tag in the index appears without a core release.
 * @param {any[]} entries @returns {string[]}
 */
export function tagUnion(entries) {
	/** @type {Set<string>} */
	const all = new Set();
	for (const entry of entries ?? []) for (const tag of entry.tags ?? []) if (tag) all.add(String(tag));
	return [...all].sort();
}

/**
 * Does an entry match the active chips? OR within the facet: picking `vr` and
 * `co-op` shows anything that is either, which is what a browsing user means by
 * ticking two interests (an AND would empty the grid on the second click).
 * @param {any} entry @param {string[]} active @returns {boolean}
 */
export function matchesTags(entry, active) {
	if (!active?.length) return true;
	return (entry.tags ?? []).some((/** @type {string} */ tag) => active.includes(tag));
}

/** 1.19.1: an app update drops both index memos (contentBase.onContentStale), so reopening
 * the modal in a tab that outlived a deploy re-fetches instead of showing the old list. */
let templatesStale = false;
let communityStale = false;
onContentStale(() => {
	templatesStale = true;
	communityStale = true;
});

/** Load the General/Examples index: remote CDN first, the bundled
 * static/templates seed as the offline fallback (the loadPacks idiom).
 * Memoized — pass force to refetch (the Retry button). @param {boolean=} force */
export async function loadTemplatesIndex(force = false) {
	const state = get(templatesState);
	if (!force && !templatesStale && (state === 'ready' || state === 'fallback' || state === 'loading')) return;
	templatesStale = false;
	templatesState.set('loading');
	try {
		const res = await fetchIndex(`${SCENES_BASE}/index.json`);
		if (res.ok) {
			const data = await res.json();
			templates.set((data.templates || []).map((/** @type {any} */ e) => normalizeEntry(e, SCENES_BASE)));
			examples.set((data.examples || []).map((/** @type {any} */ e) => normalizeEntry(e, SCENES_BASE)));
			// A7: a v1 index has no `games` key at all — an absent section is an EMPTY
			// tab, never an error, so a deployed older index keeps loading
			games.set((data.games || []).map((/** @type {any} */ e) => normalizeEntry(e, SCENES_BASE)));
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
			// the bundled seed carries TEMPLATES only, by design: a game needs a module
			// download anyway, so a bundled offline game would be a broken promise
			games.set([]);
			templatesState.set('fallback');
			return;
		}
	} catch {
		/* offline and nothing bundled */
	}
	templates.set([]);
	examples.set([]);
	games.set([]);
	templatesState.set('error');
}

/**
 * 28-A6: a provider entry, normalized to the card shape. `normalizeEntry`'s ten fields
 * exactly, plus the optional `{id, href, likeCount, remixOf}` the card renders only when
 * present (absent = absent — a GitHub row never grows them). A provider may hand over
 * already-resolved `sceneUrl`/`thumbUrl` or index-style `scene`/`thumb`; either works,
 * and absolute URLs pass through resolveUrl untouched.
 * @param {any} e
 */
function normalizeProviderEntry(e) {
	const row = normalizeEntry({ ...e, scene: e?.scene ?? e?.sceneUrl ?? '', thumb: e?.thumb ?? e?.thumbUrl ?? '' }, '');
	/** @type {any} */
	const extra = {};
	if (e?.id != null && e.id !== '') extra.id = String(e.id);
	if (e?.href) extra.href = String(e.href);
	if (e?.likeCount != null && Number.isFinite(Number(e.likeCount))) extra.likeCount = Number(e.likeCount);
	if (e?.remixOf) extra.remixOf = typeof e.remixOf === 'object' ? e.remixOf : { id: String(e.remixOf) };
	// 36-community: the viewer's own heart (C6), "this is mine" for the Mine chip (C5), and one
	// line the provider wants on the card (an author's "Hidden by moderation: …")
	if (typeof e?.liked === 'boolean') extra.liked = e.liked;
	if (e?.mine === true) extra.mine = true;
	if (e?.notice) extra.notice = String(e.notice).slice(0, 200);
	return { ...row, ...extra };
}

/** Load the Community gallery manifest. Memoized — pass force to refetch.
 * 404 / unreachable / zero entries all land on the friendly empty/error states
 * (the repo may simply not have content yet). @param {boolean=} force
 *
 * 28-A6: PROVIDER FIRST. When a cloud plugin has installed a community provider
 * (cloudHooks.communityProvider) the list comes from `provider.list()` and the notice
 * row from `provider.notice()`; the GitHub gallery below is the OSS path and the
 * fallback the moment the provider is cleared. Same `communityState` vocabulary either
 * way, so the modal needs no state work. */
export async function loadCommunityGallery(force = false) {
	const state = get(communityState);
	if (!force && !communityStale && (state === 'ready' || state === 'empty' || state === 'loading')) return;
	communityStale = false;
	communityState.set('loading');
	const provider = get(communityProvider);
	if (provider) {
		try {
			const raw = await provider.list({ force: !!force });
			// the provider may have been swapped/cleared while its list was in flight — a
			// late answer must not overwrite what the new source (or the GitHub path) shows
			if (get(communityProvider) !== provider) return;
			const list = (Array.isArray(raw) ? raw : []).map(normalizeProviderEntry);
			communityEntries.set(list);
			communityState.set(list.length ? 'ready' : 'empty');
		} catch {
			if (get(communityProvider) !== provider) return;
			communityEntries.set([]);
			communityState.set('error');
		}
		let notice = null;
		try {
			notice = typeof provider.notice === 'function' ? provider.notice() : null;
		} catch {
			notice = null;
		}
		communityNotice.set(notice && typeof notice === 'object' && notice.text ? { text: String(notice.text), ...(notice.href ? { href: String(notice.href) } : {}) } : null);
		return;
	}
	communityNotice.set(null);
	try {
		const res = await fetchIndex(GALLERY_JSON_URL);
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
 * 28-A6: a Community card click. With a provider installed its `load(entry)` decides
 * (the plugin owns the fetch, the account rules and the remix lineage); without one —
 * or with a provider that declared no `load` — the GitHub path below applies. The
 * per-card busy state is kept either way.
 * @param {any} entry a normalized entry @returns {Promise<boolean>} applied
 */
export async function loadCommunityEntry(entry) {
	const provider = get(communityProvider);
	if (!provider || typeof provider.load !== 'function') return loadRemoteScene(entry, { origin: 'community' });
	loadingSlug.set(entry?.slug ?? null);
	try {
		return (await provider.load(entry)) === true;
	} catch {
		showToast(`Could not load "${entry?.title ?? 'scene'}"`);
		return false;
	} finally {
		loadingSlug.set(null);
	}
}

/**
 * Fetch a remote .tpscene and load it through the existing session path
 * (format confirm → backup stash → replicated replace / peer proposal).
 * 36-community (C4): a remote scene is somebody else's game — `opts.origin` says which tab it came
 * from, and the load is primed as a REMIX (the file's game id stays while it is only played and
 * forks at the first save) unless `keepGameId` (the owner opening their own published scene). A
 * template remembers its slug as the game's `template`; a Games-tab start is one "template open".
 * @param {any} entry a normalized entry
 * @param {{origin?: string, keepGameId?: boolean}} [opts]
 * @returns {Promise<boolean>} applied
 */
export async function loadRemoteScene(entry, opts = {}) {
	// viewers can't replace the shared scene — peers drop the broadcasts (cloud
	// capability gate), which would leave this client desynced. Inert without a
	// roles plugin (isViewer() is false when no rolesInfo).
	if (isViewer()) {
		warnViewerReadOnly('View-only — ask an editor to load a scene.');
		return false;
	}
	if (!entry?.sceneUrl) return false;
	loadingSlug.set(entry.slug);
	// 36 F20: the load is THIS click's from now — the download, the unzip and the dialogs
	// all happen inside it, the bar says so at once (F21), and a scene opened meanwhile
	// supersedes it: then this one stops at its next await and never replaces anything
	const job = claimLoad(entry.title || entry.slug || 'scene');
	try {
		const res = await fetch(entry.sceneUrl);
		if (!isLive(job)) return false;
		if (!res.ok) {
			endLoad(job);
			showToast(`Could not fetch "${entry.title}" (${res.status})`);
			return false;
		}
		const bytes = await res.arrayBuffer();
		if (!isLive(job)) return false;
		updateLoad(job, { phase: 'preparing' });
		const { importSessionZip, requestLoadSession } = await import('./sessions');
		const payload = await importSessionZip(bytes);
		if (!isLive(job)) return false;
		if (!payload) {
			endLoad(job);
			return false; // V4: user declined a newer-format confirm — silent
		}
		const origin = String(opts.origin || '');
		const isTemplate = origin === 'games' || origin === 'general' || origin === 'examples';
		primeLoadOrigin(payload.id, { remote: true, keep: opts.keepGameId === true, template: isTemplate ? String(entry.slug || '') : '' });
		const applied = await requestLoadSession(payload.id, { job });
		// (not for a click a newer one superseded — that template never opened)
		if (origin === 'games' && entry.slug && !job.cancelled) notifyTemplateOpen(String(entry.slug));
		return applied;
	} catch {
		const mine = isLive(job);
		endLoad(job);
		if (mine) showToast(`Could not load "${entry.title}" — check your connection`);
		return false;
	} finally {
		// a newer click on another card owns the spinner now
		if (get(loadingSlug) === entry.slug) loadingSlug.set(null);
	}
}

/**
 * 24-C3 — SAVE A TEMPLATE INTO THE LIBRARY without loading it: the card's second
 * action. Loading replaces the world for everyone; this fetches the same .tpscene and
 * files it as a NEW project scene under the template's own title (its copy name when
 * that is taken — `levels.freeSceneName`), through the one scene-copy write path
 * (`levels.addSceneFromBytes`: fresh identity inside the file, consent, the manifest
 * entry). The open scene is untouched, so there is nothing to confirm and no backup to
 * stash. Dynamic import: levels.js is history-family and this module is a leaf.
 * @param {any} entry a normalized entry @returns {Promise<any|null>} the library item
 */
export async function saveRemoteSceneToLibrary(entry) {
	if (!entry?.sceneUrl) return null;
	loadingSlug.set(entry.slug);
	try {
		const res = await fetch(entry.sceneUrl);
		if (!res.ok) {
			showToast(`Could not fetch "${entry.title}" (${res.status})`);
			return null;
		}
		const { addSceneFromBytes, freeSceneName } = await import('./levels');
		// a title is prose, a scene name is a file stem: the three characters the Explorer
		// refuses in any name (`isValidName`) become dashes before the name is chosen
		const name = freeSceneName(String(entry.title || entry.slug || 'Scene').replace(/[*\\/]+/g, '-'));
		const item = await addSceneFromBytes(await res.arrayBuffer(), name, null);
		if (item) showToast(`Saved to your Library as "${name}" — open it from the Explorer`);
		return item;
	} catch {
		showToast(`Could not save "${entry.title}" — check your connection`);
		return null;
	} finally {
		loadingSlug.set(null);
	}
}

/**
 * 33 (L3) — CLEAR SCENE, ONE MODAL WITH ONE CHOICE. The user: "after hitting clear scene in
 * an opened game example I still see the Menu button and the ability to play … so clear
 * scene does not really clear. The modal should say clear only objects, or modules and
 * everything else." The old flow was a toast ("Clear the scene for everyone?") that only
 * ever removed OBJECTS — the flow nodes, the HUD menu, the game state, the play block, the
 * music, the sky and the modules all stayed, which is why a cleared game still had a Menu.
 *
 * Now: "Clear objects" stays the primary (today's behaviour, nothing else touched), and ONE
 * checkbox, "Also reset the game setup and unload its modules", turns it into "Clear
 * everything" — an EMPTY scene applied the way any load applies (sceneSwitch). A checkbox,
 * not an Advanced chevron: it is the only extra choice there is, and hiding the only choice
 * behind a disclosure is what made the old Clear surprising. It defaults OFF (a Clear is
 * usually about objects) unless there ARE no objects, when objects-only would do nothing.
 * After an objects-only clear that left a setup or modules behind, a toast says so and
 * offers the rest.
 *
 * `blank: true` is the Templates modal's "Blank scene" card — a NEW scene, so it always
 * resets everything and unloads the scene's modules (the user: "if I open a new project …
 * modules should not be kept"), and the dialog says so instead of offering a box.
 *
 * Viewer-gated like loadRemoteScene. The objects clear reaches commandsHandler through a
 * dynamic import, so this module adds no static edge into the history import subtree
 * (TDZ-cycle family); sceneSwitch is static (its graph is moduleSDK/stores, never history).
 * @param {{blank?: boolean}} [opts]
 * @returns {Promise<'objects' | 'everything' | 'nothing' | null>} what was cleared (null = cancelled / refused)
 */
export async function confirmClearScene(opts = {}) {
	if (isViewer()) {
		warnViewerReadOnly('View-only — ask an editor to clear the scene.');
		return null;
	}
	const blank = !!opts.blank;
	const clearObjects = () => import('./commandsHandler.svelte').then((m) => m.sceneCommand('/clear all'));
	// STATIC (sceneSwitch): the dialog must answer the click at once. Through a dynamic import
	// it took ~9 frames before the modal existed — 5-15 s on a heavy game scene in a slow
	// renderer (measured), which reads as a dead button. sceneSwitch's own graph never reaches
	// this file, so the edge closes no cycle.
	const sw = sceneSwitch;
	const { showChoiceEx } = sw;
	const count = get(objectsGroup)?.children.length ?? 0;
	const parts = sw.sceneSetupParts();
	const mods = sw.sceneUserModules();
	const extra = parts.length > 0 || mods.length > 0;
	const objectsLine = count
		? count + ' object' + (count === 1 ? '' : 's') + ' will be removed for everyone in the session.'
		: 'There are no objects.';
	const setupLine =
		[parts.length ? 'Resets ' + parts.join(', ') : '', mods.length ? 'unloads ' + mods.map((m) => m.name).join(', ') : '']
			.filter(Boolean)
			.join('; ') + '.';
	if (blank) {
		if (!count && !extra) {
			await clearObjects(); // still clears module content
			return 'nothing';
		}
		const reply = await showChoiceEx({
			id: 'blank-scene',
			title: 'Start a blank scene?',
			message: objectsLine + (extra ? '\n' + setupLine : ''),
			choices: [{ value: 'blank', label: 'Start blank', color: 'red' }]
		});
		if (!reply) return null;
		closeSelectionInspector();
		await sw.clearSceneEverything(mods);
		return 'everything';
	}
	if (!count && !extra) {
		await clearObjects(); // still clears module content
		return 'nothing';
	}
	const reply = await showChoiceEx({
		id: 'clear-scene',
		title: 'Clear scene',
		message: objectsLine,
		checkbox: extra
			? { label: 'Also reset the game setup and unload its modules', hint: setupLine.charAt(0).toUpperCase() + setupLine.slice(1), checked: !count }
			: undefined,
		choices: [{ value: 'clear', label: 'Clear objects', checkedLabel: 'Clear everything', color: 'red' }]
	});
	if (!reply) return null;
	closeSelectionInspector();
	if (reply.checked) {
		await sw.clearSceneEverything(mods);
		return 'everything';
	}
	await clearObjects();
	if (extra) {
		const left = [...parts, ...mods.map((m) => m.name)];
		showToast('Objects cleared. Still here: ' + left.join(', ') + '.', [
			{ label: 'Clear those too', action: () => void sw.clearSceneEverything(sw.sceneUserModules()) }
		]);
	}
	return 'objects';
}

// 28-A6: a provider swap (install, or null on logout) invalidates the memo — the tab
// re-fetches from whichever source is now in force the next time it is shown (the
// modal's own effect asks again when the state goes back to idle). Reset, never
// re-fetch here: a logout must not fire a network request from a closed modal. The
// stores this reads are declared above (module-level subscribers run synchronously at
// eval — the TDZ rule).
let lastProvider = get(communityProvider);
communityProvider.subscribe((provider) => {
	if (provider === lastProvider) return;
	lastProvider = provider;
	communityEntries.set([]);
	communityNotice.set(null);
	communityState.set('idle');
});
