// A5 — the `(el) => cleanup` MOUNT action, extracted from CloudSlot.svelte.
//
// It was already the shape core uses to host UI it does not own: a cloud plugin (its
// own framework and version) hands core a mount function and core hands it a DOM node.
// A module toolbox needs exactly the same contract, so the action moved out here
// instead of being written twice — CloudSlot.svelte is a one-line change.
//
// `update()` re-runs the cleanup and re-mounts, which is what makes 17-A2's dev-mode
// live reload work: a re-registered module hands over a NEW mount fn and the node is
// emptied and rebuilt in place.

/**
 * Svelte action: run a mount fn on attach, its returned cleanup on detach.
 * @param {HTMLElement} node
 * @param {any} fn `(el) => (() => void) | void`
 */
export function cloudMount(node, fn) {
	/** @type {(() => void) | void} */
	let cleanup;
	const run = (/** @type {any} */ f) => {
		try {
			if (typeof f === 'function') cleanup = f(node);
		} catch (e) {
			console.error('mount fn failed:', e);
		}
	};
	run(fn);
	return {
		/** @param {any} f */
		update(f) {
			try {
				if (typeof cleanup === 'function') cleanup();
			} catch {
				/* ignore */
			}
			node.replaceChildren();
			run(f);
		},
		destroy() {
			try {
				if (typeof cleanup === 'function') cleanup();
			} catch {
				/* ignore */
			}
		}
	};
}
