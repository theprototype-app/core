<script module>
	/** the painter (meshPaint.js), imported from THIS lazy chunk so its long preload list stays out of the boot one */
	export function loadPainter() {
		return import('$lib/meshPaint');
	}
</script>

<script>
	// 102 M6: the UV editor's brush panel for painting on meshes (channel, value, hardness / opacity / flow, eraser,
	// Mirror X, stamp, new-map size, channel view, what a stroke paints). A lazy chunk: UvEditor imports it with the
	// painter (meshPaint.js) when Paint is armed, so none of it is in the boot bundle.
	import Icon from '../ui/Icon.svelte';
	import HudImagePicker from '../hud/HudImagePicker.svelte';
	import {
		paintChannel, paintValue, paintHardness, paintOpacity, paintFlow, paintErase, paintMirror, paintStamp,
		paintMapSize, paintShowChannel, paintTargetInfo
	} from '$lib/meshPaintPrefs';

	const CHANNEL_CHOICES = /** @type {const} */ ([
		['color', 'Colour', 'Paint the base colour'],
		['roughness', 'Rough', 'Paint roughness: white is rough, black is shiny'],
		['metalness', 'Metal', 'Paint metalness: white is metal, black is not'],
		['emissive', 'Glow', 'Paint emission: where the surface glows, in the brush colour']
	]);
</script>

<div class="mt-3 text-[11px] text-text-muted">Channel</div>
<div id="paint-channel" class="mt-1 grid grid-cols-4 gap-1" role="radiogroup" aria-label="Paint channel">
	{#each CHANNEL_CHOICES as [value, label, hint] (value)}
		<button
			type="button"
			role="radio"
			aria-checked={$paintChannel === value}
			data-value={value}
			title={hint}
			class={'rounded-sm px-1 py-0.5 text-[11px] ' + ($paintChannel === value ? 'bg-accent-fill text-on-accent' : 'bg-surface-2 text-text-2 hover:bg-surface-active')}
			onclick={() => paintChannel.set(/** @type {any} */ (value))}>{label}</button>
	{/each}
</div>
{#if $paintChannel === 'roughness' || $paintChannel === 'metalness'}
	<label class="mt-2 block text-[11px] text-text-muted" title="The value the brush paints. A map multiplies the material's own slider.">
		Value <span class="tabular-nums text-text-2">{$paintValue.toFixed(2)}</span>
		<input id="paint-value" type="range" min="0" max="1" step="0.01" class="mt-1 w-full accent-accent"
			value={$paintValue} oninput={(e) => paintValue.set(parseFloat(e.currentTarget.value) || 0)} />
	</label>
{/if}
<label class="mt-2 block text-[11px] text-text-muted" title="1 is a hard edge; lower fades the edge softly">
	Hardness <span class="tabular-nums text-text-2">{Math.round($paintHardness * 100)}%</span>
	<input id="paint-hardness" type="range" min="0" max="1" step="0.01" class="mt-1 w-full accent-accent"
		value={$paintHardness} oninput={(e) => paintHardness.set(parseFloat(e.currentTarget.value))} />
</label>
<label class="mt-2 block text-[11px] text-text-muted" title="The most one stroke can reach, however often you go over a spot">
	Opacity <span class="tabular-nums text-text-2">{Math.round($paintOpacity * 100)}%</span>
	<input id="paint-opacity" type="range" min="0.01" max="1" step="0.01" class="mt-1 w-full accent-accent"
		value={$paintOpacity} oninput={(e) => paintOpacity.set(parseFloat(e.currentTarget.value))} />
</label>
<label class="mt-2 block text-[11px] text-text-muted" title="How much each dab adds: low flow builds up as you go over a spot">
	Flow <span class="tabular-nums text-text-2">{Math.round($paintFlow * 100)}%</span>
	<input id="paint-flow" type="range" min="0.01" max="1" step="0.01" class="mt-1 w-full accent-accent"
		value={$paintFlow} oninput={(e) => paintFlow.set(parseFloat(e.currentTarget.value))} />
</label>
<div class="mt-2 flex gap-1">
	<button id="paint-erase" type="button" aria-pressed={$paintErase}
		title="Eraser: paints back to the material's own colour or value (white for colour, roughness and metalness, black for glow)"
		class={'flex flex-1 items-center justify-center gap-1 rounded-sm px-2 py-0.5 text-[11px] ' + ($paintErase ? 'bg-accent-fill text-on-accent' : 'bg-surface-2 text-text-2 hover:bg-surface-active')}
		onclick={() => paintErase.update((v) => !v)}><Icon name="eraser" size={12} aria-hidden="true" />Eraser</button>
	<button id="paint-mirror" type="button" aria-pressed={$paintMirror}
		title="Mirror X: a stroke on the model also paints its mirror across the object's own X axis (not in this 2D view)"
		class={'flex flex-1 items-center justify-center gap-1 rounded-sm px-2 py-0.5 text-[11px] ' + ($paintMirror ? 'bg-accent-fill text-on-accent' : 'bg-surface-2 text-text-2 hover:bg-surface-active')}
		onclick={() => paintMirror.update((v) => !v)}><Icon name="flip-horizontal" size={12} aria-hidden="true" />Mirror X</button>
</div>
<div class="mt-2 text-[11px] text-text-muted" title="Use an image as the brush tip: its transparency (or its dark parts) is where it paints">Stamp</div>
<div id="paint-stamp" class="mt-1 flex">
	<HudImagePicker hash={$paintStamp} onpick={(next) => paintStamp.set(next)} />
</div>
<div class="mt-2 text-[11px] text-text-muted" title="How big a new map is when a stroke paints a slot that has no image yet">New map</div>
<div id="paint-map-size" class="mt-1 flex gap-1" role="radiogroup" aria-label="New map size">
	{#each [[1024, '1k'], [2048, '2k']] as [value, label] (value)}
		<button type="button" role="radio" aria-checked={$paintMapSize === value} data-value={value}
			title={'A new map is ' + value + ' x ' + value + ' pixels'}
			class={'flex-1 rounded-sm px-2 py-0.5 text-[11px] ' + ($paintMapSize === value ? 'bg-accent-fill text-on-accent' : 'bg-surface-2 text-text-2 hover:bg-surface-active')}
			onclick={() => paintMapSize.set(/** @type {any} */ (value))}>{label}</button>
	{/each}
</div>
<label class="mt-2 flex items-center gap-2 text-[11px] text-text-muted" title="Show the channel you are painting by itself on the model (only on your screen)">
	<input id="paint-show-channel" type="checkbox" class="tp-check" checked={$paintShowChannel}
		onchange={(e) => paintShowChannel.set(e.currentTarget.checked)} />
	Show this channel alone
</label>
{#if $paintTargetInfo?.mode === 'vertex'}
	<p id="paint-target-info" class="mt-2 rounded-sm bg-surface-2 p-1.5 text-[10px] leading-relaxed text-ink-warn" role="status">
		{$paintTargetInfo.reason}
	</p>
{/if}
<p class="mt-2 text-[10px] leading-relaxed text-text-faint">
	Paint on the model in the viewport too: drag over the selected object. <span class="text-text-2">Alt+click</span>
	picks the colour (or value) under the cursor, <span class="text-text-2">[</span> and <span class="text-text-2">]</span>
	size the brush, <span class="text-text-2">Esc</span> cancels a stroke. A shared material asks whether to paint
	every object that wears it.
</p>
