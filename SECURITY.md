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
- The app executes replicated script/flow content deterministically on every
  peer. Escapes from that sandboxed evaluation are in scope and serious.
- Self-hosted infrastructure (signaling server, TURN) has its own repo; reports
  welcome at the same address.

## Supported versions

The live app at theprototype.app always runs the latest release; only the
latest release line receives security fixes.
