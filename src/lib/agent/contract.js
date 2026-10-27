// Roadmap 55 A2 — THE `window.tpAgent` CONTRACT. A supported, semver'd in-page API an external agent
// (the 55-bridge MCP server, a Playwright script, anything that can evaluate JS in the page) drives the
// app through. It exists ONLY when the URL carries `&agent` (`#F0FD3&agent`) or safeStorage holds
// `agentApi` (agentMode.js), and its implementation is a dynamic import (tpAgent.js) — a session that
// did not ask for it carries none of it.
//
// This file is the contract and nothing else: the version, the method list and the JSDoc shapes. It
// imports nothing, so the bridge (or a test) can read it without the app.
//
// SEMVER: a new method or a new optional field = minor; a removed/renamed method or a changed shape =
// major. The bridge feature-detects methods, so an older bridge keeps working against a newer page.

/** The contract version (`tpAgent.version`). */
export const TP_AGENT_VERSION = '1.0.0';

/** Every method of the contract, in the order the docs list them. */
export const TP_AGENT_METHODS = /** @type {const} */ ([
	'tools',
	'systemPrompt',
	'exec',
	'snapshot',
	'status',
	'waitForEdit',
	'screenshot',
	'pendingOffers',
	'accept',
	'leave'
]);

/** Camera views `screenshot` renders from (A5). */
export const SCREENSHOT_VIEWS = /** @type {const} */ (['current', 'top', 'front', 'iso', 'focus']);

/** Largest side a screenshot may ask for (px); `size` is clamped to it. */
export const SCREENSHOT_MAX_SIZE = 2048;
/** Side used when `size` is omitted. */
export const SCREENSHOT_DEFAULT_SIZE = 768;

/**
 * One tool, OpenAI function shape — exactly what the in-app assistant sends its model (`getAiTools()`),
 * `parameters` is a full JSON Schema.
 * @typedef {{type: 'function', function: {name: string, description: string, parameters: object}}} TpAgentTool
 */

/**
 * Why a tool is not offered right now.
 * @typedef {{name: string, reason: string}} TpAgentMissingTool
 */

/**
 * A module the session's other peers run that this page does not have (or has at another version).
 * @typedef {{id: string, version: string, have?: string, inGallery?: boolean}} TpAgentMissingModule
 */

/**
 * `status()` — who and where the agent is.
 * @typedef {object} TpAgentStatus
 * @property {string} version contract version (TP_AGENT_VERSION)
 * @property {string} appVersion the app's own version (APP_VERSION)
 * @property {string|null} peerId this page's peer id (null before signaling opens)
 * @property {string|null} host the peer whose session we joined (null = not joined / we host)
 * @property {boolean} joined true once a host admitted us (approval or invite), the link is open and (cloud) the
 *   host's roles have arrived, so `role`/`canEdit` are final
 * @property {boolean} waiting true while a join request waits for the host's Approve
 * @property {'admin'|'editor'|'viewer'|null} role null = no roles in this build (everyone edits)
 * @property {boolean} canEdit false for a viewer: `exec` refuses every edit
 * @property {{id: string, name: string}[]} peers peers with an open connection
 * @property {TpAgentMissingTool[]} missingTools tools this page cannot offer, and why
 * @property {TpAgentMissingModule[]} missingModules modules peers run that this page lacks
 * @property {number} pendingOffers questions waiting for an answer (`pendingOffers()`)
 * @property {boolean} inVR an immersive session is running (screenshot returns null)
 */

/**
 * A question the app asked this page that a person would answer with a button (an admin-role
 * offer, a "join their scene?" card…). Kept until answered, unlike the toast that showed it.
 * @typedef {{id: string, text: string, actions: string[], at: number}} TpAgentOffer
 */

/**
 * `waitForEdit` result.
 * @typedef {{changed: true, at: number} | {changed: false, timedOut: true}} TpAgentEditWait
 */

/**
 * `screenshot` options.
 * @typedef {object} TpAgentScreenshotOptions
 * @property {'current'|'top'|'front'|'iso'|'focus'} [view] default 'iso'
 * @property {string} [uuid] the object `focus` frames (required for 'focus')
 * @property {number} [size] longest side in px (default 768, max 2048)
 * @property {boolean} [grid] draw the grid (default false)
 */

/**
 * The object at `window.tpAgent`.
 * @typedef {object} TpAgent
 * @property {string} version
 * @property {() => TpAgentTool[]} tools the live tool list with full JSON schemas (A2 + A6)
 * @property {() => string} systemPrompt the in-app assistant's guidance, for the agent's model
 * @property {(name: string, args?: any) => Promise<any>} exec run one tool — replicated, ONE undo step;
 *   a viewer gets `{error, refused: true}`; never throws
 * @property {(cap?: number) => any} snapshot the scene as the assistant sees it (objects, flows, behaviours, joints)
 * @property {() => TpAgentStatus} status
 * @property {(timeoutMs?: number) => Promise<TpAgentEditWait>} waitForEdit resolves on the next scene change
 * @property {(opts?: TpAgentScreenshotOptions) => Promise<string|null>} screenshot a `data:image/png;base64,…`
 *   frame from a temporary camera (no gizmos, selection or helpers); null in VR or with no renderer
 * @property {() => TpAgentOffer[]} pendingOffers
 * @property {(id: string, action?: string) => {ok: boolean, error?: string}} accept press an offer's button
 *   (the first one when `action` is omitted)
 * @property {() => Promise<void>} leave say goodbye to every peer and close the connections
 */

export {};
