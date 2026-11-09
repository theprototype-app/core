<script>
	// showhide-v8 §2 — AN IMAGE'S PAST IN THE EXPLORER'S "File history" TAB. The versions are the image editor's
	// own (imageVersions: the original, never pruned, plus the last saves, LOCAL to this device); this is a second,
	// read-and-restore view of that list beside the file, so you need not open the editor to go back. Restoring goes
	// through the editor's one restore path (it keeps the replaced bytes in the list and re-textures the scene).
	// Renders itself away for anything that is not a library image.
	import UiButton from '../ui/Button.svelte';
	import { listImageVersions, imageVersionsTick, MAX_VERSIONS } from '$lib/image/imageVersions';
	import { restoreImageVersion } from '$lib/image/imageEditor';
	import { showToast } from '../../stores/appStore';

	let { item = null } = $props();

	const isImage = $derived(!!item && item.kind === 'image' && !item.packEntry && typeof item.id === 'string');
	let versions = $state.raw(/** @type {import('$lib/image/imageVersions').ImageVersion[]} */ ([]));
	let busy = $state(false);
	$effect(() => {
		void $imageVersionsTick;
		const id = isImage ? item.id : null;
		void item?.hash;
		if (!id) {
			versions = [];
			return;
		}
		listImageVersions(id).then((list) => {
			if (item?.id === id) versions = list;
		});
	});
	/** @param {string} hash @param {string} label */
	async function restore(hash, label) {
		if (!item || busy) return;
		busy = true;
		try {
			const res = await restoreImageVersion(item.id, hash);
			if (res) showToast('Restored ' + label + (res.textures ? ' — updated ' + res.textures + ' texture' + (res.textures === 1 ? '' : 's') : ''));
		} finally {
			busy = false;
		}
	}
	/** @param {number} at */
	const when = (at) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	/** @param {number} b */
	const bytes = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
</script>

{#if isImage}
	<div id="image-history" class="ih-wrap">
		{#if versions.length}
			<ul class="ih-list">
				{#each [...versions].reverse() as v (v.hash)}
					{@const current = v.hash === item.hash}
					<li class="ih-row" class:ih-current={current} data-version={v.hash}>
						{#if v.thumb}<img src={v.thumb} alt="" class="ih-thumb" />{:else}<span class="ih-thumb"></span>{/if}
						<div class="ih-text">
							<span class="ih-label">{v.label}{current ? ' · current' : ''}</span>
							<span class="ih-meta">{when(v.at)}{v.width ? ' · ' + v.width + '×' + v.height : ''} · {bytes(v.size)}</span>
						</div>
						{#if !current}
							<UiButton size="sm" variant="ghost" data-ih-restore disabled={busy} onclick={() => restore(v.hash, v.label)}>Restore</UiButton>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="ih-note">Kept on this device: the original and the last {MAX_VERSIONS - 1} saves. Peers get the saved image, not this list.</p>
		{:else}
			<p class="ih-note">No saved versions yet. The first Save in the image editor keeps the original here.</p>
		{/if}
	</div>
{/if}

<style>
	.ih-wrap {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.ih-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.ih-row {
		display: flex;
		align-items: center;
		gap: 8px;
		border-radius: 4px;
		padding: 4px;
	}
	.ih-current {
		background: var(--accent-soft);
	}
	.ih-thumb {
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: 3px;
		border: 1px solid var(--border);
		object-fit: cover;
		background: var(--surface-2);
	}
	.ih-text {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
	}
	.ih-label {
		font-size: var(--fs-body);
		color: var(--text);
	}
	.ih-meta,
	.ih-note {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.ih-meta {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
