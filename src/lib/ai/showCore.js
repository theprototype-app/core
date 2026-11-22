// Roadmap 104 C2 — `show`, the pure half (a LEAF: imports nothing). showTool.js drives the interface.
//
// `show` acts on the screen of the person the assistant acts for, and nobody else's: it has no peer
// argument at all. Its eight safety rules (scout report row 7c) and where each one lives:
//   1 own tab only; headless agent pages do not get the tool        (personTools.js / tpAgent)
//   2 a deny-list: never sign-in, consent, Publish, Connected apps, account, payment surfaces   DENIED / deniedPanel()
//   3 the first use of each kind asks once (Always / This time / No), stored per device          showTool.js + SHOW_KINDS
//   4 every action leaves a line the person can act on: "Claude moved your view · Back"          showTool.js
//   5 no camera move in a headset (this release)                                                 showTool.js
//   6 reduced motion: an instant cut (flyTo's motionMs)                                           objectActions.flyTo
//   7 6 calls a minute, one camera move per 2 s, refused while the person drags or types          SHOW_PER_MINUTE / CAMERA_GAP_MS
//   8 editing text stays files {write}: show {code} only opens, goes to a line and selects        (no text argument)

/** the kinds the person is asked about, once each */
export const SHOW_KINDS = /** @type {const} */ (['panel', 'camera', 'code']);
export const SHOW_PER_MINUTE = 6;
export const CAMERA_GAP_MS = 2000;
export const FLY_MS = 600;

/** what the first-use question says, per kind */
export const KIND_WORDS = /** @type {Record<string, string>} */ ({
	panel: 'open and close your panels',
	camera: 'move your view',
	code: 'open code for you'
});

/**
 * The panels `show` may open, close or bring forward — the allow-list. `key` is the app's own key
 * (panelToggles / dockHost), `via` how it opens.
 * @type {Record<string, {key: string, label: string, via: 'toggle' | 'hosted' | 'inspector' | 'chat'}>}
 */
export const SHOW_PANELS = {
	explorer: { key: 'explorer', label: 'Explorer', via: 'toggle' },
	objects: { key: 'objects', label: 'Objects', via: 'toggle' },
	inspector: { key: 'inspector', label: 'Inspector', via: 'inspector' },
	flow: { key: 'flow', label: 'Flow editor', via: 'toggle' },
	code: { key: 'code', label: 'Code', via: 'toggle' },
	timeline: { key: 'timeline', label: 'Timeline', via: 'toggle' },
	assets: { key: 'assets', label: 'Assets', via: 'hosted' },
	preview: { key: 'preview', label: 'Preview', via: 'hosted' },
	chat: { key: 'chat', label: 'Chat', via: 'chat' },
	assistant: { key: 'chat', label: 'Assistant', via: 'chat' }
};

/** other words people use for them */
const ALIASES = /** @type {Record<string, string>} */ ({
	library: 'explorer',
	files: 'explorer',
	'file explorer': 'explorer',
	outliner: 'objects',
	'object list': 'objects',
	hierarchy: 'objects',
	properties: 'inspector',
	'properties panel': 'inspector',
	'node editor': 'flow',
	nodes: 'flow',
	'flow graph': 'flow',
	'flow editor': 'flow',
	behaviours: 'flow',
	'code editor': 'code',
	'code workspace': 'code',
	scripts: 'code',
	animation: 'timeline',
	sequencer: 'timeline',
	'asset browser': 'assets',
	'free assets': 'assets',
	'file preview': 'preview',
	'session chat': 'chat',
	'ai assistant': 'assistant',
	ai: 'assistant'
});

/** surfaces `show` never opens or presses (rule 2): named so the refusal can say what was asked */
export const DENIED = [
	'sign in',
	'sign-in',
	'signin',
	'log in',
	'login',
	'account',
	'profile',
	'consent',
	'privacy',
	'publish',
	'export',
	'connected apps',
	'connect claude',
	'connector',
	'payment',
	'billing',
	'subscription',
	'settings',
	'roles',
	'permissions',
	'invite',
	'approve'
];

/** @param {string} name @returns {string} lower-case, single-spaced, no "panel"/"window" */
export function normalName(name) {
	return String(name ?? '')
		.toLowerCase()
		.replace(/[_-]+/g, ' ')
		.replace(/\b(panel|window|tab|view)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** the allow-listed panel a name means, or null @param {string} name */
export function panelOf(name) {
	const n = normalName(name);
	if (SHOW_PANELS[n]) return n;
	if (ALIASES[n]) return ALIASES[n];
	return null;
}

/** is this a surface rule 2 keeps closed @param {string} name */
export function deniedPanel(name) {
	const n = normalName(name);
	return DENIED.some((d) => n === d || n.includes(d));
}

/**
 * Where the camera goes to frame a box, keeping the view direction (objectActions.focusObject's
 * framing): `dir` points from the target to the camera.
 * @param {{center: number[], radius: number}} box @param {number} fovDeg @param {number[]} dir unit vector
 * @returns {{position: number[], target: number[], distance: number}}
 */
export function frameBox(box, fovDeg, dir) {
	const fov = (Math.max(10, Math.min(120, Number(fovDeg) || 50)) * Math.PI) / 180;
	const radius = Math.max(0.5, Number(box.radius) || 0.5);
	const distance = Math.max(1, Math.min(200, (radius / Math.tan(fov / 2)) * 1.2));
	const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
	const d = [dir[0] / len, dir[1] / len, dir[2] / len];
	const c = box.center;
	return { position: [c[0] + d[0] * distance, c[1] + d[1] * distance, c[2] + d[2] * distance], target: [c[0], c[1], c[2]], distance };
}

/** @param {any} v @returns {v is number[]} */
export const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * Where `find` text is in a document: the first hit's [line, col] range (1-based lines, 0-based
 * columns), or null.
 * @param {string} text @param {string} find @param {number} [fromLine]
 * @returns {{from: [number, number], to: [number, number]} | null}
 */
export function findRange(text, find, fromLine = 1) {
	const needle = String(find ?? '');
	if (!needle) return null;
	const lines = String(text ?? '').split('\n');
	const start = Math.max(1, Math.floor(fromLine) || 1);
	for (let pass = 0; pass < 2; pass++) {
		const lo = pass === 0 ? start : 1;
		const hi = pass === 0 ? lines.length : start - 1;
		for (let n = lo; n <= hi; n++) {
			const col = lines[n - 1].indexOf(needle);
			if (col >= 0 && !needle.includes('\n')) return { from: [n, col], to: [n, col + needle.length] };
		}
	}
	// a multi-line needle: search the whole text
	const at = String(text ?? '').indexOf(needle);
	if (at < 0) return null;
	const before = String(text).slice(0, at).split('\n');
	const inside = needle.split('\n');
	const fromL = before.length;
	const fromC = before[before.length - 1].length;
	const toL = fromL + inside.length - 1;
	const toC = inside.length === 1 ? fromC + needle.length : inside[inside.length - 1].length;
	return { from: [fromL, fromC], to: [toL, toC] };
}
