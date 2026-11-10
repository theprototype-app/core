<script lang="ts">
	// uir-chat — THE ASSISTANT TAB of the Chat window (was the AI assistant's own window: roadmap #10 A6,
	// 56 C1/C8/C11, 73 AI2/AI8/AI11, 86 B1/B2, 86-fix N1). The target picker lists your own providers
	// and the AI AGENTS in the session; with an agent picked the body is that agent's conversation
	// (AgentThread), the composer sends `agentchat` requests and Stop cancels the running one. A
	// `.tpchat` dropped here (or double-clicked in the Explorer) opens it. A conversation with your own
	// provider is kept on this device ($lib/chat/chatSaves) and comes back after a reload.
	// The element keeps the id `ai-assistant-window`: it is what every caller and suite addresses.
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { showToast } from '../../stores/appStore';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import AgentLog from './AgentLog.svelte'; // 55 A8
	import ChatAttach from './ChatAttach.svelte'; // 56 C8
	import AgentThread from './AgentThread.svelte'; // 56 C1
	import {
		chatTarget,
		activeChatId,
		agentTargets,
		agentChatState,
		agentStatusOf,
		sendToAgent,
		stopAgentRequest,
		canStop,
		iAmViewer,
		newChat,
		openChatInAssistant,
		peerLabel
	} from '$lib/agentChat';
	import { runningRequest, samePeer } from '$lib/agentChatCore';
	import { chatIdOfItem } from '$lib/chat/tpchatStore.js';
	import { rolesInfo } from '$lib/cloudHooks';
	import ConnectClaude from './ConnectClaude.svelte'; // 86 B1/B2
	import AiWelcome from './AiWelcome.svelte'; // 86-fix N1
	import { aiEnabled, aiProviders, aiActiveProvider, setAiActiveProvider, aiReady } from '$lib/ai/providers';
	import { visionSupport } from '$lib/ai/visionLimits.js'; // 73 AI8 + AI11
	import { aiMessages, aiBusy, aiStatus, runPrompt, stopAi } from '$lib/ai/assistant';
	import { sttConfig, sttReady } from '$lib/ai/stt';
	import { explainMissing, openToolRow } from '$lib/tools/toolLinks.js'; // 59 T5
	import { derived } from 'svelte/store';
	import { dictation, startDictation, stopDictation } from '$lib/ai/sttCapture';
	import { phoneFirstDetents } from '$lib/ui/phoneShell.js';

	let { visible = true, historyOpen = false, welcome = $bindable(false) }: { visible?: boolean; historyOpen?: boolean; welcome?: boolean } = $props();

	let prompt = $state('');
	/** 56 C8: pictures for the next message, ready for a request's `images` */
	let pending: any[] = $state([]);
	let scroller: any = $state(null);
	let promptInput: any = $state(null);

	/** 59 T5: the mic's tooltip says what is missing (the press opens its row) */
	const voiceReady = derived(sttConfig, (c) => sttReady(c));

	// 56 C1: the agent this tab talks to (null = the configured provider, as before)
	const agentId = $derived($chatTarget?.kind === 'agent' ? $chatTarget.id : null);
	const agentRow = $derived(agentId ? $agentTargets.find((t) => samePeer(t.id, agentId)) ?? null : null);
	const agentInfo = $derived(agentId ? { id: agentId, name: agentRow?.name ?? peerLabel(agentId) } : null);
	const agentChat = $derived($activeChatId ? $agentChatState.chats[$activeChatId] ?? null : null);
	const running = $derived(agentId ? runningRequest(agentChat) : null);
	const agentMuted = $derived(agentId ? !!agentStatusOf($agentChatState, agentId)?.muted : false);
	// re-read on a roles change (the argument is the dependency)
	const viewerNow = (_roles: any) => iAmViewer();
	const amViewer = $derived(viewerNow($rolesInfo));
	const mayStop = $derived(!!running && canStop(running));
	// 73 AI8 + AI11: what the assistant's model takes (an agent answers for itself: null)
	const vision = $derived(agentId ? null : visionSupport($aiProviders.find((p) => p.id === $aiActiveProvider) ?? null));
	/** the picker's value: `p:<provider id>` or `a:<agent peer id>` */
	const pickValue = $derived(agentId ? 'a:' + agentId : $aiActiveProvider ? 'p:' + $aiActiveProvider : '');
	// 86-fix N1: no provider ready → the tab opens on the welcome (Connect Claude / your own provider)
	const needsSetup = $derived.by(() => {
		void [$aiEnabled, $aiProviders, $aiActiveProvider];
		return !aiReady();
	});
	$effect(() => {
		welcome = needsSetup && !$aiMessages.length && !agentId;
	});
	// 54i: on a phone the welcome sheet opens at full height until the person moves it (the window's
	// sheet key is 'chat' now; only while this tab shows the welcome)
	$effect(() => {
		const want = welcome && visible ? 'full' : '';
		phoneFirstDetents.update((m) => {
			if ((m.chat ?? '') === want) return m;
			const next = { ...m };
			if (want) next.chat = want;
			else delete next.chat;
			return next;
		});
	});

	function submit() {
		const text = prompt.trim();
		if (agentId) {
			if ((!text && !pending.length) || !agentRow || agentMuted) return;
			if (!sendToAgent(text, { agentId, images: pending })) {
				showToast('Not connected — your message was not sent.');
				return;
			}
			prompt = '';
			pending = [];
			return;
		}
		// 73 AI2: the pictures go to the provider too. Not set up yet: runPrompt only sends you to Settings, keep what you wrote
		if ((!text && !pending.length) || $aiBusy) return;
		// 73 AI11: a model that can't see them never receives them; the tray stays for a model that can
		if (pending.length && vision?.ok === false) return showToast(vision.reason);
		const images = pending;
		if (aiReady()) {
			prompt = '';
			pending = [];
		}
		runPrompt(text, images);
	}

	/** pick an agent: its newest chat in this scene, else a fresh one @param {string} id */
	function pickAgent(id: string) {
		chatTarget.set({ kind: 'agent', id });
		const chats = Object.values($agentChatState.chats).filter((c: any) => samePeer(c.agent, id));
		const newest: any = chats.sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
		if (newest) activeChatId.set(newest.id);
		else newChat();
	}

	/** the composer takes focus (after New chat) */
	export function focusComposer() {
		requestAnimationFrame(() => promptInput?.focus());
	}

	/** C11: a chat dragged onto the tab opens it here — a Scene ▸ chats card, a Library `.tpchat`, or a desktop file */
	const isTpchatName = (name: unknown) => /\.tpchat$/i.test(String(name ?? ''));
	function chatDragOver(e: DragEvent) {
		const types = e.dataTransfer?.types;
		if (types?.includes('application/x-explorer-item') || types?.includes('Files')) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		}
	}
	async function chatDrop(e: DragEvent) {
		const file = [...(e.dataTransfer?.files ?? [])].find((f) => isTpchatName(f.name));
		const raw = e.dataTransfer?.getData('application/x-explorer-item');
		let item: any = file ?? null;
		if (!item && raw) {
			try {
				item = JSON.parse(raw);
			} catch {
				return;
			}
		}
		// images and other files are the composer's (56-media)
		if (!item || !(file || item.kind === 'tpchat' || item.kind === 'chat' || item.chatId || isTpchatName(item.name))) return;
		e.preventDefault();
		e.stopPropagation();
		const id = await chatIdOfItem(item);
		if (id) openChatInAssistant(id);
		else showToast('That file is not a chat this scene knows.');
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
		if (explainMissing('voiceTyping')) return; // 59 T5: says what is missing, opens its row
		const ok = await startDictation('desktop');
		if (!ok && $dictation.error) showToast('Voice typing: ' + $dictation.error);
	}

	// autoscroll the transcript on new content
	let lastLen = 0;
	$effect(() => {
		const len = $aiMessages.length;
		const busy = $aiBusy; // also retrigger while streaming grows the last bubble
		void busy;
		void visible;
		if (!scroller) return;
		if (len !== lastLen || busy || visible) {
			lastLen = len;
			// uir-int (connector-relay, N6 folded): with no messages the pane is the WELCOME, read from the top — its first
			// card is Connect Claude, and showing the tab scrolled it out of a short dock
			// …and on a short dock (folded phone) the welcome's primary button sits under the composer, so it is
			// brought just into view (block: nearest — the card's heading stays above it)
			requestAnimationFrame(() => {
				if (!scroller) return;
				scroller.scrollTop = len ? scroller.scrollHeight : 0;
				if (!len) scroller.querySelector('#connect-claude-button')?.scrollIntoView({ block: 'nearest' });
			});
		}
	});

	function onActiveChange(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		if (v.startsWith('a:')) {
			pickAgent(v.slice(2));
			return;
		}
		chatTarget.set(null);
		const id = v.startsWith('p:') ? v.slice(2) : v;
		setAiActiveProvider(id || null);
	}

	const placeholder = $derived.by(() => {
		if ($dictation.state === 'recording') return 'Listening… click the mic to stop';
		if ($dictation.state === 'transcribing') return 'Transcribing…';
		if (agentId) {
			if (!agentRow) return (agentInfo?.name ?? 'The agent') + ' has left this session';
			if (agentMuted) return (agentInfo?.name ?? 'The agent') + ' is muted by the host';
			return 'Message ' + (agentInfo?.name ?? 'the agent') + '…';
		}
		return 'Ask the assistant…';
	});
	const inputDisabled = $derived(agentId ? !agentRow || agentMuted : $aiBusy);
</script>

<div
	id="ai-assistant-window"
	class="cha flex min-h-0 flex-1 flex-col"
	role="tabpanel"
	aria-label="AI assistant"
	aria-labelledby="chat-tab-assistant"
	data-target={agentId ? 'agent' : 'provider'}
	hidden={!visible}
	tabindex="-1"
	ondragover={chatDragOver}
	ondrop={chatDrop}
>
	<!-- 86 B1/B2: Connect Claude (signed-in cloud builds only); the welcome carries it while no provider is set up -->
	{#if !welcome}<ConnectClaude />{/if}
	<div class="ai-body relative flex min-h-0 flex-1 flex-col">
		{#if agentId}
			<!-- 56 C1: the conversation with the agent, its A8 steps interleaved -->
			<AgentThread chatId={$activeChatId} agent={agentInfo} visible={visible && !historyOpen} />
		{:else}
			<!-- 55 A8: what the AI agents in the session did, on every peer -->
			<AgentLog />

			<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-2 py-2" use:minimalScroll>
				{#if welcome}
					<AiWelcome />
				{:else if !$aiMessages.length}
					<EmptyState
						icon="sparkles"
						title="Describe a scene and I'll build it"
						description={'For example: "a small campfire ring with 6 rocks and a cone flame". Your chats are kept on this device.'}
					/>
				{/if}
				<ul class="flex flex-col gap-1.5">
					{#each $aiMessages as m, i (i)}
						{#if m.role === 'user'}
							<li class="ai-msg ai-user max-w-[85%] self-end">
								{#if m.images?.length}
									<!-- 73 AI2: local to this device; the provider chat is not replicated -->
									<span class="ai-pics">
										{#each m.images as pic, k (k)}
											<img class="ai-pic" src={pic.url} alt={pic.name} />
										{/each}
									</span>
								{/if}
								{m.content}
							</li>
						{:else if m.role === 'assistant'}
							<li class="ai-msg ai-reply max-w-[90%] self-start whitespace-pre-wrap">
								{m.content}{#if m.streaming}<span class="ai-caret" aria-hidden="true"></span>{/if}
							</li>
						{:else if m.role === 'tool-status'}
							<li class="ai-note inline-flex items-center gap-1 self-center text-center">
								<Icon name="settings" size={16} aria-hidden="true" />{m.content}
							</li>
						{:else if m.role === 'summary'}
							<li class="ai-note ai-ok self-center text-center">{m.content}</li>
						{:else if m.role === 'error'}
							<li class="ai-msg ai-err inline-flex max-w-[90%] items-start gap-1.5 self-start">
								<Icon name="triangle-alert" size={16} aria-hidden="true" /><span>{m.content}</span>
							</li>
						{/if}
					{/each}
					{#if $aiBusy && $aiStatus}
						<li class="ai-note self-center text-center">{$aiStatus}</li>
					{/if}
				</ul>
			</div>
		{/if}
	</div>

	<div class="ai-composer shrink-0">
		<div class="mb-1.5 flex items-center gap-1.5">
			{#if $aiProviders.length || $agentTargets.length || agentId}
				<select id="ai-target" class="tp-field flex-1" aria-label="Talk to" value={pickValue} onchange={onActiveChange}>
					{#if $aiProviders.length}
						<optgroup label="Assistant">
							{#each $aiProviders as p (p.id)}
								<option value={'p:' + p.id}>{p.label} · {p.model}</option>
							{/each}
						</optgroup>
					{:else}
						<option value="" disabled>No assistant set up (Settings ▸ Tools & connections)</option>
					{/if}
					{#if $agentTargets.length || agentId}
						<optgroup label="AI agents in this session">
							{#each $agentTargets as t (t.id)}
								<option value={'a:' + t.id}>{t.label}</option>
							{/each}
							{#if agentId && !agentRow}
								<option value={'a:' + agentId}>{agentInfo?.name ?? 'AI agent'} · left</option>
							{/if}
						</optgroup>
					{/if}
				</select>
			{:else}
				<!-- 38 NOTES-38 #24 (design page): the hint is the way there — 59 T5: the Chat providers
				     row in Settings › Tools & connections, the same place the provider toast opens -->
				<span class="ai-hint flex-1"
					>No chat provider yet. <button type="button" id="ai-hint-setup" class="ai-hint-link" onclick={() => openToolRow('chat')}
						>Set one up in Tools &amp; connections</button
					></span
				>
			{/if}
		</div>
		<div class="flex items-center gap-1.5">
			<input
				bind:this={promptInput}
				type="text"
				class="tp-field flex-1"
				{placeholder}
				aria-label={agentId ? 'Message ' + (agentInfo?.name ?? 'the agent') : 'Ask the assistant'}
				bind:value={prompt}
				disabled={inputDisabled}
				onkeydown={(e) => {
					if (e.key === 'Enter') submit();
				}}
			/>
			<!-- 56 C8: pictures for the next message (+ menu, paste, drop, Explorer drag) -->
			<ChatAttach bind:pending disabled={inputDisabled} {vision} />
			<button
				id="ai-mic"
				class="ai-mic shrink-0"
				class:ai-mic-on={$dictation.state === 'recording'}
				aria-label={$dictation.state === 'recording' ? 'Stop voice typing' : 'Voice typing'}
				aria-pressed={$dictation.state === 'recording'}
				title={$dictation.state === 'recording'
					? 'Stop and type what was said'
					: $voiceReady
						? 'Voice typing'
						: 'Voice typing needs a voice typing server — set one up in Settings ▸ Tools & connections'}
				disabled={inputDisabled || $dictation.state === 'transcribing'}
				onclick={toggleMic}
			>
				<Icon name={$dictation.state === 'recording' ? 'square' : 'mic'} size={16} />
			</button>
			{#if agentId && running && mayStop}
				<!-- 56 C6: Stop the running request — `{cancel}` to the agent -->
				<Button id="ai-agent-stop" variant="outline" size="sm" onclick={() => stopAgentRequest($activeChatId ?? '')}>Stop</Button>
			{:else if !agentId && $aiBusy}
				<Button variant="outline" size="sm" onclick={stopAi}>Stop</Button>
			{:else}
				<Button id="ai-send" variant="primary" size="sm" disabled={agentId ? inputDisabled : false} onclick={submit}>Send</Button>
			{/if}
		</div>
		{#if agentId && amViewer}
			<!-- 56 C5: a viewer can ask; the agent will not change the scene for them -->
			<p id="ai-viewer-hint" class="ai-hint mt-1">You can ask — the agent won’t change the scene for a viewer.</p>
		{/if}
	</div>
</div>

<style>
	.cha[hidden] {
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
	.ai-pics {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ai-pics:not(:last-child) {
		margin-bottom: 4px;
	}
	.ai-pic {
		max-width: 120px;
		max-height: 120px;
		border-radius: var(--radius-input);
		object-fit: cover;
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
	.ai-hint-link {
		padding: 0 2px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--accent-text);
		font: inherit;
		cursor: pointer;
	}
	.ai-hint-link:hover {
		background: var(--surface-hover);
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
	.ai-mic-on {
		color: var(--ink-bad);
		animation: ai-blink 1.2s step-end infinite;
	}
	/* the streaming caret: a thin bar, not a glyph */
	.ai-caret {
		display: inline-block;
		width: 0.45em;
		height: 1em;
		margin-left: 1px;
		vertical-align: text-bottom;
		background: currentColor;
		animation: ai-blink 1s step-end infinite;
	}
	@keyframes ai-blink {
		50% {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ai-mic-on,
		.ai-caret {
			animation: none;
		}
	}
</style>
