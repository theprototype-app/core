<script lang="ts">
	import { MessageSquare } from '@lucide/svelte';
	// Chat (phases 67+68): floating draggable window on the --z-window tier —
	// never underneath the flow drawer. Bubbles with author color chips and
	// timestamps, Enter to send, autoscroll with a new-messages pill, /hints.
	import '../../styles/chat.css';
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
		class="ui-panel flex h-[420px] w-[min(500px,90vw)] flex-col overflow-hidden bg-gray-900/85 backdrop-blur-sm"
		style="z-index: var(--z-window)"
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span><MessageSquare size={16} class="mr-1" aria-hidden="true" />Chat</span>
			<span class="flex-1"></span>
			<button class="ui-button-quiet" title="Close (C)" onclick={() => chatHidden.set('hidden')}>✕</button>
		</div>

		<div class="relative min-h-0 flex-1">
			<div id="chat-messages" bind:this={scroller} onscroll={onScroll} class="h-full overflow-y-auto px-2 py-1">
				<ul id="messages" class="flex flex-col gap-1">
					{#each $messages as m (m)}
						{#if isNote(m)}
							<li class="chat-message {m.type} self-center text-center text-[11px] italic text-gray-400">
								{m.sender === 'SYSTEM' ? '' : authorName(m) + ' '}{m.text}
							</li>
						{:else}
							{@const tokens = tokenizeChat(m.text, people)}
							<li class={'chat-message ' + m.type + ' max-w-[85%] rounded-lg px-2 py-1 text-sm ' +
								(isMine(m)
									? 'self-end rounded-br-sm bg-primary-800/80 text-primary-50'
									: 'self-start rounded-bl-sm bg-gray-700/80 text-gray-100')}
								class:chat-mentions-me={!isMine(m) && mentionsMe(tokens)}>
								<span class="flex items-baseline gap-1.5">
									<span class="h-2 w-2 shrink-0 self-center rounded-full" style={'background:' + peerColor(m.sender)}></span>
									<span class="text-[11px] font-semibold opacity-90">{authorName(m)}</span>
									<span class="text-[9px] text-gray-400">{stamp(m)}</span>
								</span>
								<!-- 37 R15: TEXT NODES ONLY — a peer's string never becomes markup -->
								<span class="wrap-break-word">{#each tokens as t, i (i)}{#if t.kind === 'mention'}<span class="chat-mention" style:color={peerColor(t.id)} style:border-color={peerColor(t.id)}>{t.text}</span>{:else}{t.text}{/if}{/each}</span>
							</li>
						{/if}
					{/each}
				</ul>
			</div>

			{#if unread > 0 && !atBottom}
				<button
					class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-primary-700 px-3 py-0.5 text-xs text-white shadow-lg hover:bg-primary-600"
					onclick={scrollToBottom}
				>
					{unread} new message{unread === 1 ? '' : 's'} ↓
				</button>
			{/if}
		</div>

		{#if !$isLocked}
			<div id="chat-input" class="shrink-0 border-t border-gray-700/60 p-2">
				{#if suggestions.length}
					<div id="chat-suggestions" class="mb-1 flex flex-wrap gap-1 rounded-md border border-gray-700/60 bg-gray-800/95 p-1 text-xs">
						{#each suggestions as pick (pick.key)}
							<button
								class="chat-suggestion rounded-sm px-1.5 py-0.5 text-left hover:bg-gray-700"
								style:color={pick.color || null}
								onclick={() => accept(pick)}>{pick.label}</button
							>
						{/each}
					</div>
				{/if}
				{#if hints.length}
					<div class="mb-1 flex flex-col gap-0.5 rounded-md border border-gray-700/60 bg-gray-800/95 p-1 text-xs">
						{#each hints as hint}
							<button
								class="flex items-baseline gap-2 rounded-sm px-1.5 py-0.5 text-left hover:bg-gray-700"
								onclick={() => {
									message = hint.cmd + ' ';
									document.getElementById('message')?.focus();
								}}
							>
								<span class="font-mono font-semibold text-primary-300">{hint.cmd}</span>
								<span class="text-gray-400">{hint.help}</span>
							</button>
						{/each}
					</div>
				{/if}
				<div class="flex items-center gap-1.5">
					<input
						type="text"
						id="message"
						class="ui-input min-w-0 flex-1"
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
					<button
						id="send"
						class="shrink-0 rounded-lg bg-primary-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-600"
						onclick={send}
					>
						Send
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
