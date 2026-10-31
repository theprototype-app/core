# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email
**hello@theprototype.app** (or use GitHub's private vulnerability reporting on
this repository) with steps to reproduce. You'll get a response within a few
days; fixes ship as fast as severity demands and reporters get credit in the
release notes unless they prefer otherwise.

## Scope notes for a P2P app

- Sessions are invite-only: a peer must be approved before it can send anything,
  and incoming message types are gated. Bypasses of the approval gate, or any
  way for an unapproved peer to mutate a scene, are in scope and serious.
- WebRTC exposes peer IP addresses to session members by design (disclosed in
  the privacy policy). Reports about that design are out of scope; ways to learn
  peers' addresses **without** being approved into the session are in scope.
- Code that travels with a scene — Script nodes, custom node definitions, the
  Character Controller's player code, behaviour files and custom HUD elements —
  runs inside a separate JavaScript engine compiled to WebAssembly (QuickJS). It
  has no access to the page: no DOM, storage, cookies, network, timers or
  `import()`. It reaches the scene only through the script API (object views,
  variables, events, raycasts, the HUD element proxy), each call has a time
  limit, and a custom HUD element's output is rebuilt through an allowlist
  sanitizer (no scripts, event handlers or remote URLs). Any way for scene
  content to run code in the page, read app storage (AI keys, the login token,
  autosaves) or send data off the machine is in scope and serious.
- **Installed modules are not sandboxed.** Installing a module (a zip or a URL
  in the Modules manager) runs its code in the page with the same rights as the
  app — install only modules you trust. A scene that needs a module asks first,
  and only offers modules listed in the module gallery.
- Credentials (AI, mesh and speech-to-text keys) are stored per device in the
  browser's localStorage. They are never written into scenes, `.tp` projects,
  layouts, shares or the diagnostics bundle. Production builds ship a Content
  Security Policy; a self-hoster can extend it (see `docs` / `.env.example`).
- Self-hosted infrastructure (signaling server, TURN) has its own repo; reports
  welcome at the same address.

## Supported versions

The live app at theprototype.app always runs the latest release; only the
latest release line receives security fixes.
