<script>
	// 78 F5: the ONE banner for the viewport capture stack — what owns the next click in the 3D
	// view, how to leave it (Esc pops the top), and what is still armed underneath. The tools keep
	// their own toolboxes for their settings; this strip is the one place that always says which
	// tool is listening, so a capture can never be armed with nothing on screen.
	import Icon from '../ui/Icon.svelte';
	import { captureStack, topCapture } from '$lib/captureStack';
	import { isLocked, isVRMode } from '../../stores/sceneStore';

	const shown = $derived(!!$topCapture && !$isVRMode && $isLocked !== true);
	const below = $derived($captureStack.slice(0, -1).reverse());
</script>

{#if shown && $topCapture}
	<div id="capture-banner" class="capture-banner" role="status" aria-live="polite" data-capture={$topCapture.id} data-depth={$captureStack.length}>
		<Icon name={$topCapture.icon ?? 'crosshair'} size={16} aria-hidden="true" />
		<span class="font-semibold">{$topCapture.label}</span>
		{#if $topCapture.hint}<span class="cb-hint">{$topCapture.hint}</span>{/if}
		<kbd class="cb-key" title="Esc leaves {$topCapture.label.toLowerCase()}">Esc</kbd>
		{#if below.length}
			<span class="cb-below" id="capture-banner-below" title={'Still armed: ' + below.map((c) => c.label).join(', ')}>
				then {below[0].label.toLowerCase()}{below.length > 1 ? ` +${below.length - 1}` : ''}
			</span>
		{/if}
		<button
			id="capture-banner-done"
			type="button"
			class="cb-done"
			aria-label={'Finish: ' + $topCapture.label}
			title={'Finish ' + $topCapture.label.toLowerCase()}
			onclick={() => ($topCapture.done ?? $topCapture.escape)()}
		>
			<Icon name="check" size={16} aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	.capture-banner {
		position: fixed;
		top: 52px;
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-chrome);
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: calc(100vw - 32px);
		padding: 3px 4px 3px 12px;
		border-radius: 9999px;
		border: 1px solid var(--accent);
		background: var(--surface-1);
		color: var(--text);
		font-size: 12px;
		white-space: nowrap;
		box-shadow: 0 4px 14px color-mix(in srgb, var(--bg-app) 45%, transparent);
	}
	.cb-hint,
	.cb-below {
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cb-key {
		padding: 0 5px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		font-size: 11px;
		color: var(--text-2);
	}
	.cb-done {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 9999px;
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.cb-done:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	@media (max-width: 640px) {
		.cb-hint {
			display: none;
		}
	}
</style>
