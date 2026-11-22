<script>
	// uir-polish G2/G3 (owner 2026-11-11, owner-dock-button.png): EVERY floating window's header carries a Dock button
	// (icon-only — the word "Dock" is gone) and, where the panel can live in a browser window of its own, a pop-out
	// button. One component so the two buttons look and behave the same in every header; both are `data-wc-chrome`,
	// so a window docked into a sidebar (43 J7) or hosted in the bottom dock drops them with the rest of its chrome.
	// Order, as the owner's header reads: Dock, pop-out, then the window's own ✕.
	import Icon from './Icon.svelte';
	import { popOutSupported } from '$lib/windows/popOutSupport.js';
	import { canPopOut, popOutPanel } from '$lib/windows/panelPlaces.js';

	import { phoneShellActive } from '$lib/ui/phoneShell.js';

	/** @type {{key: string, title?: string, ondock?: (() => void) | null, onpopout?: (() => void) | null, dockId?: string, popId?: string, btnClass?: string}} */
	let { key, title = '', ondock = null, onpopout = null, dockId = undefined, popId = undefined, btnClass = 'wc-act' } = $props();

	const name = $derived(title || 'this window');
	// canPopOut asks the registered host (desktop, a poppable panel); popOutSupported is the reactive half
	const canPop = $derived($popOutSupported && canPopOut(key));
</script>

{#if ondock && !$phoneShellActive}
	<button
		type="button"
		id={dockId}
		data-wc-chrome
		data-head-dock={key}
		class={btnClass}
		aria-label="Dock {name}"
		title="Dock to the bottom"
		onclick={ondock}><Icon name="panel-bottom" size={16} aria-hidden="true" /></button
	>
{/if}
{#if canPop}
	<button
		type="button"
		id={popId}
		data-wc-chrome
		data-head-popout={key}
		class={btnClass}
		aria-label="Pop out {name}"
		title="Pop out — open {name} in its own browser window (drag it to another monitor)"
		onclick={() => (onpopout ? onpopout() : popOutPanel(key))}><Icon name="external-link" size={16} aria-hidden="true" /></button
	>
{/if}
