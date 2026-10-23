// 50-window (C1) — the code workspace in its OWN browser window, for a second monitor.
// Productises 36-code's spike (plan 75.5): the same SAME-ORIGIN `about:blank` popup, so it
// shares this JS realm — every store, the Yjs document, the flow runtime and the save path
// are the very objects the main window uses, and NOTHING has to be bridged. A second
// CodeWorkspace instance is `mount`ed into the popup's <body> (`popped: true`); while it
// lives, the main window's workspace closes itself (its dock tab frees the screen).
//
// Three things a popup does NOT inherit, and that this module therefore owns:
//  1. STYLES — every <style>/<link rel=stylesheet> of the main <head> is mirrored into the
//     popup and kept in step (vite HMR rewrites style text, lazy chunks add links);
//  2. THE THEME — the tokens hang off <html>/<body> attributes (data-theme, the UI scale),
//     mirrored the same way, so a theme switch in the main window repaints the popup;
//  3. EVENT DELEGATION — svelte delegates `onclick` & co. to the mount TARGET, and `mount`
//     with target = the popup <body> registers exactly that root (portaled menus included,
//     since ContextMenu portals into its own node's document).
//
// Lifetime: closing the popup (its ✕, or "Dock back") unmounts it and re-opens the editor
// docked where it was; closing / reloading the MAIN tab closes the popup (the realm it runs
// on is going away). A blocked popup says so with a Try again button (a toast action is a
// user gesture, so the retry is allowed to open a window). Desktop only — `popOutSupported`
// is false on a phone shell, a coarse pointer and in VR, and the buttons hide with it.

import { writable, derived, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { phoneShellActive } from './ui/phoneShell.js';
import { isVRMode } from '../stores/sceneStore.js';
import { codeWorkspaceClose, showToast } from '../stores/appStore.js';

const RECT_KEY = 'code:popoutRect';
const WINDOW_NAME = 'tp-code-popout';

/** true while the workspace lives in its own window */
export const codePoppedOut = writable(false);

const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
/** the Pop out button shows only where a second window makes sense */
export const popOutSupported = derived([phoneShellActive, isVRMode], ([phone, vr]) => !phone && !vr && !coarse && typeof window !== 'undefined' && typeof window.open === 'function');

/** @type {Window | null} */
let win = null;
/** @type {any} */
let instance = null;
/** @type {(() => void)[]} */
let teardown = [];
let opening = false;

/** @returns {{left?: number, top?: number, width: number, height: number}} */
function storedRect() {
	try {
		const r = JSON.parse(safeStorage.getItem(RECT_KEY) ?? 'null');
		if (r && r.width > 200 && r.height > 150) return r;
	} catch {
		/* a bad record reads as none */
	}
	return { width: 900, height: 640 };
}

/** @param {Window} w */
function rememberRect(w) {
	try {
		safeStorage.setItem(RECT_KEY, JSON.stringify({ left: w.screenX, top: w.screenY, width: w.outerWidth, height: w.outerHeight }));
	} catch {
		/* a closed window can refuse the read — keep the last good rect */
	}
}

/** mirror the main <head>'s stylesheets into `doc`, live @param {Document} doc */
function mirrorStyles(doc) {
	/** source node -> its clone in the popup @type {Map<Element, HTMLElement>} */
	const clones = new Map();
	const sync = () => {
		const sources = [...document.head.querySelectorAll('style, link[rel="stylesheet"]')];
		const live = new Set(sources);
		for (const [src, clone] of clones) {
			if (live.has(src)) continue;
			clone.remove();
			clones.delete(src);
		}
		for (const src of sources) {
			const held = clones.get(src);
			if (!held) {
				const clone = /** @type {HTMLElement} */ (doc.importNode(src, true));
				clone.setAttribute('data-tp-mirror', '');
				doc.head.appendChild(clone);
				clones.set(src, clone);
			} else if (src.nodeName === 'STYLE' && held.textContent !== src.textContent) held.textContent = src.textContent;
			else if (src.nodeName === 'LINK' && held.getAttribute('href') !== src.getAttribute('href')) held.setAttribute('href', src.getAttribute('href') ?? '');
		}
	};
	sync();
	const mo = new MutationObserver(sync);
	mo.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
	return () => mo.disconnect();
}

/** keep `to`'s attributes equal to `from`'s (the theme + UI-scale hooks) @param {Element} from @param {Element} to */
function mirrorAttributes(from, to) {
	const sync = () => {
		for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
		for (const a of [...from.attributes]) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
	};
	sync();
	const mo = new MutationObserver(sync);
	mo.observe(from, { attributes: true });
	return () => mo.disconnect();
}

function blocked() {
	showToast('Your browser blocked the code window. Allow pop-ups for this site, or try again.', [{ label: 'Try again', action: () => void popOutCode() }]);
}

/**
 * Open (or focus) the code window. MUST be called from a user gesture: `window.open` runs
 * before any await, while the click's activation still holds.
 * @returns {Promise<'open' | 'focused' | 'blocked' | 'unsupported'>}
 */
export async function popOutCode() {
	if (win && !win.closed) {
		win.focus();
		return 'focused';
	}
	if (opening) return 'focused';
	if (!get(popOutSupported)) return 'unsupported';
	const r = storedRect();
	const place = r.left != null && r.top != null ? `,left=${Math.round(r.left)},top=${Math.round(r.top)}` : '';
	const w = window.open('', WINDOW_NAME, `popup,width=${Math.round(r.width)},height=${Math.round(r.height)}${place}`);
	if (!w) {
		blocked();
		return 'blocked';
	}
	opening = true;
	try {
		// a fresh STANDARDS-mode document (the initial about:blank has no doctype = quirks
		// mode), which also wipes whatever an earlier session of this named window held
		const doc = w.document;
		doc.open();
		doc.write('<!doctype html><html><head><meta charset="utf-8"><title>Code — ThePrototype</title><style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body></body></html>');
		doc.close();
		const [{ mount, unmount }, { default: CodeWorkspace }] = await Promise.all([import('svelte'), import('../components/editors/CodeWorkspace.svelte')]);
		teardown = [mirrorStyles(doc), mirrorAttributes(document.documentElement, doc.documentElement), mirrorAttributes(document.body, doc.body)];
		win = w;
		instance = mount(CodeWorkspace, { target: doc.body, props: { popped: true } });
		teardown.push(() => {
			try {
				unmount(instance);
			} catch {
				/* the document may already be gone */
			}
			instance = null;
		});
		// the popup closing (its ✕, Dock back, the OS) docks the editor back
		const onGone = () => finish(w);
		w.addEventListener('pagehide', onGone);
		// belt and braces: some window managers close a popup without a pagehide
		const poll = setInterval(() => w.closed && finish(w), 800);
		teardown.push(() => clearInterval(poll));
		// the MAIN tab closing takes the realm the popup runs on — close it with us
		const onMainGone = () => w.close();
		window.addEventListener('pagehide', onMainGone);
		teardown.push(() => window.removeEventListener('pagehide', onMainGone));
		codePoppedOut.set(true);
		codeWorkspaceClose.set(true);
		w.focus();
		return 'open';
	} catch (err) {
		console.warn('[codePopout] could not open the code window', err);
		finish(w);
		try {
			w.close();
		} catch {
			/* already closed */
		}
		showToast('Could not open the code window — the editor stays here.');
		return 'blocked';
	} finally {
		opening = false;
	}
}

/** @param {Window} w */
function finish(w) {
	if (w !== win && win !== null) return;
	if (!win && !instance && !get(codePoppedOut)) return;
	rememberRect(w);
	const steps = teardown;
	teardown = [];
	for (const fn of steps.reverse()) fn();
	win = null;
	if (get(codePoppedOut)) {
		codePoppedOut.set(false);
		// back where it was: the workspace reopens docked or floating, as it last was
		codeWorkspaceClose.set(false);
		import('./bottomDock').then((m) => m.activateDock('code')).catch(() => {});
	}
}

/** "Dock back": close the code window and bring the editor home */
export function dockCodeBack() {
	const w = win;
	if (!w) return;
	finish(w);
	try {
		w.close();
	} catch {
		/* already closed */
	}
}

/** raise the code window (openCode while popped, the main window's Code entry) */
export function focusCodePopout() {
	if (win && !win.closed) win.focus();
}

/** for tests / the debug hook: the live popup window, if any */
export function codePopoutWindow() {
	return win && !win.closed ? win : null;
}
