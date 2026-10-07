<script lang="ts">
	// AI Assistant (roadmap #10, A6): a floating chat window modeled on Chat.svelte
	// plus a shortcut-toggled quick prompt pill. The pill is hidden by default and
	// opened with the backquote (`) key; submitting from it opens the window. Edits
	// go out as normal replicated edits from this peer, undoable as one step.
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		aiAssistantHidden,
		aiPromptBarOpen,
		showToast,
		settingsOpen,
		settingsSection
	} from '../../stores/appStore';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import { aiEnabled, aiProviders, aiActiveProvider, setAiActiveProvider } from '$lib/ai/providers';
	import { aiMessages, aiBusy, aiStatus, runPrompt, stopAi } from '$lib/ai/assistant';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { sttConfig, sttReady } from '$lib/ai/stt';
	import { dictation, startDictation, stopDictation } from '$lib/ai/sttCapture';

	let prompt = $state('');
	let pillPrompt = $state('');
	let scroller: any = $state(null);
	let pillInput: any = $state(null);
	let promptInput: any = $state(null);

	const hasProvider = $derived($aiProviders.length > 0 && !!$aiActiveProvider);
	const pillVisible = $derived($aiPromptBarOpen && $aiEnabled && hasProvider && $aiAssistantHidden !== '');

	function submit() {
		const text = prompt.trim();
		if (!text || $aiBusy) return;
		prompt = '';
		runPrompt(text);
	}

	// 36-vr-ai (F2): voice typing — click to listen, click again to stop; the transcript lands in the input,
	// EDITABLE (nothing is sent until you press Send). The VR panel's mic sends instead.
	async function toggleMic() {
		if ($dictation.state === 'recording') {
			const text = await stopDictation();
			if (text) {
				prompt = prompt.trim() ? prompt.trimEnd() + ' ' + text : text;
				requestAnimationFrame(() => promptInput?.focus());
			} else if ($dictation.error) showToast('Voice typing: ' + $dictation.error);
			return;
		}
		if ($dictation.state !== 'idle') return;
		if (!sttReady($sttConfig)) {
			showToast('Set up Voice typing in Settings ▸ AI to talk to the assistant', [
				{ label: 'Open Settings', action: () => { settingsSection.set('ai'); settingsOpen.set(true); } }
			]);
			return;
		}
		const ok = await startDictation('desktop');
		if (!ok && $dictation.error) showToast('Voice typing: ' + $dictation.error);
	}

	function submitPill() {
		const text = pillPrompt.trim();
		if (!text) return;
		pillPrompt = '';
		aiPromptBarOpen.set(false);
		aiAssistantHidden.set(''); // open the window so the answer streams somewhere
		runPrompt(text);
	}

	// focus the pill input the moment it appears
	$effect(() => {
		if (pillVisible && pillInput) requestAnimationFrame(() => pillInput?.focus());
	});

	// autoscroll the transcript on new content
	let lastLen = 0;
	$effect(() => {
		const len = $aiMessages.length;
		const busy = $aiBusy; // also retrigger while streaming grows the last bubble
		void busy;
		if (!scroller) return;
		if (len !== lastLen || busy) {
			lastLen = len;
			requestAnimationFrame(() => {
				if (scroller) scroller.scrollTop = scroller.scrollHeight;
			});
		}
	});

	function onActiveChange(e: Event) {
		const id = (e.currentTarget as HTMLSelectElement).value;
		setAiActiveProvider(id || null);
	}
</script>

<!-- Quick prompt pill (backquote-toggled) -->
{#if pillVisible}
	<div
		class="ai-pill ui-panel tp-ui tp-window flex items-center gap-1.5 px-2 py-1.5"
		style="position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--bottom-inset, 0px) + 72px); z-index: var(--z-hud); width: min(560px, 92vw);"
	>
		<span class="ai-pill-icon pl-1" aria-hidden="true"><Icon name="sparkles" size={16} /></span>
		<input
			bind:this={pillInput}
			bind:value={pillPrompt}
			type="text"
			class="tp-field flex-1"
			placeholder="Ask the assistant to build or change the scene…"
			onkeydown={(e) => {
				if (e.key === 'Enter') submitPill();
				else if (e.key === 'Escape') aiPromptBarOpen.set(false);
			}}
		/>
		<Button variant="primary" size="sm" onclick={submitPill}>Send</Button>
	</div>
{/if}

<!-- Floating window -->
<div id="ai-assistant" class={$aiAssistantHidden}>
	<div
		id="ai-assistant-window"
		use:dragWindow={{ key: 'aiAssistant', defaultRect: { right: 15, bottom: 460 } }}
		use:focusStack
		use:tabbable={{ key: 'aiAssistant', title: 'AI assistant', openStore: aiAssistantHidden, isOpen: (v: string) => v === '', close: () => aiAssistantHidden.set('hidden') }}
		class="ui-panel tp-ui tp-window flex h-[440px] w-[min(500px,90vw)] flex-col overflow-hidden"
		style="z-index: var(--z-window)"
	>
		<!-- 38 R6: the one window header (ui/WindowChrome) -->
		<WindowChrome
			size="tool"
			bare
			body={false}
			title="AI assistant"
			headerClass="ui-panel-header move-handle cursor-move select-none"
			onclose={() => aiAssistantHidden.set('hidden')}
		/>

		<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-2 py-2" use:minimalScroll>
			{#if !$aiMessages.length}
				<EmptyState
					icon="sparkles"
					title="Describe a scene and I'll build it"
					description={'For example: "a small campfire ring with 6 rocks and a cone flame".'}
				/>
			{/if}
			<ul class="flex flex-col gap-1.5">
				{#each $aiMessages as m, i (i)}
					{#if m.role === 'user'}
						<li class="ai-msg ai-user max-w-[85%] self-end">
							{m.content}
						</li>
					{:else if m.role === 'assistant'}
						<li class="ai-msg ai-reply max-w-[90%] self-start whitespace-pre-wrap">
							{m.content}{#if m.streaming}<span class="ai-caret">▋</span>{/if}
						</li>
					{:else if m.role === 'tool-status'}
						<li class="ai-note self-center text-center">⚙ {m.content}</li>
					{:else if m.role === 'summary'}
						<li class="ai-note ai-ok self-center text-center">{m.content}</li>
					{:else if m.role === 'error'}
						<li class="ai-msg ai-err max-w-[90%] self-start">
							⚠ {m.content}
						</li>
					{/if}
				{/each}
				{#if $aiBusy && $aiStatus}
					<li class="ai-note self-center text-center">{$aiStatus}</li>
				{/if}
			</ul>
		</div>

		<div class="ai-composer shrink-0">
			<div class="mb-1.5 flex items-center gap-1.5">
				{#if $aiProviders.length}
					<select class="tp-field flex-1" value={$aiActiveProvider ?? ''} onchange={onActiveChange}>
						{#each $aiProviders as p (p.id)}
							<option value={p.id}>{p.label} · {p.model}</option>
						{/each}
					</select>
				{:else}
					<span class="ai-hint flex-1">No provider configured — see Settings › AI</span>
				{/if}
			</div>
			<div class="flex items-center gap-1.5">
				<input
					bind:this={promptInput}
					type="text"
					class="tp-field flex-1"
					placeholder={$dictation.state === 'recording' ? 'Listening… click the mic to stop' : $dictation.state === 'transcribing' ? 'Transcribing…' : 'Ask the assistant…'}
					bind:value={prompt}
					disabled={$aiBusy}
					onkeydown={(e) => {
						if (e.key === 'Enter') submit();
					}}
				/>
				<button
					id="ai-mic"
					class="ai-mic shrink-0"
					class:ai-mic-on={$dictation.state === 'recording'}
					aria-label={$dictation.state === 'recording' ? 'Stop voice typing' : 'Voice typing'}
					aria-pressed={$dictation.state === 'recording'}
					title={$dictation.state === 'recording' ? 'Stop and type what was said' : 'Voice typing (Settings ▸ AI)'}
					disabled={$aiBusy || $dictation.state === 'transcribing'}
					onclick={toggleMic}
				>
					<Icon name={$dictation.state === 'recording' ? 'square' : 'mic'} size={16} />
				</button>
				{#if $aiBusy}
					<Button variant="outline" size="sm" onclick={stopAi}>Stop</Button>
				{:else}
					<Button variant="primary" size="sm" onclick={submit}>Send</Button>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	#ai-assistant.hidden {
		display: none;
	}
	/* 38 R6: the body in the tokens — your prompt on the accent tint, replies on surface-2 */
	.ai-msg {
		padding: 6px 10px;
		border-radius: var(--radius-card);
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.ai-user {
		border-bottom-right-radius: 4px;
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.ai-reply {
		border-bottom-left-radius: 4px;
		background: var(--surface-2);
		border: 1px solid var(--border);
	}
	.ai-err {
		background: color-mix(in srgb, var(--danger) 18%, transparent);
		color: var(--warn-text);
	}
	.ai-note {
		font-size: var(--fs-section);
		color: var(--text-faint);
	}
	.ai-ok {
		color: var(--accent-text);
	}
	.ai-composer {
		padding: 10px;
		border-top: 1px solid var(--border);
	}
	.ai-hint {
		font-size: var(--fs-section);
		color: var(--text-muted);
	}
	.ai-mic {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--icon-button);
		height: var(--icon-button);
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ai-mic:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.ai-mic:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.ai-pill-icon {
		display: inline-flex;
		color: var(--accent-text);
	}
	.ai-mic-on {
		color: var(--ink-bad);
		animation: ai-blink 1.2s step-end infinite;
	}
	.ai-caret {
		animation: ai-blink 1s step-end infinite;
	}
	@keyframes ai-blink {
		50% {
			opacity: 0;
		}
	}
</style>
