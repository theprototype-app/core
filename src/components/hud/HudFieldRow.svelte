<script>
	// 21-D1 — ONE row renderer for a `hudKinds` field.
	//
	// The properties pane has no per-kind branch: it walks `fieldsForKind` / `styleFieldsForKind`
	// and renders each entry through this component (the `ShaderNode` dispatch-on-param.type
	// shape). A new kind is one registry entry and no UI change at all.
	import DragRow from '../ui/DragRow.svelte';
	import HudImagePicker from './HudImagePicker.svelte';

	/** @type {{ field: any, value: any, onchange: (next: any) => void }} */
	let { field, value, onchange } = $props();

	const label = $derived(field?.label ?? field?.key ?? '');
	const isInt = $derived((field?.step ?? 1) >= 1);
</script>

{#if field.kind === 'number'}
	<DragRow
		{label}
		value={Number(value ?? 0)}
		step={field.step ?? 1}
		decimals={isInt ? 0 : 2}
		min={field.min ?? -Infinity}
		max={field.max ?? Infinity}
		title={field.hint ?? ''}
		onchange={(/** @type {number} */ v) => onchange(isInt ? Math.round(v) : v)}
	/>
{:else if field.kind === 'toggle'}
	<label class="hud-field" title={field.hint ?? ''}>
		<span>{label}</span>
		<span class="hud-field-ctl">
			<input type="checkbox" checked={!!value} onchange={(/** @type {any} */ e) => onchange(e.currentTarget.checked)} />
		</span>
	</label>
{:else if field.kind === 'select'}
	<label class="hud-field" title={field.hint ?? ''}>
		<span>{label}</span>
		<select class="hud-input" value={String(value ?? field.options?.[0] ?? '')} onchange={(/** @type {any} */ e) => onchange(e.currentTarget.value)}>
			{#each field.options ?? [] as option (option)}<option value={option}>{option}</option>{/each}
		</select>
	</label>
{:else if field.kind === 'color'}
	<!-- a colour may be a THEME TOKEN name or a literal, so this stays a text field: a
	     native colour input cannot express `accent`, and tokens are the point (they follow
	     the user's theme, with a literal fallback so a custom theme cannot unpaint them). -->
	<label class="hud-field" title={field.hint ?? 'A #hex, an rgb(), or a theme token name like accent'}>
		<span>{label}</span>
		<span class="hud-field-ctl">
			{#if String(value ?? '')}
				<span class="hud-swatch" style="background: {String(value).startsWith('#') || String(value).startsWith('rgb') ? value : `var(--${value}, #888)`}"></span>
			{/if}
			<input
				class="hud-input"
				placeholder="#f3f4f6 or accent"
				value={String(value ?? '')}
				onchange={(/** @type {any} */ e) => onchange(e.currentTarget.value)}
			/>
		</span>
	</label>
{:else if field.kind === 'image'}
	<!-- a <span> caption, not a <label>: HudImagePicker owns a <label> of its own around
	     its file input, and nesting labels double-fires the click -->
	<div class="hud-field">
		<span>{label}</span>
	</div>
	<div class="hud-field hud-field-wide">
		<HudImagePicker hash={String(value ?? '')} onpick={(/** @type {string} */ next) => onchange(next)} />
	</div>
{:else}
	<!-- 'text' and anything unknown: a plain field, committed on change -->
	<label class="hud-field" title={field.hint ?? ''}>
		<span>{label}</span>
		<input
			class="hud-input"
			placeholder={field.placeholder ?? ''}
			value={String(value ?? '')}
			onchange={(/** @type {any} */ e) => onchange(e.currentTarget.value)}
		/>
	</label>
{/if}

<style>
	.hud-field {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.hud-field > span:first-child {
		width: 4.2rem;
		flex-shrink: 0;
		opacity: 0.7;
	}
	.hud-field-wide {
		padding-left: 4.6rem;
	}
	.hud-field-ctl {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 0.3rem;
	}
	.hud-input {
		min-width: 0;
		flex: 1;
		border-radius: 0.2rem;
		background: rgb(17 24 39 / 0.6);
		padding: 0.1rem 0.3rem;
		font-size: 11px;
	}
	.hud-swatch {
		height: 12px;
		width: 12px;
		flex-shrink: 0;
		border: 1px solid rgb(75 85 99 / 0.8);
		border-radius: 2px;
	}
</style>
