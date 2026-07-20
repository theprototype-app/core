<script>
	// A2 (roadmap #13): round HUD button at bottom-left BELOW the "+" that opens the
	// AI assistant chat window. White so the AI action reads as a featured accent
	// against the dark HUD buttons (mirrors the light central play button). Its own
	// component so it can use `onclick` without mixing with Controls.svelte's on:
	// directives (the MobileAddButton precedent). Hidden until AI is enabled AND a
	// provider is configured, so it never confuses when there's nothing to open.
	import { aiAssistantHidden } from '../../stores/appStore.js';
	import { aiEnabled, aiProviders, aiActiveProvider } from '$lib/ai/providers';

	const visible = $derived($aiEnabled && $aiProviders.length > 0 && !!$aiActiveProvider);

	function toggle() {
		aiAssistantHidden.set($aiAssistantHidden === '' ? 'hidden' : '');
	}
</script>

{#if visible}
	<button
		id="ai-hud-button"
		class="mobile-hud-btn fixed bottom-4 left-4 z-[30] flex h-11 w-11 items-center justify-center rounded-full bg-white text-gray-900 shadow-lg transition-colors hover:bg-gray-100"
		title="AI assistant"
		aria-label="Open the AI assistant chat"
		onclick={toggle}
	>
		<span class="text-lg leading-none">✨</span>
	</button>
{/if}
