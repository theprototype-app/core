# Open-core extension points (batch M1)

theprototype is **open core**: this MIT repo (`theprototype-app/core`) is the entire
engine — self-hosted, peer-to-peer, exactly as it runs today. Registration, rooms,
roles and persistence are a separate closed **cloud** product
(`theprototype.app-cloud`) that plugs into the engine through the seams described
here. With no cloud plugin configured, these seams are **inert**: the OSS build
behaves byte-for-byte as it did before they existed.

Anyone can build their own plugin against the same contract — roles, gating, custom
identity — without forking the engine.

## Loading a plugin

At boot, `startCloudPlugin()` ([src/lib/cloudPlugin.js](src/lib/cloudPlugin.js))
dynamic-`import()`s a plugin URL if one is configured (first match wins):

| Source | Use |
|---|---|
| `VITE_CLOUD_PLUGIN` (build env) | the production cloud deploy bakes in its URL |
| `localStorage.cloudPluginUrl` | dev override — load a local plugin against a stock build |

A plugin is any ES module exporting `register(cloudApi)` (or a default export with a
`register`). It runs once, after the app mounts. A load/throw failure is caught and
toasted — the app keeps running in local mode.

Try it: `localStorage.setItem('cloudPluginUrl', '/cloud-plugin-example.js')` then
reload. The worked reference plugin is
[static/cloud-plugin-example.js](static/cloud-plugin-example.js).

## The `cloudApi` surface

```js
export function register(api) {
  api.version                      // contract version (currently 3 — see "Versioning")
  api.setPluginInfo({name, version}) // shown in Settings ▸ About (null clears)

  // Receive-side capability gate (roles enforcement)
  api.setCapabilityProvider(fn)    // fn(peerId, msgType) => boolean; false = DROP
  api.setAuthProvider(provider)    // { authorize(peerId): boolean }
  api.getAuthProvider()

  // Shared state
  api.appNotice                    // the first-run banner store; set(null) clears it

  // Context
  api.getPeers()                   // the live PeerConnection (or null pre-connect)

  // Plugin message channel (replicate the plugin's OWN state across the mesh)
  api.sendCloud(payload)           // broadcast { type:'cloud', payload } to peers
  api.onCloudMessage((peerId, payload) => …)  // receive them

  // UI mount points — mount fn: (el) => cleanup
  api.mountConnect(fn)             // into the Connect pill (login / Browse Rooms)
  api.mountUsersSection(fn)        // into the Users popover (roles)
  api.mountProfile(fn)             // into the profile dropdown (account) — v2
  api.mountConnectDrawer(fn)       // into the Connect info drawer (room settings) — v2
  api.mountSidebar(fn)             // a ROW under Save in the logo menu (Publish) — v3

  // Roles / presence bridges (core renders, the plugin decides)
  api.setRolesInfo(info)           // { myId, myRole, amAdmin, order, roleOf, setRole } | null
  api.setScenePresence(data)       // who is in the project's OTHER rooms | null — v2.4
  api.setAccountIdentity(id)       // {username, avatar, email} | null — the collaborative identity
  api.currentScene() / api.playModes() / api.peerRoster() / api.sessionHost()
  api.connectToPeer(peerId)        // dial through the normal request flow
  api.captureThumbnail(maxW)       // Promise<Blob | null> — a fresh JPEG of the viewport

  // Publish · play · remix seams — v3 (roadmap #28-A), see "4. Publish, play, remix"
  api.buildSceneBundle(opts)       // Promise<{blob, meta}> — the open scene as a .tpscene
  api.loadRemoteScene(entry)       // Promise<boolean> — a remote .tpscene into the editor
  api.camera.pose() / setPose(p) / bookmarks() / recall(id)
  api.startPlay() / api.stopPlay()
  api.setCommunityProvider(p)      // swap the Templates ▸ Community source (null restores GitHub)

  api.toast(message)
}
```

Every member added after v1 is **additive**: probe it with `typeof` and the plugin keeps
working against an older engine. When a plugin *depends* on a member, it declares the
contract it needs (`export const compatibleHooks = 3`) and the loader fails closed on an
older engine — see "Versioning" below.

## The seams

### 1. Capability gate — `canApply(peerId, msgType)`

One choke point at the top of `conn.on('data')` in
[src/lib/peerHandler.svelte.js](src/lib/peerHandler.svelte.js): a message is applied
only if `canApply(sender, type)` is true. Default (no provider) = allow everything.
A plugin's provider returns `false` to drop a sender's message types — this is the
**receive-side** layer role enforcement needs (a viewer's mutations never apply,
even if they send them).

A small floor of connection/handshake types is **always allowed** regardless of the
provider (`hosts`, `userdata`, `locked`, and the `get*` late-join requests) so a
plugin can never brick the mesh. A throwing provider is treated as allow, same
reason. Everything above the floor is the provider's decision (keyed on the
**sender's** role).

Pair it with **send-side** gating in the plugin UI (disable a viewer's gizmos/menus)
so the app doesn't merely swallow actions silently.

Worked example — scene wipe: `{ type: 'clearscene' }` is deliberately **not** in the
always-allowed floor, so a roles provider can drop it from viewers (the reference
cloud plugin's viewer allowlist already excludes it). Core pairs that with its own
send-side gate: a viewer pressing *Clear scene* gets the view-only toast instead of
clearing — a local clear whose broadcast peers drop would silently desync the viewer.
The gate lives in [src/lib/objectPermissions.js](src/lib/objectPermissions.js)
consumers and is inert without a plugin (`isViewer()` is false when no `rolesInfo`
is published).

### 2. Identity / auth hook — `authorize(peerId)`

Consulted in `handleConnection` when an unknown peer connects: if the auth provider's
`authorize(peerId)` returns true, the peer is accepted without a manual Approve.
Default (no provider) keeps the whitelist + approval flow byte-identical. `authorize`
is a synchronous lookup against state the plugin maintains from its own async login.

### 3. UI mount points

Roles replicate over the **plugin message channel**: an admin broadcasts the roles
map with `sendCloud(payload)`; every peer's plugin applies it via `onCloudMessage`
and updates its capability provider. Core routes `{ type:'cloud', payload }` and
never gates it (it's in the always-allowed floor), so role updates always arrive.

`mountConnect` / `mountUsersSection` / `mountProfile` / `mountConnectDrawer` /
`mountSidebar` hand the plugin a DOM node (via
[CloudSlot.svelte](src/components/CloudSlot.svelte)) and an optional cleanup fn, so a
separately-built plugin owns its own rendering with no coupling to the app's
framework version. The `appNotice` store (the first-run banner) is a ready-made
shared-state seam a plugin can rebrand or clear.

### 4. Publish, play, remix — `cloudApi` v3 (roadmap #28-A)

Seven seams so a community tier (publish a scene, open a published one, remix it) can be
built entirely in a plugin. Each is inert without one; none of them adds a peer message
type — publishing is an upload, a remix is a local load.

#### `buildSceneBundle({ assets = true, flow = true, name } = {}) → Promise<{ blob, meta }>`

The open scene as a `.tpscene` — the SAME payload builder and zip writer Save uses
(`sessions.buildSessionPayload` → `exportSessionZip`, packs never bundled), so a published
file is exactly a saved one. It never saves, names or renames anything locally: publish is a
*copy out*. `name` is the file's own name and defaults to the open scene's name, else
`'Untitled'`.

`blob` is `application/zip`. `meta` is read out of the payload the bundle was built from:

| field | meaning |
|---|---|
| `objectCount` | number — top-level objects in the scene (`payload.count`) |
| `hasFlow` | boolean — **any graph has nodes** (every scene carries an empty `graphs.scene`, so "a graph exists" is never the test); `false` when `flow: false` |
| `hasAudio` | boolean — a music track, a cable patch, or any node of the audio family (the catalog's Music group + `sound`, read at build time) |
| `hasGame` | boolean — the scene carries a game shell |
| `modules` | `{id, version}[]` — the modules the scene needs (the handshake's shape); `[]` when `flow: false` |
| `appVersion` | string — the app that built it |
| `bytes` | number — `blob.size` |
| `camera` | `{position: [x,y,z], target: [x,y,z]}` \| null — the editor view at build time |
| `duration` | number \| null — seconds: the music track's length, else the longest authored clip, else null |
| `files` | `sessionFileList(payload)` — the file rows a "what is big" toast lists |

#### `loadRemoteScene({ sceneUrl, title?, slug?, modules? }) → Promise<boolean>`

Fetch a remote `.tpscene` and load it through the existing session path: the viewer gate,
the format confirm, the "Backup before <name>" stash, the replicated clear+rebuild and the
peer-consent proposal all apply. This is "Open in ThePrototype" and "Remix". Resolves
`true` when the scene was applied; `false` when refused, declined or failed (the user
already saw why).

#### `camera`

For the hero shot (recall a bookmark → `captureThumbnail` → restore) and for storing the
pose **on the published record** — bookmarks live in localStorage only and never travel
with the file. Every call answers `null`/`false` before the renderer exists and in VR.

| member | contract |
|---|---|
| `pose()` | `{position: number[3], target: number[3], fov: number \| null} \| null` — the current editor view. `fov` is additive: hand the whole object back to `setPose` to restore a lens a `recall` changed |
| `setPose({position, target, fov?})` | boolean — moves the editor camera **instantly** (no tween; a capture may follow on the next frame). Writes both ends and updates the controls; bumps the camera claim so any continuous driver steps aside |
| `bookmarks()` | `{id, name}[]` — the saved views, for a "Camera" dropdown |
| `recall(id)` | boolean — jump to a saved view (position, target, saved FOV; the saved clip planes are a persisted local preference and are left alone). **`false` when the bookmark is gone** (deleted since the dropdown rendered) — fall back to the current view and say so |

#### `startPlay() → boolean` · `stopPlay() → boolean`

The Controls button's own press and the canonical exit, so `/?s=<id>&play=1` can land in
play mode after its load. Browsers grant a pointer **lock** only inside a user gesture:
called from a boot deep link the mode still holds (a refused lock never exits play) and
the pointer locks on the player's first click. `stopPlay` returns `true` when we were
playing.

#### `mountSidebar(fn)`

A `CloudSlot` rendered **directly under the Save row's format segment** in the logo menu
(`Sidebar.svelte`) — the Publish row must sit beside Save or nobody finds it. Mount fn:
`(el) => cleanup`; `null` unmounts. Render a plain
`<button class="side-row"><span class="side-ico">…</span><span>Publish</span></button>` —
the sidebar republishes its row look under the slot, so a foreign button reads as a native
row (`#sidebar-cloud-slot` wraps it). Nothing renders without a plugin.

#### `setCommunityProvider(provider | null)`

Swap the Templates modal's **Community** tab source. Core never learns what is behind the
provider; `null` restores the PR-gated GitHub gallery (a logout must be able to take the
swap back). The card shape is the gallery's, plus four optional fields the card renders
only when present:

```js
api.setCommunityProvider({
  // REQUIRED. The rows to show; core normalizes them. Return [] for the empty state, throw
  // for the error state (the Retry button calls list({force: true})).
  list: async ({ force }) => [{
    slug, title, description, author, license, tags, modules,   // the gallery.json fields
    bytes,                                                       // number, for the size label
    scene, thumb,          // OR sceneUrl, thumbUrl — absolute URLs pass through untouched
    id, href, likeCount, remixOf   // optional: record id, page URL, ♥ count, {id, title?, href?}
  }],
  // REQUIRED. A card click. Return true when the scene was applied (the provider may
  // simply call api.loadRemoteScene(entry)).
  load: async (entry) => api.loadRemoteScene(entry),
  // OPTIONAL. ONE quiet row above the grid; null for none. Re-read on every list().
  notice: () => ({ text: 'Signed in as …', href: 'https://…' }),
  // OPTIONAL. Replaces "Submit yours on GitHub" — a link (href) or an in-app action.
  submit: { label: 'Publish this scene', action: () => openPublishDialog() }
})
```

A provider swap while the tab is showing re-lists from the new source; anything without a
`list` function reads as `null`. While a provider is installed the tab's pull-request copy
stands down (it would be a claim about a source core knows nothing about).

#### Deep links: `?s=<id>`

Published scenes deep-link through the **query string** (`/?s=<id>[&play=1][&remix=1]`)
so they never collide with an invite's `#<peerId>` hash. Core reads only the *presence*
of `s` (`whatsNew.hasDeepLink()`): the first-run welcome overlay stands down for that
boot exactly as it does for an invite. What the id means, fetching the record, loading it
(`loadRemoteScene`) and honouring `play=1` (`startPlay`) are the plugin's.

## Versioning

`CLOUD_HOOKS_VERSION` ([src/lib/cloudHooks.js](src/lib/cloudHooks.js)) is the contract
version and `api.version` reports it. A plugin declares the contract it needs with
`export const compatibleHooks = N`; the loader refuses to register (toast, local mode)
when `N` is **newer** than the engine, and a new engine always accepts an older plugin
(every hook is inert without a consumer). History: 1 (M1) · 2 (roadmap #14: profile and
drawer mounts, roles bridge) · **3 (roadmap #28-A: the publish · play · remix seams above)**.
A coupled change therefore deploys the engine first and the plugin after.

## Rules for plugin authors

- **Never trust the sender.** The capability gate is receive-side truth; send-side UI
  is only ergonomics.
- Keep the provider cheap and non-throwing — `canApply` runs on every inbound message.
- Dynamic-load only; a plugin is a *separate* build. Don't add a static import of
  plugin code into the engine (bundle + module-cycle reasons).
