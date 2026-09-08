import { get } from 'svelte/store';
import { showToast, appNotice, peers, cloudIdentity, userdata } from '../stores/appStore';
import { globalScene, globalCamera, globalRenderer, orbitControls, cameraClaim, isLocked, isVRMode } from '../stores/sceneStore';
import { requestConnect } from './peerApproval';
import { sessionHost } from './connectionState';
import {
	setCapabilityProvider,
	setAuthProvider,
	getAuthProvider,
	setMessageHandler,
	connectSlot,
	usersSlot,
	profileSlot,
	drawerSlot,
	rolesInfo,
	scenePresence,
	CLOUD_HOOKS_VERSION,
	cloudPluginInfo,
	sidebarSlot,
	setCommunityProvider
} from './cloudHooks';
// 21-G5 (F7): the two reads a rooms roster wants — which scene this session is in,
// and who is playing. Both leaves (levels reaches sessions, but nothing on the
// cloudPlugin path is in history's import subtree — App alone imports this module).
import { currentLevel } from './levels';
import { myPlayMode, peerPlayModes } from './gamePresence';

// 28-A (roadmap #28, publish · play · remix): the seams below reach cycle-sensitive
// modules — sessions is history-family, cameraBookmarks imports objectActions, playMode is
// imported from shortcuts — so none of them may be a STATIC edge from here (the moduleSDK
// rule: assume a static edge into those consumers closes a cycle). The two that need a
// SYNCHRONOUS surface (camera.bookmarks/recall, startPlay/stopPlay) read PRIMED dynamic
// imports resolved before register() runs; the async ones (buildSceneBundle,
// loadRemoteScene) import inline, the sceneTemplates.loadRemoteScene idiom.
/** @type {any} */
let cameraBookmarksLib = null;
/** @type {any} */
let playModeLib = null;
async function primeSeams() {
	[cameraBookmarksLib, playModeLib] = await Promise.all([import('./cameraBookmarks'), import('./playMode')]);
}

/**
 * Open-core plugin loader (roadmap #13 batch M1). At boot, if a cloud plugin URL is
 * configured, dynamic-`import()` it and hand it the cloud API. With nothing
 * configured this is a no-op, so the OSS build is unchanged.
 *
 * Config (first match wins):
 *   - `VITE_CLOUD_PLUGIN` build env — the production cloud deploy bakes in its URL.
 *   - `localStorage.cloudPluginUrl` — a dev override to load a local plugin build
 *     against a stock OSS app (the CL-1 dev loop).
 *
 * DYNAMIC import only (a static edge would drag the closed plugin into the OSS
 * bundle and can close a module cycle — the moduleSDK rule).
 */
export async function startCloudPlugin() {
	let url = '';
	try {
		url =
			(import.meta && import.meta.env && import.meta.env.VITE_CLOUD_PLUGIN) ||
			(typeof localStorage !== 'undefined' && localStorage.getItem('cloudPluginUrl')) ||
			'';
	} catch {
		url = '';
	}
	if (!url) return;

	try {
		const mod = await import(/* @vite-ignore */ url);
		// V2 fail-closed gate: a plugin may declare the hooks contract it NEEDS.
		// Strictly `>`, never `!==` — new-app + old-plugin is blessed (hooks stay
		// inert); only old-app + new-plugin refuses to register.
		const needs = Number(mod.compatibleHooks ?? (mod.default && mod.default.compatibleHooks));
		if (Number.isFinite(needs) && needs > CLOUD_HOOKS_VERSION) {
			showToast('Cloud plugin requires a newer app version — running in local mode.');
			return;
		}
		const register = mod.register || (mod.default && (mod.default.register || mod.default));
		if (typeof register !== 'function') {
			showToast('Cloud plugin loaded but exports no register() — ignoring.');
			return;
		}
		await primeSeams();
		await register(makeCloudApi());
		console.log('cloud plugin registered:', url);
	} catch (e) {
		console.error('cloud plugin failed to load:', e);
		showToast('Cloud plugin failed to load — running in local mode.');
	}
}

/**
 * The API surface handed to a cloud plugin's `register(api)`. Deliberately small
 * and stable: peer hooks, UI mount points, and a couple of context accessors.
 * @returns {any}
 */
function makeCloudApi() {
	return {
		/** contract version — bump when the surface changes incompatibly.
		 *  v2 (roadmap #14 PM): + mountProfile, mountConnectDrawer.
		 *  v2.3 (versioning): + setPluginInfo (plugin-side typeof probe).
		 *  v3 (roadmap #28-A): + buildSceneBundle, loadRemoteScene, camera, startPlay,
		 *  stopPlay, mountSidebar, setCommunityProvider — the publish · play · remix seams. */
		version: CLOUD_HOOKS_VERSION,

		/** V2: publish the loaded plugin's identity for Settings ▸ About.
		 *  @param {any} info `{name, version}` (null clears) */
		setPluginInfo: (info) =>
			cloudPluginInfo.set(
				info ? { name: String(info.name || 'cloud'), version: String(info.version || '') } : null
			),

		// --- peer hooks ---
		/** install the receive-side capability gate (roles enforcement) */
		setCapabilityProvider,
		/** install the identity/auth provider (pre-approve known peers) */
		setAuthProvider,
		getAuthProvider,

		// --- shared state ---
		/** the first-run notice banner store — rebrand or clear (set null) it */
		appNotice,
		/** push the signed-in account's {username, avatar, email} (or null on sign-out)
		 *  — core uses it as the default collaborative identity + menu display (v2) */
		setAccountIdentity: (/** @type {any} */ id) => cloudIdentity.set(id || null),

		// --- context accessors ---
		/** the live PeerConnection (id, connections, send…), or null before connect */
		getPeers: () => get(peers),
		/** the id of the peer whose session we joined, or null when WE are the host —
		 *  lets the plugin make the session host the roles authority (admin) — v2.1 */
		sessionHost: () => get(sessionHost),
		/** dial a peer through the normal request flow (join a room) — v2 */
		connectToPeer: (/** @type {string} */ peerId) => requestConnect(peerId),

		// --- plugin message channel (replicate the plugin's own state) ---
		/** broadcast a cloud message to all peers (roles, room announces) */
		sendCloud: (/** @type {any} */ payload) => {
			const p = get(peers);
			if (p && typeof p.send === 'function') p.send({ type: 'cloud', payload });
		},
		/** receive inbound cloud messages: handler(peerId, payload) */
		onCloudMessage: (/** @type {any} */ fn) => setMessageHandler(fn),

		// --- UI mount points (mount fn: (el) => cleanup) ---
		/** render into the Connect pill (login / Browse Rooms) */
		mountConnect: (/** @type {any} */ mountFn) =>
			connectSlot.set(typeof mountFn === 'function' ? mountFn : null),
		/** render into the Users popover (roles section) */
		mountUsersSection: (/** @type {any} */ mountFn) =>
			usersSlot.set(typeof mountFn === 'function' ? mountFn : null),
		/** render into the profile dropdown (login / account / preferences) — v2 */
		mountProfile: (/** @type {any} */ mountFn) =>
			profileSlot.set(typeof mountFn === 'function' ? mountFn : null),
		/** render into the Connect info drawer (room / host settings) — v2 */
		mountConnectDrawer: (/** @type {any} */ mountFn) =>
			drawerSlot.set(typeof mountFn === 'function' ? mountFn : null),
		/** publish the live roles so core can render per-peer role controls + gate
		 *  viewer actions (2026-07-25). Pass null to clear. */
		setRolesInfo: (/** @type {any} */ info) => rolesInfo.set(info || null),

		// --- 21-G5 (F7): cross-scene presence, v2.4 --------------------------------
		/** publish who is in the project's OTHER rooms/scenes (the rolesInfo bridge
		 *  shape — see cloudHooks.scenePresence for the document). Null clears. */
		setScenePresence: (/** @type {any} */ data) => scenePresence.set(data || null),
		/** the scene THIS session is in (the manifest name set by save/travel), or
		 *  null before the project machinery is used — what a room's heartbeat
		 *  publishes as its `scene` */
		currentScene: () => get(currentLevel)?.name ?? null,
		/** who is playing: my own mode plus every peer's (absent = editor) — what a
		 *  room's heartbeat publishes as its members' `mode` chips */
		playModes: () => ({ mine: myPlayMode(), peers: { ...get(peerPlayModes) } }),
		/** the display roster `[[peerId, name], …]` (self first, the userdata shape) —
		 *  what a room's heartbeat publishes as its members' names */
		peerRoster: () => (/** @type {any[]} */ (get(userdata)) ?? []).map((u) => [u[0], u[1] || '']),
		/** capture a downscaled JPEG Blob of the current viewport (room thumbnails) —
		 *  renders a fresh frame then reads the canvas synchronously so it works without
		 *  preserveDrawingBuffer. Returns null in VR / before the renderer exists. v2.2 */
		captureThumbnail: async (/** @type {number} */ maxW = 480) => {
			const r = /** @type {any} */ (get(globalRenderer));
			const scene = get(globalScene);
			const cam = get(globalCamera);
			if (!r || !scene || !cam || r.xr?.isPresenting) return null;
			try {
				r.render(scene, cam);
				const src = r.domElement;
				const sw = src.width || maxW;
				const scale = Math.min(1, maxW / sw);
				const w = Math.max(1, Math.round(sw * scale));
				const h = Math.max(1, Math.round((src.height || maxW) * scale));
				const c = document.createElement('canvas');
				c.width = w;
				c.height = h;
				const ctx = c.getContext('2d');
				if (!ctx) return null;
				ctx.drawImage(src, 0, 0, w, h);
				return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.6));
			} catch (e) {
				console.warn('thumbnail capture failed', e);
				return null;
			}
		},

		// --- 28-A (roadmap #28): publish · play · remix, cloudApi v3 ----------------------
		/**
		 * A1: the open scene as a publishable `.tpscene` bundle plus the facts a card says.
		 * Backed by the SAME payload builder and zip writer Save uses (buildSessionPayload →
		 * exportSessionZip), so a published file is exactly a saved one. NEVER saves, names
		 * or renames anything locally — publish is a COPY OUT, and the "a save names the
		 * room" rules (rounds 34/35) are untouched. `name` is the file's own name only; it
		 * defaults to the open scene's name, else 'Untitled'. `packs` are never bundled.
		 * @param {{assets?: boolean, flow?: boolean, name?: string}} [opts]
		 * @returns {Promise<{blob: Blob, meta: {objectCount: number, hasFlow: boolean, hasAudio: boolean,
		 *   hasGame: boolean, modules: {id: string, version: string}[], appVersion: string, bytes: number,
		 *   camera: {position: number[], target: number[]} | null, duration: number | null, files: any[]}}>}
		 */
		buildSceneBundle: async ({ assets = true, flow = true, name = '' } = {}) => {
			const { buildSessionPayload, exportSessionZip, sessionFileList } = await import('./sessions');
			const payload = buildSessionPayload(String(name || get(currentLevel)?.name || 'Untitled'));
			const zip = await exportSessionZip(payload, { assets: assets !== false, flow: flow !== false, packs: false });
			const blob = new Blob([/** @type {BlobPart} */ (zip)], { type: 'application/zip' });
			const meta = await bundleMeta(payload, { flow: flow !== false, bytes: blob.size, files: sessionFileList(payload) });
			return { blob, meta };
		},

		/**
		 * A2: fetch a remote `.tpscene` and load it through the existing session path —
		 * the viewer gate, the format confirm, the "Backup before <name>" stash, the
		 * replicated clear+rebuild and the peer-consent proposal all come with it. This is
		 * "Open in ThePrototype" and "Remix": a remix is a LOCAL load, nothing new on the
		 * wire. Resolves true when the scene was applied, false when refused/declined/failed
		 * (the user already saw why, as a toast or a confirm).
		 * @param {{sceneUrl: string, title?: string, slug?: string, modules?: {id: string, version: string}[]}} entry
		 * @returns {Promise<boolean>}
		 */
		loadRemoteScene: async ({ sceneUrl, title = '', slug = '', modules = [] } = /** @type {any} */ ({})) => {
			if (!sceneUrl) return false;
			const { loadRemoteScene } = await import('./sceneTemplates');
			return loadRemoteScene({
				sceneUrl: String(sceneUrl),
				title: String(title || slug || 'Scene'),
				slug: String(slug || title || 'scene'),
				modules: Array.isArray(modules) ? modules : []
			});
		},

		/**
		 * A3: the editor camera, for the hero shot (recall a bookmark → captureThumbnail →
		 * restore the pose) and for storing the pose ON the published record — bookmarks live
		 * in localStorage only and never travel with the file. Every call answers null/false
		 * before the renderer exists and in VR (the headset owns that camera).
		 */
		camera: {
			/** the current view. `fov` is additive: a caller reading only
			 *  `{position, target}` is unaffected, and one that hands the whole object back to
			 *  `setPose` restores the lens a `recall` may have changed.
			 *  @returns {{position: number[], target: number[], fov: number | null} | null} */
			pose: () => {
				/** @type {any} */
				const camera = get(globalCamera);
				/** @type {any} */
				const controls = get(orbitControls);
				if (!camera || !controls || get(isVRMode)) return null;
				return {
					position: camera.position.toArray(),
					target: controls.target.toArray(),
					fov: typeof camera.fov === 'number' ? camera.fov : null
				};
			},
			/** move the editor camera INSTANTLY (no tween — a capture may follow on the very
			 *  next frame). Writes BOTH ends and runs the controls' update, because
			 *  OrbitControls re-derives the position from its own spherical state and a
			 *  position written alone is reverted a frame later. Bumps `cameraClaim` so a
			 *  note-follow or any other continuous driver steps aside (flyTo's rule).
			 *  @param {{position: number[], target: number[], fov?: number | null}} pose
			 *  @returns {boolean} false when the camera is not ours to move */
			setPose: (pose) => setCameraPose(pose),
			/** the saved views, id + name only — what a "Camera" dropdown lists
			 *  @returns {{id: string, name: string}[]} */
			bookmarks: () =>
				(cameraBookmarksLib ? /** @type {any[]} */ (get(cameraBookmarksLib.bookmarks)) : []).map((b) => ({
					id: String(b.id),
					name: String(b.name)
				})),
			/** jump to a saved view: position, target and the saved FOV. The saved clip planes
			 *  are left alone on purpose — they are a persisted local preference and a
			 *  capture cannot see them. Returns FALSE when the bookmark is gone (deleted since
			 *  the dropdown rendered); the caller then falls back to the current view.
			 *  @param {string} id @returns {boolean} */
			recall: (id) => {
				if (!cameraBookmarksLib) return false;
				const bookmark = /** @type {any[]} */ (get(cameraBookmarksLib.bookmarks)).find((b) => b.id === id);
				if (!bookmark) return false;
				return setCameraPose({ position: bookmark.position, target: bookmark.target, fov: bookmark.lens?.fov ?? null });
			}
		},

		/**
		 * A4: enter play mode — the same press the Controls button makes (requestPlay), so
		 * the XR branch, the rejoin queue and sim-on-play all still decide. What a
		 * `/?s=<id>&play=1` link needs after its load lands. NOTE: browsers grant a pointer
		 * LOCK only inside a user gesture; called from a boot deep link the mode still
		 * holds (a refused lock never exits play) and the pointer locks on the player's
		 * first click. Returns false only before the seam is primed (never after boot).
		 * @returns {boolean}
		 */
		startPlay: () => {
			if (!playModeLib) return false;
			playModeLib.requestPlay();
			return true;
		},
		/** A4: leave play mode — the canonical exit (Escape / the touch ✕ / a HUD quit).
		 *  Returns true when we WERE playing. @returns {boolean} */
		stopPlay: () => {
			if (!playModeLib) return false;
			const was = get(isLocked) === true;
			playModeLib.exitPlay();
			return was;
		},

		/** A5: render a ROW directly under the Save row's format segment in the logo menu
		 *  (the Publish row must sit beside Save or nobody finds it). Mount fn: (el) =>
		 *  cleanup. Render your own `<button class="side-row"><span class="side-ico">…</span>
		 *  …</button>` — the sidebar's row look reaches the slot. Null unmounts. */
		mountSidebar: (/** @type {any} */ mountFn) =>
			sidebarSlot.set(typeof mountFn === 'function' ? mountFn : null),

		/** A6: swap the Templates modal's Community source. Pass
		 *  `{ list(opts), load(entry), notice?(), submit? }` (see cloudHooks.communityProvider
		 *  and OPEN-CORE.md for the exact shape) — or null to restore the GitHub gallery
		 *  (logout). Core never learns what is behind the provider. */
		setCommunityProvider: (/** @type {any} */ provider) => setCommunityProvider(provider),

		// --- utilities ---
		toast: showToast
	};
}

// --- 28-A helpers -------------------------------------------------------------------

/**
 * A3: the one camera write. See `camera.setPose` for the two rules it keeps (both ends +
 * update; a claim bump). Refuses in VR — the XR rig owns that camera — and before the
 * editor camera/controls exist.
 * @param {{position: number[], target: number[], fov?: number | null}} pose
 * @returns {boolean}
 */
function setCameraPose(pose) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!camera || !controls || get(isVRMode)) return false;
	const position = pose?.position;
	const target = pose?.target;
	if (!Array.isArray(position) || position.length < 3 || !Array.isArray(target) || target.length < 3) return false;
	camera.position.fromArray(position);
	controls.target.fromArray(target);
	const fov = pose?.fov;
	if (typeof fov === 'number' && Number.isFinite(fov) && typeof camera.fov === 'number') {
		camera.fov = fov;
		camera.updateProjectionMatrix();
	}
	controls.update();
	cameraClaim.update((n) => n + 1);
	return true;
}

/**
 * A1: the card facts, read OUT of the payload the bundle was built from — every one is
 * already in there (the roadmap's finding), this derives nothing new. Two rules:
 *   · `hasFlow` is "any graph has NODES", never "a graph exists" — every scene carries an
 *     empty `graphs.scene`.
 *   · read against the include-options the zip applied: a bundle built with `flow:false`
 *     has its graphs AND its module list stripped (exportSessionZip's rule), so its meta
 *     must not claim either.
 * The audio node family is READ from the catalog, not hard-coded: the Music group's types
 * plus `sound` (which lives in Effects); a node added to that group later counts without
 * a change here. A cable patch (`payload.patch`) is audio evidence too.
 * @param {any} payload @param {{flow: boolean, bytes: number, files: any[]}} ctx
 */
async function bundleMeta(payload, ctx) {
	const graphs = ctx.flow ? payload?.graphs ?? {} : {};
	/** @type {any[]} */
	const nodes = Object.values(graphs).flatMap((/** @type {any} */ g) => (Array.isArray(g?.nodes) ? g.nodes : []));
	const { nodeCatalog } = await import('./nodeCatalog');
	const audioTypes = new Set(['sound']);
	for (const group of nodeCatalog) if (group.group === 'Music') for (const item of group.items) audioTypes.add(item.type);
	return {
		objectCount: Number(payload?.count) || 0,
		hasFlow: nodes.length > 0,
		hasAudio: !!payload?.music || !!payload?.patch || nodes.some((n) => audioTypes.has(n?.type)),
		hasGame: !!payload?.game,
		modules: ctx.flow && Array.isArray(payload?.modules) ? payload.modules : [],
		appVersion: String(payload?.appVersion ?? ''),
		bytes: ctx.bytes,
		camera: payload?.camera ?? null,
		duration: await bundleDuration(payload),
		files: ctx.files
	};
}

/**
 * A1: how long the scene "plays" — the music track's duration when it has one, else the
 * longest authored clip, else null (optional on the record, the roadmap's finding 6).
 * The track's length is read from its bytes through an <audio> element's metadata (no
 * decode of the whole file, and the music chain's own decoded buffer is private to it);
 * a track this machine does not hold yet falls through to the clips.
 * @param {any} payload @returns {Promise<number | null>}
 */
async function bundleDuration(payload) {
	const hash = payload?.music?.hash;
	if (hash) {
		try {
			const { itemByHash, itemBlob } = await import('./explorer');
			const item = /** @type {any} */ (itemByHash(hash));
			const blob = item ? await itemBlob(item.id) : null;
			if (blob) {
				const seconds = await mediaDuration(blob);
				if (seconds != null) return seconds;
			}
		} catch {
			/* fall through to the clips */
		}
	}
	let longest = 0;
	for (const set of Object.values(payload?.animations ?? {}))
		for (const clip of Object.values(/** @type {any} */ (set)?.clips ?? {}))
			longest = Math.max(longest, Number(/** @type {any} */ (clip)?.duration) || 0);
	return longest > 0 ? longest : null;
}

/** duration of a media blob via <audio> metadata, null on any failure/timeout
 * @param {Blob} blob @returns {Promise<number | null>} */
function mediaDuration(blob) {
	return new Promise((resolve) => {
		let url = '';
		const done = (/** @type {number | null} */ v) => {
			clearTimeout(timer);
			if (url) URL.revokeObjectURL(url);
			resolve(v);
		};
		const timer = setTimeout(() => done(null), 3000);
		try {
			url = URL.createObjectURL(blob);
			const el = document.createElement('audio');
			el.preload = 'metadata';
			el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
			el.onerror = () => done(null);
			el.src = url;
		} catch {
			done(null);
		}
	});
}
