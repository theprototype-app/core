<script>
	// 38 R3 — ONE search / filter field (SPEC §4: "one search field style" in Explorer, Objects,
	// Chat, AI, Notes, the Inspector filter, Modules, Settings). Inset well, search icon, an
	// optional key hint ("/") and a clear button once there is text. Its input keeps the
	// caller's `id` and is bindable, so existing focus shortcuts and suites still find it.
	import Icon from './Icon.svelte';

	/** @type {{value?: string, placeholder?: string, label?: string, id?: string, hint?: string, size?: 'md'|'sm', inputEl?: HTMLInputElement | null, oninput?: (v: string) => void, onclear?: () => void} & Record<string, any>} */
	let {
		value = $bindable(''),
		placeholder = 'Search',
		label = '',
		id = undefined,
		hint = '',
		size = 'md',
		inputEl = $bindable(null),
		oninput = () => {},
		onclear = () => {},
		...rest
	} = $props();

	function clear() {
		value = '';
		oninput('');
		onclear();
		inputEl?.focus();
	}
</script>

<label class="tp-ui sf" class:sf-sm={size === 'sm'}>
	<span class="sf-icon" aria-hidden="true"><Icon name="search" size={16} strokeWidth={1.75} /></span>
	<input
		bind:this={inputEl}
		{id}
		class="sf-input"
		type="search"
		{placeholder}
		aria-label={label || placeholder}
		autocomplete="off"
		spellcheck="false"
		bind:value
		oninput={(e) => oninput((value = e.currentTarget.value))}
		{...rest}
	/>
	{#if value}
		<button type="button" class="sf-clear" aria-label="Clear" onclick={clear}><Icon name="x" size={14} strokeWidth={1.75} /></button>
	{:else if hint}
		<kbd class="sf-hint">{hint}</kbd>
	{/if}
</label>

<style>
	.sf {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		box-sizing: border-box;
		min-width: 0;
		height: 34px;
		padding: 0 6px 0 10px;
		background: var(--surface-inset);
		border: 1px solid var(--border-input);
		border-radius: var(--radius-button);
		color: var(--text-faint);
		cursor: text;
	}
	.sf-sm {
		height: var(--control-h-sm);
	}
	.sf:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
	}
	.sf-icon {
		display: inline-flex;
	}
	.sf-input {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
		box-shadow: none;
	}
	.sf-input:focus {
		outline: none;
		box-shadow: none;
	}
	.sf-input::placeholder {
		color: var(--text-faint);
	}
	/* the native clear "x" doubles ours */
	.sf-input::-webkit-search-cancel-button {
		-webkit-appearance: none;
		appearance: none;
	}
	.sf-hint {
		padding: 2px 6px;
		border: 1px solid var(--border-input);
		border-radius: 4px;
		background: none;
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
	}
	.sf-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.sf-clear:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	@media (max-width: 639.98px) {
		.sf,
		.sf-sm {
			height: 44px;
			border-radius: var(--radius-card);
		}
		.sf-input {
			font-size: var(--fs-input);
		}
		.sf-clear {
			width: 36px;
			height: 36px;
		}
	}
</style>
