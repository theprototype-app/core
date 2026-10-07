<script lang="ts">
	// Chat (phases 67+68): floating draggable window on the --z-window tier —
	// never underneath the flow drawer. Bubbles with author color chips and
	// timestamps, Enter to send, autoscroll with a new-messages pill, /hints.
	import '../../styles/chat.css';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Button from '../ui/Button.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import { peers, messages, chatHidden, username, userdata } from '../../stores/appStore';
	// 37 R15: emoji shortcodes (expanded on send) and @mentions (resolved on render)
	import { expandShortcodes, tokenizeChat, shortcodeSuggestions, mentionSuggestions } from '$lib/chatTokens';
	import { isLocked } from '../../stores/sceneStore';
	import { nameOf, peerColor } from '$lib/lockControl';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';

	let message = $state('');
	let scroller: any = $state(null);
	let atBottom = $state(true);
	let unread = $state(0);

	const COMMANDS = [
		{ cmd: '/create', help: 'add a primitive — /create box | sphere | cylinder …' },
		{ cmd: '/light', help: 'add a light — /light ambient | directional | hemisphere | point' },
		{ cmd: '/group', help: 'create a group — /group <name>' },
		{ cmd: '/clear', help: 'remove an object or everything — /clear <uuid> | all' },
		{ cmd: '/select', help: 'select an object — /select <uuid>' },
		{ cmd: '/transform', help: 'gizmo mode — /transform translate | rotate | scale' },
		{ cmd: '/grid', help: 'toggle the ground grid' },
		{ cmd: '/list', help: 'list scene objects here' }
	];
	const hints = $derived(
		message.startsWith('/')
			? COMMANDS.filter((c) => c.cmd.startsWith(message.split(' ')[0].toLowerCase()))
			: []
	);

	// 37 R15: who can be @mentioned — the roster plus us (a name, else the peer id)
	const myId = $derived($peers?.peer?.id ?? '');
	const people = $derived.by(() => {
		const out = ($userdata ?? [])
			.filter((row: any) => Array.isArray(row) && row[0])
			.map((row: any) => ({ id: String(row[0]), name: row[1] ? String(row[1]) : undefined }));
		if (myId && !out.some((p: any) => p.id === myId)) out.push({ id: myId, name: $username ?? undefined });
		return out;
	});
	// the word being typed decides the suggestions: "@ad" -> people, ":thu" -> emoji
	const lastWord = $derived(message.startsWith('/') ? '' : (message.match(/(?:^|\s)([@:][^\s]*)$/)?.[1] ?? ''));
	const suggestions = $derived.by(() => {
		if (lastWord.startsWith('@'))
			return mentionSuggestions(lastWord.slice(1), people, myId).map((p) => ({ key: p.id, label: '@' + p.label, insert: '@' + p.label + ' ', color: peerColor(p.id) }));
		const code = lastWord.match(/^:([a-z0-9_+-]{1,32})$/i)?.[1];
		if (code) return shortcodeSuggestions(code).map((e) => ({ key: e.code, label: e.emoji + '  :' + e.code + ':', insert: e.emoji + ' ', color: '' }));
		return [];
	});
	/** @param {{insert: string}} pick */
	function accept(pick: { insert: string }) {
		message = message.slice(0, message.length - lastWord.length) + pick.insert;
		document.getElementById('message')?.focus();
	}

	function send() {
		const text = message.trim();
		if (!text) return;
		$peers.sendMessage(text.startsWith('/') ? text : expandShortcodes(text));
		message = '';
	}
	// a line that @mentions us (and is not ours) is highlighted
	const mentionsMe = (tokens: any[]) => !!myId && tokens.some((t) => t.kind === 'mention' && t.id === myId);

	function onScroll() {
		if (!scroller) return;
		atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
		if (atBottom) unread = 0;
	}

	function scrollToBottom() {
		if (!scroller) return;
		scroller.scrollTop = scroller.scrollHeight;
		atBottom = true;
		unread = 0;
	}

	// pin to bottom on new messages; count them as unread while scrolled up
	let lastCount = 0;
	$effect(() => {
		const count = $messages.length;
		if (count === lastCount) return;
		const grew = count > lastCount;
		lastCount = count;
		if (!grew) return;
		if (atBottom) requestAnimationFrame(scrollToBottom);
		else unread++;
	});

	const isMine = (m: any) => m.type === 'sent' || m.sender === $peers?.peer?.id;
	const isNote = (m: any) => m.type === 'info' || m.type === 'system' || m.type === '';
	const authorName = (m: any) =>
		m.sender === $peers?.peer?.id ? $username || 'You' : nameOf(m.sender);
	const stamp = (m: any) =>
		m.ts
			? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: '';
</script>

<div id="chat" class={$chatHidden}>
	<div
		id="chat-window"
		use:dragWindow={{ key: 'chat', defaultRect: { right: 15, bottom: 15 } }}
		use:focusStack
		use:tabbable={{ key: 'chat', title: 'Chat', openStore: chatHidden, isOpen: (v) => v === '', close: () => chatHidden.set('hidden') }}
		class="ui-panel tp-ui tp-window flex h-[420px] w-[min(500px,90vw)] flex-col overflow-hidden"
		style="z-index: var(--z-window)"
	>
		<!-- 38 R6: the one window header (ui/WindowChrome); `ui-panel-header move-handle` is
		     the grip dragWindow / tabbing / docking read -->
		<WindowChrome
			size="tool"
			bare
			body={false}
			title="Chat"
			headerClass="ui-panel-header move-handle cursor-move select-none"
			onclose={() => chatHidden.set('hidden')}
			closeAttrs={{ title: 'Close (C)' }}
		/>

		<div class="relative min-h-0 flex-1">
			<div id="chat-messages" bind:this={scroller} onscroll={onScroll} class="h-full overflow-y-auto px-2 py-1">
				<ul id="messages" class="flex flex-col gap-1">
					{#each $messages as m (m)}
						{#if isNote(m)}
							<li class="chat-message chat-note {m.type}">
								{m.sender === 'SYSTEM' ? '' : authorName(m) + ' '}{m.text}
							</li>
						{:else}
							{@const tokens = tokenizeChat(m.text, people)}
							<li class={'chat-message chat-msg ' + m.type} class:chat-mine={isMine(m)}
								class:chat-mentions-me={!isMine(m) && mentionsMe(tokens)}>
								<span class="chat-av" style={'background:' + peerColor(m.sender)} aria-hidden="true">{(authorName(m) || '?').slice(0, 1).toUpperCase()}</span>
								<span class="min-w-0">
									<span class="chat-who">{authorName(m)}<small>{stamp(m)}</small></span>
									<!-- 37 R15: TEXT NODES ONLY — a peer's string never becomes markup -->
									<span class="chat-text wrap-break-word">{#each tokens as t, i (i)}{#if t.kind === 'mention'}<span class="chat-mention" style:--peer={peerColor(t.id)}>{t.text}</span>{:else}{t.text}{/if}{/each}</span>
								</span>
							</li>
						{/if}
					{/each}
				</ul>
				{#if !$messages.length}
					<EmptyState icon="message-square" title="No messages yet" description="Messages from everyone in this session appear here. Type / for commands." />
				{/if}
			</div>

			{#if unread > 0 && !atBottom}
				<button class="chat-unread absolute bottom-2 left-1/2 -translate-x-1/2" onclick={scrollToBottom}>
					{unread} new message{unread === 1 ? '' : 's'} ↓
				</button>
			{/if}
		</div>

		{#if !$isLocked}
			<div id="chat-input" class="chat-composer shrink-0">
				{#if suggestions.length}
					<div id="chat-suggestions" class="chat-hints mb-1.5 flex flex-wrap gap-1">
						{#each suggestions as pick (pick.key)}
							<button
								class="chat-suggestion chat-hint"
								style:color={pick.color || null}
								onclick={() => accept(pick)}>{pick.label}</button
							>
						{/each}
					</div>
				{/if}
				{#if hints.length}
					<div class="chat-hints mb-1.5 flex flex-col">
						{#each hints as hint}
							<button
								class="chat-hint"
								onclick={() => {
									message = hint.cmd + ' ';
									document.getElementById('message')?.focus();
								}}
							>
								<span class="chat-cmd">{hint.cmd}</span>
								<span class="chat-help">{hint.help}</span>
							</button>
						{/each}
					</div>
				{/if}
				<div class="flex items-center gap-1.5">
					<input
						type="text"
						id="message"
						class="tp-field flex-1"
						placeholder="Message — / for commands, @ for people, : for emoji"
						bind:value={message}
						onkeydown={(e) => {
							// Tab takes the first suggestion (an @name or an emoji)
							if (e.key === 'Tab' && suggestions.length) {
								e.preventDefault();
								accept(suggestions[0]);
								return;
							}
							if (e.key === 'Enter') send();
						}}
					/>
					<Button id="send" variant="primary" size="sm" onclick={send}>Send</Button>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	/* 38 R6: the chat body in the tokens — one message list (avatar · name · time · text),
	   your own lines marked by the accent avatar ring, not a second bubble colour */
	#messages {
		gap: 10px;
		padding: 10px 6px 4px;
	}
	.chat-msg {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: 8px;
		font-size: var(--fs-desc);
	}
	.chat-av {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		color: var(--on-accent);
		font-size: var(--fs-badge);
		font-weight: 600;
	}
	.chat-mine .chat-av {
		box-shadow: 0 0 0 2px var(--accent);
	}
	.chat-who {
		display: block;
		font-size: var(--fs-section);
		font-weight: 600;
		color: var(--text);
	}
	.chat-who small {
		margin-left: 6px;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		font-weight: 400;
		color: var(--text-faint);
	}
	.chat-text {
		display: block;
		margin-top: 2px;
		color: var(--text-2);
	}
	.chat-note {
		align-self: center;
		text-align: center;
		font-size: var(--fs-section);
		color: var(--text-faint);
	}
	.chat-unread {
		height: 26px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--accent-fill);
		color: var(--on-accent);
		font-size: var(--fs-section);
		font-weight: 500;
		box-shadow: var(--shadow-window);
		cursor: pointer;
	}
	.chat-composer {
		padding: 10px;
		border-top: 1px solid var(--border);
	}
	.chat-hints {
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.chat-hint {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 4px 8px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		font-size: var(--fs-section);
		text-align: left;
		cursor: pointer;
	}
	.chat-hint:hover {
		background: var(--surface-hover);
	}
	.chat-cmd {
		font-family: var(--font-ui-mono);
		font-weight: 500;
		color: var(--accent-text);
	}
	.chat-help {
		color: var(--text-muted);
	}
</style>
