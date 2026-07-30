<script>
	import { Plus } from '@lucide/svelte';
	// Mobile "+" HUD button (bottom-left): opens the same create/context menu as a
	// right-click — touch has none. Its own component so it can use `onclick` (no
	// deprecation warning) without mixing with Controls.svelte's on: directives.
	// Shown on touch/narrow screens; the reflow media query (ui.css) lifts it +
	// the chat/mic stack above the centred Controls pill.
	import { viewportMenuOpener } from '../../stores/appStore.js';
	function add() {
		// Raycast a new object into the MIDDLE of the view (the button carries no
		// pointer location), but open the menu anchored to the button itself so it
		// appears right next to it (place() flips it up off the bottom edge).
		const r = document.getElementById('mobile-add-button')?.getBoundingClientRect();
		$viewportMenuOpener?.(
			window.innerWidth / 2,
			window.innerHeight / 2,
			true,
			r?.left ?? 16,
			r?.top ?? window.innerHeight - 60
		);
	}
</script>

<button
	id="mobile-add-button"
	class="mobile-hud-btn fixed bottom-16 left-4 z-[30] flex h-11 w-11 items-center justify-center rounded-full bg-gray-700 text-white shadow-lg transition-colors hover:bg-gray-600"
	title="Add / context menu"
	aria-label="Add object or open the context menu"
	onclick={add}
>
	<Plus size={16} aria-hidden="true" />
</button>
