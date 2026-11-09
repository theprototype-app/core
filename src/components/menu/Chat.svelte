<script lang="ts">
	// uir-chat — CHAT AND THE AI ASSISTANT IN ONE WINDOW (owner 2026-11-09, q-chat-save option c).
	// Two tabs: Session (the people in this session — ChatSession) and Assistant (your own provider or
	// an AI agent in the session — ChatAssistant). The Chat button opens Session, the AI assistant button
	// opens Assistant ($lib/chat/chatWindow); each tab carries its own unread dot. ONE History lists both
	// kinds (ChatHistory), and both are kept on this device ($lib/chat/chatSaves). The window keeps the
	// Chat window's key and element (#chat-window, key 'chat') for the dock, the sidebars, the pop-out
	// windows and the layouts; old saved state naming the assistant's own window opens this one on its
	// Assistant tab ($lib/chat/chatKeys). Floating, it is resizable by its corner grip.
	import '../../styles/chat.css';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Button from '../ui/Button.svelte';
	import Icon from '../ui/Icon.svelte';
	import ChatSession from './ChatSession.svelte';
	import ChatAssistant from './ChatAssistant.svelte';
	import ChatHistory from './ChatHistory.svelte';
	import { chatHidden, chatTab, chatUnread, chatMentioned } from '../../stores/appStore';
	import { connectorSignInSlot } from '$lib/cloudHooks';
	import { connectorAvailable } from '$lib/connector/connectorStore';
	import { requestSignIn } from '$lib/connector/connectorSignIn.js';
	import { chatTarget, activeChatId, agentChatState, seenCounts, myPeerId, newChat, openChatInAssistant } from '$lib/agentChat';
	import { samePeer } from '$lib/agentChatCore';
	import { aiBusy } from '$lib/ai/assistant';
	import { aiProviders, aiActiveProvider } from '$lib/ai/providers';
	import { startChatSaves, newAiChat, openAiChat, viewLog, archiveView, activeAiChatId } from '$lib/chat/chatSaves.js';
	import { rovingIndex } from '$lib/ui/roving.js';
	import { dragWindow } from '$lib/dragWindow';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { panelAway } from '$lib/windows/panelPlaces.js';
	import { onMount } from 'svelte';

	// 70 W2: `popped` = the instance in a pop-out window; the main one draws nothing while Chat is away
	let { popped = false }: { popped?: boolean } = $props();

	const open = $derived($chatHidden === '');
	const tab = $derived($chatTab);
	let historyOpen = $state(false);
	let historyBtn: any = $state(null);
	let assistant: any = $state(null);
	let welcome = $state(false);

	onMount(() => {
		void startChatSaves({
			providerLabel: () => {
				const p = $aiProviders.find((x) => x.id === $aiActiveProvider);
				return p ? p.label : 'Assistant';
			}
		});
	});

	// ---- the tabs -----------------------------------------------------------------------------------
	const TABS = [
		{ id: 'session', label: 'Session', icon: 'message-square' },
		{ id: 'assistant', label: 'Assistant', icon: 'sparkles' }
	] as const;
	/** @type {HTMLElement[]} */
	const tabEls: HTMLElement[] = [];
	function pick(id: 'session' | 'assistant') {
		if (id !== $chatTab) chatTab.set(id);
		historyOpen = false;
	}
	function tabKey(e: KeyboardEvent, i: number) {
		const next = rovingIndex(i, e.key, [false, false], 'horizontal');
		if (next < 0) return;
		e.preventDefault();
		pick(TABS[next].id);
		tabEls[next]?.focus();
	}

	// unread: Session counts lines that came while it was not showing (appStore), Assistant shows a dot
	// for a reply that settled while it was not showing, or an agent chat with unseen messages
	const assistantShowing = $derived(open && tab === 'assistant');
	let aiReplyUnseen = $state(false);
	let wasBusy = false;
	$effect(() => {
		const busy = $aiBusy;
		if (wasBusy && !busy && !assistantShowing) aiReplyUnseen = true;
		wasBusy = busy;
	});
	$effect(() => {
		if (assistantShowing) aiReplyUnseen = false;
	});
	const agentUnseen = $derived.by(() => {
		const me = myPeerId();
		for (const chat of Object.values($agentChatState.chats) as any[]) {
			const seen = $seenCounts[chat.id] ?? 0;
			if (chat.messages.slice(seen).some((m: any) => !samePeer(m.from, me))) return !(assistantShowing && chat.id === $activeChatId);
		}
		return false;
	});
	const dots = $derived({ session: $chatUnread > 0, assistant: aiReplyUnseen || agentUnseen });

	// ---- header actions -------------------------------------------------------------------------------
	const agentId = $derived($chatTarget?.kind === 'agent' ? $chatTarget.id : null);
	const headerSignIn = $derived(tab === 'assistant' && !!$connectorSignInSlot && !$connectorAvailable && !welcome);

	function startNewChat() {
		historyOpen = false;
		chatTab.set('assistant');
		if (agentId) newChat();
		else newAiChat(); // your own provider: a fresh conversation (the last one stays in History)
		assistant?.focusComposer?.();
	}
	function closeHistory() {
		historyOpen = false;
		requestAnimationFrame(() => historyBtn?.focus());
	}
	/** a History row: People -> the Session tab (another scene's log read-only), AI -> the Assistant tab */
	async function openRow(row: any) {
		historyOpen = false;
		if (row.kind === 'people') {
			chatTab.set('session');
			await viewLog(row.current ? null : row.id);
			return;
		}
		if (row.kind === 'agent') {
			await openChatInAssistant(row.id);
			return;
		}
		chatTarget.set(null);
		chatTab.set('assistant');
		await openAiChat(row.id);
	}
	const historyActive = $derived(tab === 'session' ? ($archiveView?.key ?? null) : agentId ? $activeChatId : $activeAiChatId);
	function close() {
		chatHidden.set('hidden');
	}
</script>

{#if popped || !$panelAway.chat}
	<div id="chat" class={$chatHidden}>
		<div
			id="chat-window"
			use:dragWindow={{ key: 'chat', defaultRect: { right: 15, bottom: 15 }, resizable: true, minW: 300, minH: 260 }}
			use:bottomDockable={{ key: 'chat' }}
			use:focusStack
			use:tabbable={{ key: 'chat', title: 'Chat', openStore: chatHidden, isOpen: (v) => v === '', close }}
			class="ui-panel tp-ui tp-window flex h-[460px] w-[min(500px,90vw)] flex-col overflow-hidden"
			style="z-index: var(--z-window); max-height: calc(100dvh - 76px)"
			data-tab={tab}
		>
			<!-- 38 R6: the one window header (ui/WindowChrome); `ui-panel-header move-handle` is the grip
			     dragWindow / tabbing / docking read. Docked in a sidebar the column's tab is the title, so
			     only the window's chrome stands down and the Session | Assistant tabs stay ('tools'). -->
			<WindowChrome
				size="tool"
				bare
				body={false}
				title="Chat"
				dockedHead="tools"
				headerClass="ui-panel-header move-handle cursor-move select-none chat-head"
				onclose={close}
				closeAttrs={{ title: 'Close (C)' }}
				role="region"
				aria-label="Chat"
			>
				{#snippet heading()}
					<div class="chat-tabs" role="tablist" aria-label="Chat">
						{#each TABS as t, i (t.id)}
							<button
								bind:this={tabEls[i]}
								type="button"
								role="tab"
								id={'chat-tab-' + t.id}
								class="chat-tab"
								aria-selected={tab === t.id}
								aria-controls={t.id === 'session' ? 'chat-session' : 'ai-assistant-window'}
								tabindex={tab === t.id ? 0 : -1}
								onclick={() => pick(t.id)}
								onkeydown={(e) => tabKey(e, i)}
							>
								<Icon name={t.icon} size={16} aria-hidden="true" />
								<span>{t.label}</span>
								{#if dots[t.id] && tab !== t.id}
									<span
										class="chat-tab-dot"
										class:mention={t.id === 'session' && $chatMentioned}
										data-unread={t.id}
										aria-label={t.id === 'session' ? $chatUnread + ' unread' : 'New reply'}
									></span>
								{/if}
							</button>
						{/each}
					</div>
				{/snippet}
				{#snippet actions()}
					<!-- FW-AI (76): signed out on a cloud build, working with a provider of your own: connecting stays one press away -->
					{#if headerSignIn}
						<Button id="ai-header-signin" variant="secondary" size="sm" aria-label="Sign in to connect" title="Sign in to connect" onclick={requestSignIn}
							><span class="ai-signin-long">Sign in to connect</span><span class="ai-signin-short">Sign in</span></Button
						>
					{/if}
					<button
						type="button"
						id="ai-history-btn"
						class="wc-act"
						bind:this={historyBtn}
						aria-label="Chat history"
						title="Chat history"
						aria-expanded={historyOpen}
						aria-controls="ai-chat-history"
						onclick={() => (historyOpen = !historyOpen)}><Icon name="history" size={16} /></button
					>
					{#if tab === 'assistant'}
						<button type="button" id="ai-new-chat" class="wc-act" aria-label="New chat" title="New chat" onclick={startNewChat}><Icon name="plus" size={16} /></button>
					{/if}
				{/snippet}
			</WindowChrome>
			<div class="chat-body relative flex min-h-0 flex-1 flex-col">
				{#if historyOpen}
					<ChatHistory activeId={historyActive} onnew={startNewChat} onclose={closeHistory} onpick={openRow} />
				{/if}
				<ChatSession visible={tab === 'session'} />
				<ChatAssistant bind:this={assistant} bind:welcome visible={tab === 'assistant'} {historyOpen} />
			</div>
		</div>
	</div>
{/if}

<style>
	/* 54i: the header measures its own width (a sheet, a docked column or a floating window alike) */
	:global(#chat-window .chat-head) {
		container-type: inline-size;
	}
	.chat-tabs {
		display: flex;
		align-items: stretch;
		align-self: stretch;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}
	.chat-tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: var(--fs-desc);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}
	.chat-tab:hover:not([aria-selected='true']) {
		color: var(--text);
	}
	.chat-tab[aria-selected='true'] {
		border-bottom-color: var(--accent);
		color: var(--text);
	}
	.chat-tab:focus-visible {
		outline: 2px solid var(--focus-ring, var(--accent));
		outline-offset: -2px;
	}
	.chat-tab-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
	}
	.chat-tab-dot.mention {
		background: var(--warn-text);
	}
	.ai-signin-short {
		display: none;
	}
	@container (max-width: 440px) {
		.ai-signin-long {
			display: none;
		}
		.ai-signin-short {
			display: inline;
		}
	}
	@container (max-width: 300px) {
		.chat-tab span:not(.chat-tab-dot) {
			display: none;
		}
	}
</style>
