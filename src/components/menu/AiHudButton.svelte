<script>
	// A2 (roadmap #13): round HUD button at bottom-left BELOW the "+" that opens the
	// AI assistant chat window. Styled EXACTLY like the "+" (MobileAddButton) so it
	// reads consistently in every theme (I1). Its own component so it can use
	// `onclick` without mixing with Controls.svelte's on: directives (the
	// MobileAddButton precedent).
	//
	// I3: the button ALWAYS renders. When AI isn't configured yet, clicking points the
	// user at Settings -> AI with a toast (the exact toggleAiPrompt unconfigured branch
	// from shortcuts.js — the backquote pill already behaves this way). When configured,
	// it toggles the chat window.
	import { Sparkles } from '@lucide/svelte';
	import { aiAssistantHidden, showToast, settingsOpen, settingsSection } from '../../stores/appStore.js';
	import { aiReady } from '$lib/ai/providers';

	function toggle() {
		if (!aiReady()) {
			showToast('Enable an AI provider in Settings to use the assistant');
			settingsSection.set('ai');
			settingsOpen.set(true);
			return;
		}
		aiAssistantHidden.set($aiAssistantHidden === '' ? 'hidden' : '');
	}
</script>

<button
	id="ai-hud-button"
	class="tp-ui hud-fab mobile-hud-btn fixed bottom-4 left-4 z-30"
	class:on={$aiAssistantHidden === ''}
	title="AI assistant"
	aria-label="Open the AI assistant chat"
	onclick={toggle}
>
	<!-- 38 R8: orange is Play's alone now (SPEC §1); the sparkles read as the assistant on
	     their own, and the open window lights the button the accent way -->
	<Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />
</button>
