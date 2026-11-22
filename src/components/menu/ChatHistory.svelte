<script>
	// uir-chat — ONE HISTORY for both tabs of the Chat window (q-chat-save option c; was 56 C11's AI-only
	// list): the session logs this device keeps per scene (People — the scene you are in first) and the AI
	// chats (Agent chats saved in the scene as .tpchat, and your own provider's chats kept on this device),
	// newest first, with a People | AI filter, a search, and an unread dot for an agent chat whose last
	// messages have not been shown. A panel over the window body, not a menu: it holds a text field, and
	// Escape / the close button hand focus back to the History button.
	import { onMount } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import SearchField from '../ui/SearchField.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { safeStorage } from '$lib/safeStorage';
	import { historyRows, samePeer } from '$lib/agentChatCore';
	import { agentChatState, chatList, seenCounts, peerLabel, myPeerId, agentTargets } from '$lib/agentChat';
	import { sessionLogs, aiChats, chatRoom, deleteLog, deleteAiChat } from '$lib/chat/chatSaves.js';
	import { historyList } from '$lib/chat/chatSavesCore.js';
	import { messages } from '../../stores/appStore';

	/** @type {{onpick: (row: import('$lib/chat/chatSavesCore.js').HistoryRow) => void, onnew?: (() => void) | null, onclose: () => void, activeId?: string | null}} */
	let { onpick, onnew = null, onclose, activeId = null } = $props();

	let query = $state('');
	let inputEl = $state(/** @type {HTMLInputElement | null} */ (null));
	let filter = $state(['all', 'people', 'ai'].includes(safeStorage.getItem('chat:historyFilter') ?? '') ? String(safeStorage.getItem('chat:historyFilter')) : 'all');
	$effect(() => {
		safeStorage.setItem('chat:historyFilter', filter);
	});

	const labelOf = $derived.by(() => {
		const targets = $agentTargets;
		return (/** @type {string} */ id) => targets.find((t) => samePeer(t.id, id))?.label ?? (id ? peerLabel(id) : '');
	});
	const agents = $derived(historyRows($agentChatState, $chatList, '', labelOf).map((r) => ({ ...r, label: r.label || (r.agent ? 'AI agent' : 'Assistant') })));
	const liveCount = $derived($messages.filter((/** @type {any} */ m) => (m.type === 'sent' || m.type === 'received') && (!m.saved || m.saved === $chatRoom.key)).length);
	const rows = $derived(historyList({ logs: $sessionLogs, agents, ai: $aiChats, room: $chatRoom, liveCount, filter, query }));

	/** an agent chat with something from somebody else this window has not shown @param {any} r */
	function unread(r) {
		if (r.kind !== 'agent') return false;
		const chat = $agentChatState.chats[r.id];
		if (!chat || r.id === activeId) return false;
		const me = myPeerId();
		const seen = $seenCounts[r.id] ?? 0;
		return chat.messages.slice(seen).some((/** @type {any} */ m) => !samePeer(m.from, me));
	}
	/** @param {number} at */
	function when(at) {
		if (!at || at === Number.MAX_SAFE_INTEGER) return '';
		const d = new Date(at);
		const today = new Date().toDateString() === d.toDateString();
		return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
	/** @param {any} r */
	const iconOf = (r) => (r.kind === 'people' ? 'users' : r.kind === 'agent' ? 'bot' : 'sparkles');
	/** a row this device keeps and can forget (not the scene you are in, not a scene's own agent chat) @param {any} r */
	const forgettable = (r) => (r.kind === 'people' && !r.current) || r.kind === 'ai';
	/** @param {any} r */
	function forget(r) {
		if (r.kind === 'people') void deleteLog(r.id);
		else if (r.kind === 'ai') void deleteAiChat(r.id);
	}

	onMount(() => {
		requestAnimationFrame(() => inputEl?.focus());
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
	id="ai-chat-history"
	class="chist"
	aria-label="Chat history"
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
		}
	}}
>
	<div class="chist-head">
		<SearchField bind:value={query} bind:inputEl placeholder="Search chats" label="Search chats" size="sm" id="ai-chat-search" />
		{#if onnew}
			<button type="button" id="ai-chat-history-new" class="chist-new" onclick={onnew}>
				<Icon name="plus" size={16} aria-hidden="true" /> New chat
			</button>
		{/if}
		<button type="button" class="chist-close" aria-label="Close chat history" title="Close" onclick={onclose}>
			<Icon name="x" size={16} />
		</button>
	</div>
	<div class="chist-filter">
		<Segmented
			id="chat-history-filter"
			label="Show"
			full
			bind:value={filter}
			options={[
				{ value: 'all', label: 'All' },
				{ value: 'people', label: 'People', icon: 'users' },
				{ value: 'ai', label: 'AI', icon: 'sparkles' }
			]}
		/>
	</div>
	<div class="chist-list" use:minimalScroll>
		{#if !rows.length}
			<p class="chist-empty">{query ? 'No chat matches “' + query + '”.' : 'No AI chats yet.'}</p>
		{/if}
		<ul role="list">
			{#each rows as r (r.kind + ':' + r.id)}
				<li class="chist-item">
					<button
						type="button"
						class="chist-row"
						class:active={r.id === activeId}
						data-chat={r.id}
						data-kind={r.kind}
						aria-current={r.id === activeId ? 'true' : undefined}
						onclick={() => onpick(r)}
					>
						<Icon name={iconOf(r)} size={16} aria-hidden="true" />
						<span class="chist-main">
							<span class="chist-title">{r.title}</span>
							<span class="chist-sub">{r.current ? 'This scene · ' : ''}{r.sub}</span>
						</span>
						<span class="chist-when">{when(r.updatedAt)}</span>
						{#if unread(r)}<span class="chist-unread" title="New messages" aria-label="New messages"></span>{/if}
					</button>
					{#if forgettable(r)}
						<button type="button" class="chist-forget" aria-label={'Remove ' + r.title + ' from this device'} title="Remove from this device" onclick={() => forget(r)}>
							<Icon name="trash-2" size={16} />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
</section>

<style>
	.chist {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: flex;
		flex-direction: column;
		background: var(--surface-1);
	}
	.chist-head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--border);
	}
	.chist-head :global(.tp-search),
	.chist-head :global(label) {
		flex: 1;
		min-width: 0;
	}
	.chist-filter {
		padding: 8px 10px 4px;
	}
	.chist-new {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		height: 28px;
		padding: 0 8px;
		border-radius: var(--radius-input);
		color: var(--accent-text);
		font-size: var(--fs-desc);
	}
	.chist-new:hover,
	.chist-close:hover,
	.chist-row:hover,
	.chist-forget:hover {
		background: var(--surface-hover);
	}
	.chist-close,
	.chist-forget {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-input);
		color: var(--text-muted);
	}
	.chist-forget {
		opacity: 0;
	}
	.chist-item:hover .chist-forget,
	.chist-forget:focus-visible {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.chist-forget {
			opacity: 1;
		}
	}
	.chist-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 6px 8px;
	}
	.chist-list ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.chist-item {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.chist-empty {
		padding: 16px 8px;
		text-align: center;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.chist-row {
		display: flex;
		flex: 1;
		min-width: 0;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-radius: 8px;
		text-align: left;
		color: var(--text-muted);
	}
	.chist-row.active {
		background: var(--surface-active);
	}
	.chist-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.chist-title,
	.chist-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chist-title {
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.chist-sub,
	.chist-when {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.chist-when {
		flex-shrink: 0;
	}
	.chist-unread {
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent);
	}
</style>
