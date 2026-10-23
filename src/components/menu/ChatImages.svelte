<script lang="ts">
	// Roadmap 56 C8 — a message's pictures in a thread: thumbnails (click = the preview window) and
	// Keep in Explorer on each (editors and admins; viewers see the pictures). 56-chat's thread renders
	// it at its `<!-- 56-media: ChatImages -->` spot: <ChatImages msg={m} chatId={chat.id} />.
	import Icon from '../ui/Icon.svelte';
	import { openImagePreview } from '$lib/fileWindows';
	import { imageUrl, keepImage, isKept, chatRefs } from '$lib/chat/tpchatStore.js';
	import { rolesInfo } from '$lib/cloudHooks';

	let { msg, chatId = '' }: { msg: any; chatId?: string } = $props();

	const images = $derived((msg?.images ?? []) as any[]);
	const editor = $derived(($rolesInfo as any)?.myRole !== 'viewer');
	let urls: (string | null)[] = $state([]);
	$effect(() => {
		const list = images;
		let live = true;
		void Promise.all(list.map((img) => imageUrl(img))).then((u) => {
			if (live) urls = u;
		});
		return () => {
			live = false;
		};
	});
	const kept = $derived.by(() => {
		void $chatRefs;
		return images.map((img) => isKept(img));
	});
</script>

{#if images.length}
	<span class="chat-images" role="list" aria-label="Pictures">
		{#each images as img, i (img.key ?? i)}
			<span class="chat-image" role="listitem">
				{#if urls[i]}
					<button
						type="button"
						class="chat-image-open"
						title={(img.name || 'picture') + (img.thumb ? ' (thumbnail — the chat outgrew its size cap)' : '')}
						onclick={() => openImagePreview({ title: img.name || 'picture', url: urls[i] ?? '' })}
					>
						<img src={urls[i]} alt={img.name || 'picture'} />
					</button>
				{:else}
					<span class="chat-image-missing" title="Not on this device yet"><Icon name="image" size={16} /></span>
				{/if}
				{#if editor}
					<button
						type="button"
						class="chat-image-keep"
						class:chat-kept={kept[i]}
						disabled={kept[i] || !urls[i]}
						aria-label={kept[i] ? 'Kept in Explorer' : 'Keep in Explorer'}
						title={kept[i] ? 'Kept in Explorer ▸ References' : 'Keep in Explorer (References folder)'}
						onclick={() => void keepImage(img, { chatId, msgId: msg?.id })}><Icon name={kept[i] ? 'check' : 'bookmark'} size={16} /></button
					>
				{/if}
			</span>
		{/each}
	</span>
{/if}

<style>
	.chat-images {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}
	.chat-image {
		position: relative;
		display: inline-flex;
	}
	.chat-image-open {
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		background: var(--surface-2);
		overflow: hidden;
		cursor: zoom-in;
	}
	.chat-image-open img {
		display: block;
		max-width: 160px;
		max-height: 120px;
		object-fit: cover;
	}
	.chat-image-missing {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-input);
		color: var(--text-faint);
	}
	.chat-image-keep {
		position: absolute;
		right: 2px;
		bottom: 2px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-input);
		background: var(--surface);
		color: var(--text-muted);
		cursor: pointer;
	}
	.chat-image-keep:hover:not(:disabled) {
		color: var(--text);
	}
	.chat-image-keep.chat-kept {
		color: var(--accent-text);
	}
</style>
