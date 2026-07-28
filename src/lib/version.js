// App version identity (V1). Baked at build time by vite `define` in vite.config.ts:
// __APP_VERSION__ = package.json version (bumped by `npm version`, see RELEASING.md),
// __COMMIT_SHA__ = `git rev-parse --short HEAD` of the checkout that built.
//
// ZERO-IMPORT LEAF on purpose: peerHandler, moduleSDK, sessions and UI components all
// read it, and any import here could close one of the history.js/moduleSDK cycles.
// The typeof guards keep it safe under a bare vitest/node import where define never ran.

/** @type {string} */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** @type {string} */
export const COMMIT_SHA = typeof __COMMIT_SHA__ === 'string' ? __COMMIT_SHA__ : 'unknown';

/** True under `vite dev` — used to mark the version string and skip update polling. */
export const IS_DEV = !!import.meta.env?.DEV;

/**
 * Human-readable version for About / logs: `1.0.0 (abc1234)`, `1.0.0-dev (abc1234)` in dev.
 * @returns {string}
 */
export function versionString() {
	return APP_VERSION + (IS_DEV ? '-dev' : '') + ' (' + COMMIT_SHA + ')';
}
