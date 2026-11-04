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
export const TP_AGENT_VERSION = '1.7.0';

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
	'leave',
	// 1.3.0 (roadmap 56): the chat — what people type to the agent in the AI assistant window
	'nextMessage',
	'abortWait',
	'requeue',
	'reply',
	'ask',
	'chatStatus',
	'thread'
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
 * @property {boolean} joined true when this page can act in its session: on an agent page once a host admitted it (approval
 *   or invite), the link is open and (cloud) the host's roles have arrived, so `role`/`canEdit` are final. In a person's own
 *   tab (the connector) their own session counts, alone or hosting, so `host` is null and `joined` is true. An edit runs
 *   only while this is true
 * @property {boolean} waiting true while a join request is out and unanswered. Never true together with `joined`: while a
 *   request is out this page is not joined, and an edit is refused until it is
 * @property {'admin'|'editor'|'viewer'|null} role null = no roles in this build (everyone edits)
 * @property {boolean} canEdit false for a viewer: `exec` refuses every edit
 * @property {{id: string, name: string}[]} peers peers with an open connection
 * @property {TpAgentMissingTool[]} missingTools tools this page cannot offer, and why
 * @property {TpAgentMissingModule[]} missingModules modules peers run that this page lacks
 * @property {number} pendingOffers questions waiting for an answer (`pendingOffers()`)
 * @property {boolean} inVR an immersive session is running (screenshot returns null)
 * @property {string} [scene] 1.1: the scene this page stands in ('' = the session's unnamed world)
 * @property {string} [hostScene] 1.1: the scene the host stands in ('(private)' when it is private)
 * @property {boolean} [withHost] 1.1: same room as the host. False after the host traveled (a Save as, another
 *   scene): `exec` refuses edits — they would not reach the host — until the agent has followed
 * @property {boolean} [following] 1.1: traveling to the host's scene now
 * @property {boolean} [loading] 1.2: a scene is still arriving (right after a join, or a travel/follow): what
 *   list_scene shows is partial until it is false
 * @property {{arrived: number, total: number}} [objects] 1.2: while `loading`, how many of the scene's objects are here
 * @property {{host: string, since: number, until: number, expired: boolean}} [hostAway] 1.2: the host LEFT and no person
 *   is here: the agent is paused (edits refused, `withHost` false), knocks on the host's door until `until`, never
 *   hosts and never saves. When a person remains instead, it continues with the room's successor (`host` changes).
 * @property {{node: string, message: string}[]} [scriptErrors] mcp-fix: Script nodes failing now (their code threw, or it was paused for being slow)
 * @property {{name: string, where: string, message: string}[]} [behaviourErrors] 1.2: the latest errors thrown by
 *   the scene's code behaviours (on whichever peer runs them); absent when none — fix with edit_behaviour
 * @property {{tier: string, profile: 'desktop'|'vr', objects?: number, meshes?: number, triangles?: number, calls?: number, textures?: number, lights?: number, frameP95?: number, over?: string[], top?: {byTriangles: {uuid: string, name: string, triangles: number, calls: number}[], byCalls: {uuid: string, name: string, triangles: number, calls: number}[]}, vsync?: {onVsync: boolean, hz: number, say: string}}} [sceneBudget]
 *   1.6.0 (mcp-shapes): how heavy the scene is — the Statistics overlay's numbers, the worst tier (green | amber | red |
 *   unknown) on the profile it is judged by, and `over` = each budget past green
 * @property {{level: string, text: string, at: number}[]} [logs] 1.7.0 (roadmap 85b, R3): the newest errors, warnings
 *   and toasts on this page (at most 5; the `logs` tool returns the rest); absent when there are none
 * @property {{status: 'listening'|'working'|'away', muted: boolean, queued: number, waiting: number, current: any, chatId: string|null}} [chat]
 *   1.3.0 (roadmap 56): the chat inbox — the badge people see, requests waiting, the running request
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
 * @property {string} [uuid] the object to frame (`focus` needs this or `uuids`)
 * @property {string[]} [uuids] objects to frame together
 * @property {string|{yaw: number, pitch: number}} [from] the angle around the subject, instead of `view`: front, back, left, right, top, below, iso, or degrees
 * @property {{position: number[], target: number[]}} [camera] a free camera, instead of `view` and `from`
 * @property {string|number} [aspect] width to height, default 4:3 ('current' defaults to the person's canvas)
 * @property {number} [zoom] above 1 is closer, 0.1 to 10
 * @property {number} [margin] room around the subject: 1 touches the frame, default 1.15
 * @property {number} [size] longest side in px (default 768, max 2048)
 * @property {boolean} [grid] draw the grid (default false)
 * @property {boolean} [postEffects] draw the frame through the post stack this tab draws (bloom, vignette, grade …);
 *   lastShot().postEffects then says "applied" or "unavailable" with a reason (mcp-diorama2)
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
 * @property {() => any} lastShot what the last screenshot used: position, target, fov, zoom, width, height, view, subject; or {error}
 * @property {(opts?: TpAgentScreenshotOptions) => Promise<string|null>} screenshot a `data:image/png;base64,…`
 *   frame from a temporary camera (no gizmos, selection or helpers); null in VR or with no renderer
 * @property {() => TpAgentOffer[]} pendingOffers
 * @property {(id: string, action?: string) => {ok: boolean, error?: string}} accept press an offer's button
 *   (the first one when `action` is omitted)
 * @property {() => Promise<void>} leave say goodbye to every peer and close the connections
 * @property {(timeoutMs?: number, token?: string) => Promise<TpAgentChatMessage|null>} nextMessage 1.3.0: the
 *   next request typed to this agent, or null after the timeout (max 10 min). While a wait is armed the agent's
 *   badge says `listening`; once one is delivered, `working` until the final reply.
 * @property {(token: string) => boolean} abortWait 1.3.0: give up the wait `token` armed (resolves it null)
 * @property {(msg: TpAgentChatMessage) => boolean} requeue 1.3.0: put a delivered request back (its result never
 *   reached the agent's model)
 * @property {(o: TpAgentReply) => {ok: boolean, id?: string, chatId?: string, error?: string, cancelled?: boolean}} reply
 *   1.3.0: say something in the chat; repeated calls grow ONE streamed reply until `final`
 * @property {(o: {to?: string, question: string, options?: string[], chatId?: string}) => {ok: boolean, id?: string, error?: string}} ask
 *   1.3.0: buttons in the window; the click arrives as a request whose `answers` is the returned id
 * @property {(status: 'listening'|'working'|'away'|null, meta?: {mode?: 'mcp'|'repl', model?: string}) => {ok: boolean, status: string}} chatStatus
 *   1.3.0: pin the badge (null = derive it from the waits); `meta` labels the agent in the window ("agent via MCP",
 *   "<model> · agent REPL")
 * @property {(o: {chatId?: string, before?: string, limit?: number}) => Promise<{chatId: string|null, messages: TpAgentChatEntry[], more: boolean}>} thread
 *   1.3.0: a page of a chat, oldest first (`before` = a message id)
 *
 * 1.3.0 also gates `exec` by the running request: after Stop every call answers `{error:'cancelled', cancelled:true}`
 * until the next request, and while a VIEWER's request runs every edit answers `{error, refused:true, role:'viewer'}`.
 */

/**
 * A request typed to the agent (roadmap 56). `role` is the sender's role as THIS page knows it.
 * @typedef {object} TpAgentChatMessage
 * @property {string} id
 * @property {string} chatId
 * @property {string} from the sender's peer id
 * @property {string} [name]
 * @property {'admin'|'editor'|'viewer'} role
 * @property {string} text
 * @property {{mimeType: string, data: string, name?: string, w?: number, h?: number}[]} [images] base64, already
 *   downscaled and EXIF-stripped by the sender; never present on a viewer's request
 * @property {boolean} [imagesDropped] a viewer attached images and they were dropped
 * @property {string} [answers] the `ask` id this message answers
 * @property {number} at
 * @property {TpAgentChatEntry[]} [history] on the first request in a chat other than the last one: its newest 20 messages
 * @property {string} [summary] and a few lines about the whole of it
 * @property {number} [olderMessages] how many more `thread` can page back to
 */

/**
 * One line of a chat's history (no image bytes).
 * @typedef {{id: string, from: string, name?: string, role?: string, text: string, via?: 'cli', kind?: 'terminal'|'ask', at: number, replyTo?: string, images?: {mimeType: string, name?: string}[]}} TpAgentChatEntry
 */

/**
 * `reply` options. `text` adds a paragraph; `delta` appends raw text (token streaming). `prompt` first posts the
 * user's own words typed in the agent's terminal (shown "via terminal"). Without a running app request the
 * reply itself is tagged `via:'cli'`.
 * @typedef {{to?: string, text?: string, delta?: string, final?: boolean, chatId?: string, replyTo?: string, via?: 'cli', prompt?: string}} TpAgentReply
 */

export {};
