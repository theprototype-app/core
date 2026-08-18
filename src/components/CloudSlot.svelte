<script>
	// Renders a cloud-plugin UI mount point (roadmap #13 batch M1). The plugin hands
	// core a MOUNT FUNCTION `(el) => cleanup` via cloudHooks' connectSlot/usersSlot
	// stores, so a separately-built plugin owns its own rendering — core just gives
	// it a DOM node. Nothing renders in the OSS build (the slot store is null).
	//
	// A5: the action itself now lives in $lib/cloudMount, because a module TOOLBOX
	// hosts foreign DOM through exactly the same contract.
	import { cloudMount } from '$lib/cloudMount';

	/** @type {{ mount?: any }} */
	let { mount = null } = $props();
</script>

{#if mount}
	<div class="cloud-slot" use:cloudMount={mount}></div>
{/if}
