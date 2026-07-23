<script>
	// Renders a cloud-plugin UI mount point (roadmap #13 batch M1). The plugin hands
	// core a MOUNT FUNCTION `(el) => cleanup` via cloudHooks' connectSlot/usersSlot
	// stores, so a separately-built plugin owns its own rendering — core just gives
	// it a DOM node. Nothing renders in the OSS build (the slot store is null).
	/** @type {{ mount?: any }} */
	let { mount = null } = $props();

	/** Svelte action: run the plugin mount fn on attach, its cleanup on detach.
	 * @param {HTMLElement} node
	 * @param {any} fn */
	function cloudMount(node, fn) {
		/** @type {(() => void) | void} */
		let cleanup;
		const run = (/** @type {any} */ f) => {
			try {
				if (typeof f === 'function') cleanup = f(node);
			} catch (e) {
				console.error('cloud slot mount failed:', e);
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
</script>

{#if mount}
	<div class="cloud-slot" use:cloudMount={mount}></div>
{/if}
