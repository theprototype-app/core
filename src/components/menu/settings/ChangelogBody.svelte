<script>
	// 37-settings — Settings ▸ About ▸ What's new: the same changelog the What's new window shows
	// ($lib/changelog.js), in the redesign's tokens, as a SUB-PAGE of Settings (no window on top of
	// the window). The newest release open, the history folded behind its heading. Opening it marks
	// the version seen, like the window (`markWhatsNewSeen`).
	import { onMount } from 'svelte';
	import { CHANGELOG, markWhatsNewSeen } from '$lib/whatsNew';
	import { changelogReleases } from '$lib/changelog.js';

	const { intro, releases } = changelogReleases(CHANGELOG);
	onMount(() => markWhatsNewSeen());
</script>

{#snippet body(/** @type {import('$lib/changelog.js').Block[]} */ list)}
	{#each list as block, i (i)}
		{#if block.kind === 'h3'}
			<h3>{@html block.html}</h3>
		{:else if block.kind === 'h4'}
			<h4>{@html block.html}</h4>
		{:else if block.kind === 'ul'}
			<ul>
				{#each block.items ?? [] as item, j (j)}
					<li>{@html item}</li>
				{/each}
			</ul>
		{:else}
			<p>{@html block.html}</p>
		{/if}
	{/each}
{/snippet}

<div id="settings-whats-new" class="tp-ui cl">
	{@render body(intro)}
	{#each releases as release, index (release.title)}
		<details class="cl-release" open={index === 0}>
			<summary><h2>{@html release.title}</h2></summary>
			{@render body(release.body)}
		</details>
	{/each}
</div>

<style>
	.cl {
		font-size: var(--fs-desc);
		line-height: 1.6;
		color: var(--text-2);
	}
	.cl h2 {
		display: inline;
		margin: 0;
		font-size: var(--fs-panel-title);
		font-weight: 600;
		color: var(--text);
	}
	.cl-release > summary {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 18px 0 8px;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
		list-style: none;
	}
	.cl-release:first-of-type > summary {
		margin-top: 0;
	}
	.cl-release > summary::-webkit-details-marker {
		display: none;
	}
	.cl-release > summary::before {
		content: '';
		flex: 0 0 auto;
		border-left: 5px solid var(--text-faint);
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		transition: transform 120ms ease;
	}
	.cl-release[open] > summary::before {
		transform: rotate(90deg);
	}
	.cl h3 {
		margin: 14px 0 6px;
		font-size: var(--fs-body);
		font-weight: 600;
		color: var(--text);
	}
	.cl h4 {
		margin: 10px 0 4px;
		font-size: var(--fs-desc);
		font-weight: 600;
		color: var(--text-2);
	}
	.cl p {
		margin: 6px 0;
	}
	.cl ul {
		margin: 6px 0 10px;
		padding-left: 18px;
		list-style: disc;
	}
	.cl li {
		margin: 3px 0;
	}
	.cl :global(strong) {
		font-weight: 600;
		color: var(--text);
	}
	.cl :global(code) {
		padding: 1px 5px;
		border-radius: 5px;
		background: var(--surface-inset);
		font-family: var(--font-ui-mono);
		font-size: 0.92em;
		color: var(--text);
	}
	.cl :global(a) {
		color: var(--accent-text);
		text-decoration: underline;
	}
</style>
