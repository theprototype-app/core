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
  api.version                      // contract version (currently 1)

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

  api.toast(message)
}
```

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

`mountConnect` / `mountUsersSection` hand the plugin a DOM node (via
[CloudSlot.svelte](src/components/CloudSlot.svelte)) and an optional cleanup fn, so a
separately-built plugin owns its own rendering with no coupling to the app's
framework version. The `appNotice` store (the first-run banner) is a ready-made
shared-state seam a plugin can rebrand or clear.

## Rules for plugin authors

- **Never trust the sender.** The capability gate is receive-side truth; send-side UI
  is only ergonomics.
- Keep the provider cheap and non-throwing — `canApply` runs on every inbound message.
- Dynamic-load only; a plugin is a *separate* build. Don't add a static import of
  plugin code into the engine (bundle + module-cycle reasons).
