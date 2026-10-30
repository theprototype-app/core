<script lang="ts">
	// Roadmap 56 C8 — the composer's pictures: a + button (From device · Camera on phones · From
	// Explorer · Viewport screenshot · Selection — ask about this), paste, a file drop and a drag from
	// the Explorer onto the AI window, and the tray of what will go with the next message. Every way in
	// ends in attachments.prepareImage: downscaled and EXIF/GPS-stripped HERE, before anything is sent.
	// The window owns sending: it reads `pending` (ready for the request's `images`) and clears it.
	// Viewers see no + (C5: editors and admins attach). Mounted with ONE line in the composer row.
	import { onMount } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { showToast } from '../../stores/appStore';
	import { explorerItems } from '$lib/explorer';
	import { canAttach, prepareFiles, viewportPicture, selectionPicture, explorerPicture, composerPending, keepSentPictures } from '$lib/chat/attachments.js';
	import { MAX_ATTACHMENTS } from '$lib/chat/attachCore.js';
	import { keepImage, isKept, openChat, chatRefs } from '$lib/chat/tpchatStore.js';
	import { rolesInfo } from '$lib/cloudHooks';

	let { pending = $bindable([]), disabled = false }: { pending?: any[]; disabled?: boolean } = $props();

	let root: HTMLElement | null = $state(null);
	let fileInput: HTMLInputElement | null = $state(null);
	let cameraInput: HTMLInputElement | null = $state(null);
	let menu: { x: number; y: number } | null = $state(null);
	let busy = $state(false);
	let dragOver = $state(false);

	const allowed = $derived(($rolesInfo as any)?.myRole !== 'viewer');
	const phone = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
	const room = $derived(MAX_ATTACHMENTS - pending.length);
	// re-read on every References change so a tray picture shows "Kept" once it is
	const kept = $derived.by(() => {
		void $chatRefs;
		return pending.map((p) => isKept(p));
	});

	$effect(() => composerPending.set(pending));

	// "Keep sent pictures in Explorer": the window empties `pending` when it SENDS; an emptying this
	// component did not cause itself is that moment
	let lastSeen: any[] = [];
	let removing = false;
	$effect(() => {
		const now = pending;
		if (!now.length && lastSeen.length && !removing && $keepSentPictures)
			for (const p of lastSeen) if (!isKept(p)) void keepImage(p);
		lastSeen = now;
		removing = false;
	});

	function add(list: any[]) {
		if (list.length) pending = [...pending, ...list].slice(0, MAX_ATTACHMENTS);
	}
	function report(errors: string[]) {
		if (errors.length) showToast(errors.join(' · '));
	}

	async function addFiles(files: Iterable<File> | FileList | null) {
		if (!files) return;
		if (!canAttach()) return showToast('View-only — editors and admins can attach pictures.');
		const list = [...files];
		if (!list.length) return;
		if (room <= 0) return showToast(`At most ${MAX_ATTACHMENTS} pictures per message`);
		busy = true;
		try {
			const { ready, errors } = await prepareFiles(list, room);
			add(ready);
			report(errors);
		} finally {
			busy = false;
		}
	}

	async function addOne(make: () => Promise<any>) {
		if (!canAttach()) return showToast('View-only — editors and admins can attach pictures.');
		if (room <= 0) return showToast(`At most ${MAX_ATTACHMENTS} pictures per message`);
		busy = true;
		try {
			const r = await make();
			if (r?.error) showToast(r.error);
			else if (r?.image) {
				add([r.image]);
				if (r.text) prependPrompt(r.text);
			} else if (r) add([r]);
		} finally {
			busy = false;
		}
	}

	/** "ask about this": the words naming the selection go in front of what the person types */
	function prependPrompt(text: string) {
		const input = root?.closest('.ai-composer')?.querySelector('input[type="text"], textarea') as HTMLInputElement | null;
		if (!input) return;
		if (!input.value.startsWith(text)) {
			input.value = text + input.value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		input.focus();
	}

	function remove(i: number) {
		removing = true;
		pending = pending.filter((_, k) => k !== i);
	}

	async function keep(i: number) {
		const item = await keepImage(pending[i]);
		if (item) pending = [...pending]; // re-derive "Kept"
	}

	const explorerImages = $derived(
		($explorerItems as any[])
			.filter((i) => i.kind === 'image')
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			.slice(0, 24)
	);

	const menuItems = $derived([
		{ label: 'From device…', icon: 'upload', action: () => fileInput?.click() },
		...(phone ? [{ label: 'Camera', icon: 'camera', action: () => cameraInput?.click() }] : []),
		explorerImages.length
			? {
					label: 'From Explorer',
					icon: 'folder-open',
					children: explorerImages.map((it) => ({ label: it.name, icon: 'image', action: () => void addOne(() => explorerPicture(it.id)) }))
				}
			: { label: 'From Explorer (no pictures yet)', icon: 'folder-open', disabled: true, action: () => {} },
		{ label: 'Viewport screenshot', icon: 'monitor', action: () => void addOne(viewportPicture) },
		{ label: 'Selection — ask about this', icon: 'box-select', action: () => void addOne(selectionPicture) }
	]);

	function openMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { x: r.left, y: r.top - 8 };
	}

	// paste + drop reach the WHOLE window (the composer row is a thin target), wired from here so
	// the window needs one line
	onMount(() => {
		const win = root?.closest('.tp-window') as HTMLElement | null;
		if (!win) return;
		const onPaste = (e: ClipboardEvent) => {
			const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
			if (!files.length) return;
			e.preventDefault();
			void addFiles(files);
		};
		const carries = (e: DragEvent) => {
			const types = [...(e.dataTransfer?.types ?? [])];
			return types.includes('Files') || types.includes('application/x-explorer-item');
		};
		const onDragOver = (e: DragEvent) => {
			if (!carries(e)) return;
			e.preventDefault();
			dragOver = true;
		};
		const onDragLeave = (e: DragEvent) => {
			if (e.target === win || !win.contains(e.relatedTarget as Node)) dragOver = false;
		};
		const onDrop = async (e: DragEvent) => {
			if (!carries(e)) return;
			e.preventDefault();
			e.stopPropagation(); // the viewport under the window must not place the file too
			dragOver = false;
			const raw = e.dataTransfer?.getData('application/x-explorer-item');
			if (raw) {
				let payload: any = null;
				try {
					payload = JSON.parse(raw);
				} catch {}
				if (payload?.chatId) return void openChat(payload.chatId); // C11: a .tpchat card opens its chat
				const id = payload?.refItemId ?? payload?.id;
				if (payload?.kind === 'image' && id) return void addOne(() => explorerPicture(id));
				if (/\.tpchat$/i.test(payload?.name ?? '') && payload?.id) {
					const { chatIdOfItem } = await import('$lib/chat/tpchatStore.js');
					const chatId = await chatIdOfItem({ id: payload.id, name: payload.name });
					if (chatId) openChat(chatId);
					return;
				}
				return showToast('Only pictures (and chats) can be dropped on the assistant');
			}
			const files = [...(e.dataTransfer?.files ?? [])];
			const chat = files.find((f) => /\.tpchat$/i.test(f.name));
			if (chat) {
				const { chatIdOfItem } = await import('$lib/chat/tpchatStore.js');
				const chatId = await chatIdOfItem(chat);
				if (chatId) openChat(chatId);
				else showToast(chat.name + ' is not a chat this version can read');
				return;
			}
			void addFiles(files);
		};
		win.addEventListener('paste', onPaste);
		win.addEventListener('dragover', onDragOver);
		win.addEventListener('dragleave', onDragLeave);
		win.addEventListener('drop', onDrop);
		return () => {
			win.removeEventListener('paste', onPaste);
			win.removeEventListener('dragover', onDragOver);
			win.removeEventListener('dragleave', onDragLeave);
			win.removeEventListener('drop', onDrop);
		};
	});

	$effect(() => {
		const win = root?.closest('.tp-window') as HTMLElement | null;
		win?.classList.toggle('chat-drop-target', dragOver);
	});
</script>

<span class="chat-attach" bind:this={root}>
	{#if allowed}
		<button
			id="chat-attach"
			type="button"
			class="chat-attach-btn shrink-0"
			aria-label="Add a picture"
			aria-haspopup="menu"
			title={room > 0 ? 'Add a picture (paste or drop works too)' : `At most ${MAX_ATTACHMENTS} pictures per message`}
			disabled={disabled || busy || room <= 0}
			onclick={openMenu}
		>
			<Icon name={busy ? 'loader-circle' : 'plus'} size={16} />
		</button>
		<input bind:this={fileInput} id="chat-attach-file" type="file" accept="image/*,.heic,.heif" multiple hidden onchange={(e) => { void addFiles((e.currentTarget as HTMLInputElement).files); (e.currentTarget as HTMLInputElement).value = ''; }} />
		<input bind:this={cameraInput} id="chat-attach-camera" type="file" accept="image/*" capture="environment" hidden onchange={(e) => { void addFiles((e.currentTarget as HTMLInputElement).files); (e.currentTarget as HTMLInputElement).value = ''; }} />
	{/if}
	{#if pending.length}
		<span class="chat-tray" role="list" aria-label="Pictures to send">
			{#each pending as p, i (p.data.slice(-24) + i)}
				<span class="chat-attach-thumb" role="listitem" title={p.name + ' · ' + p.w + '×' + p.h + ' · ' + Math.round(p.bytes / 1024) + ' KB · location data removed'}>
					<img src={'data:' + p.mimeType + ';base64,' + p.data} alt={p.name} />
					<button type="button" class="chat-thumb-x" aria-label={'Remove ' + p.name} onclick={() => remove(i)}><Icon name="x" size={16} /></button>
					<button
						type="button"
						class="chat-thumb-keep"
						class:chat-kept={kept[i]}
						aria-label={kept[i] ? 'Kept in Explorer' : 'Keep in Explorer'}
						title={kept[i] ? 'Kept in Explorer ▸ References' : 'Keep in Explorer (References folder)'}
						disabled={kept[i]}
						onclick={() => keep(i)}><Icon name={kept[i] ? 'check' : 'bookmark'} size={16} /></button
					>
				</span>
			{/each}
		</span>
	{/if}
</span>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menuItems} sizeKey="chatAttach" onclose={() => (menu = null)} />
{/if}

<style>
	.chat-attach {
		display: contents;
	}
	.chat-attach-btn {
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
	.chat-attach-btn:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.chat-attach-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.chat-tray {
		display: inline-flex;
		gap: 4px;
		flex-shrink: 0;
	}
	.chat-attach-thumb {
		position: relative;
		display: inline-flex;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-input);
		overflow: hidden;
		border: 1px solid var(--border);
		background: var(--surface-2);
	}
	.chat-attach-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.chat-thumb-x,
	.chat-thumb-keep {
		position: absolute;
		display: none;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-input);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.chat-thumb-x {
		top: 0;
		right: 0;
	}
	.chat-thumb-keep {
		bottom: 0;
		left: 0;
	}
	.chat-thumb-keep.chat-kept {
		display: inline-flex;
		color: var(--accent-text);
	}
	.chat-attach-thumb:hover .chat-thumb-x,
	.chat-attach-thumb:hover .chat-thumb-keep,
	.chat-attach-thumb:focus-within .chat-thumb-x,
	.chat-attach-thumb:focus-within .chat-thumb-keep {
		display: inline-flex;
	}
	:global(.tp-window.chat-drop-target) {
		outline: 2px dashed var(--accent);
		outline-offset: -2px;
	}
</style>
