// Module SDK — what a module OWNS outside the registries: its own teardown, timers, DOM
// listeners and scene objects (34 R6, contract T2). Everything here records into the
// module's lifecycle registry (sdk/lifecycle.js), so `unloadModule` takes it down.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { get } from 'svelte/store';
import { globalScene, objectsGroup } from '../../stores/sceneStore';
import { removeAndDispose } from '../disposeTree.js';

/**
 * The timer functions a module gets: the window's own, but every live handle is tracked
 * and cleared when the module unloads. A timeout that has FIRED, an interval or a frame
 * the module cleared, is forgotten at once, so the set holds only what is pending.
 * Callbacks run exactly as the native ones would (a throw is the page's uncaught error).
 * @param {(fn: () => void, kind?: string, opts?: {key?: string}) => () => void} onDispose
 * @param {string} [key] the journal key (the zip-module scope keeps its own, moduleScope.js)
 */
export function makeModuleTimers(onDispose, key = 'timers') {
	/** @type {Set<any>} */ const timeouts = new Set();
	/** @type {Set<any>} */ const intervals = new Set();
	/** @type {Set<number>} */ const frames = new Set();
	let hooked = false;
	const hook = () => {
		if (hooked) return;
		hooked = true;
		onDispose(
			() => {
				hooked = false;
				timeouts.forEach((h) => clearTimeout(h));
				intervals.forEach((h) => clearInterval(h));
				if (typeof cancelAnimationFrame === 'function') frames.forEach((h) => cancelAnimationFrame(h));
				timeouts.clear();
				intervals.clear();
				frames.clear();
			},
			'timers',
			{ key }
		);
	};
	return {
		/** @param {Function | string} fn @param {number} [ms] @param {...any} args */
		setTimeout(fn, ms, ...args) {
			if (typeof fn !== 'function') return 0; // never eval a string
			hook();
			const handle = setTimeout(() => {
				timeouts.delete(handle);
				fn(...args);
			}, ms);
			timeouts.add(handle);
			return handle;
		},
		/** @param {any} handle */
		clearTimeout(handle) {
			timeouts.delete(handle);
			clearTimeout(handle);
		},
		/** @param {Function | string} fn @param {number} [ms] @param {...any} args */
		setInterval(fn, ms, ...args) {
			if (typeof fn !== 'function') return 0;
			hook();
			const handle = setInterval(() => fn(...args), ms);
			intervals.add(handle);
			return handle;
		},
		/** @param {any} handle */
		clearInterval(handle) {
			intervals.delete(handle);
			clearInterval(handle);
		},
		/** @param {FrameRequestCallback} fn */
		requestAnimationFrame(fn) {
			if (typeof requestAnimationFrame !== 'function') return 0;
			hook();
			const handle = requestAnimationFrame((t) => {
				frames.delete(handle);
				fn(t);
			});
			frames.add(handle);
			return handle;
		},
		/** @param {number} handle */
		cancelAnimationFrame(handle) {
			frames.delete(handle);
			if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
		},
		/** live handles, for the leak test and the debug view */
		pending() {
			return { timeouts: timeouts.size, intervals: intervals.size, frames: frames.size };
		}
	};
}

/** @param {import('./context.js').SdkContext} ctx */
export function sdkOwn(ctx) {
	const { onDispose, owned } = ctx;
	const timers = makeModuleTimers(onDispose);
	return {
		/**
		 * 34 R6: the module's OWN teardown — `fn()` runs when the module is unloaded (disabled,
		 * removed, updated, dev-reloaded, or unloaded by a scene switch). Teardown runs newest
		 * first, so a hook added at the end of `register` runs while everything registered
		 * before it is still in place. Put here what core cannot know about: a DOM overlay you
		 * appended, a worker, a cache. Returns `cancel()`. Everything you registered through
		 * the api is undone for you — do not repeat it here.
		 * @param {() => void} fn @returns {() => void} cancel
		 */
		onUnload(fn) {
			return onDispose(fn, 'onUnload');
		},
		/**
		 * 34 R6: TIMERS that die with the module — `setTimeout`/`clearTimeout`,
		 * `setInterval`/`clearInterval`, `requestAnimationFrame`/`cancelAnimationFrame` with
		 * the window's signatures. A module installed from a zip or URL gets these AS its
		 * bare `setTimeout`/… names automatically; a core module (or code calling
		 * `window.setTimeout`) uses `api.timers.*`. `pending()` counts what is live.
		 */
		timers,
		/**
		 * 34 R6: `target.addEventListener(type, fn, options)` that is removed when the module
		 * unloads — a `window` keydown or pointer listener otherwise outlives the module and
		 * keeps driving a game that is gone. Returns `off()`.
		 * @param {EventTarget} target @param {string} type
		 * @param {EventListenerOrEventListenerObject} fn
		 * @param {boolean | AddEventListenerOptions} [options]
		 * @returns {() => void} off
		 */
		listen(target, type, fn, options) {
			if (!target?.addEventListener) return () => {};
			target.addEventListener(type, fn, options);
			return owned('listener', () => target.removeEventListener(type, fn, options));
		},
		/**
		 * 34 R6: this object is the MODULE's — when it unloads, the object leaves the scene
		 * and the GPU resources only it used (geometries, materials, textures) are freed.
		 * For scene-root content you `api.scene().add()` yourself; a group registered with
		 * `registerInteractiveGroup`/`registerSystemGroup` is owned already. Never pass
		 * something inside `objectsGroup` (shared, replicated content — left alone). Own the
		 * long-lived roots, not per-frame transients. Returns the object.
		 * @template T @param {T} object @returns {T}
		 */
		own(object) {
			const obj = /** @type {any} */ (object);
			if (!obj?.isObject3D) return object;
			onDispose(() => {
				// replicated content is never the module's to delete (golden rule 5)
				const objects = get(objectsGroup);
				for (let node = obj.parent; node; node = node.parent) if (objects && node === objects) return;
				// keep what the rest of the scene still draws with, attached or not
				removeAndDispose(get(globalScene), obj);
			}, 'object');
			return object;
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkOwn.surface = {
	onUnload: 'registers',
	'timers.setTimeout': 'registers',
	'timers.clearTimeout': 'action',
	'timers.setInterval': 'registers',
	'timers.clearInterval': 'action',
	'timers.requestAnimationFrame': 'registers',
	'timers.cancelAnimationFrame': 'action',
	'timers.pending': 'read',
	listen: 'registers',
	own: 'registers'
};
