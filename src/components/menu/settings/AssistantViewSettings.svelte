<script module>
	/** 104 C2: what the settings search matches beyond the row names */
	export const keywords = ['claude', 'assistant', 'ai', 'show', 'move my view', 'camera', 'panels', 'open code', 'connector', 'privacy', 'permission'];
</script>

<script>
	// 104 C2 — Settings ▸ Privacy ▸ Assistant on your screen: what `show` may do here without asking. Each
	// switch is the "Always" answer to the first-use question, stored on THIS DEVICE (safeStorage
	// `show:allow:<kind>`, read on every call, so turning one off asks again next time). All off by default.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { safeStorage } from '$lib/safeStorage';

	const ROWS = [
		{ kind: 'panel', label: 'Open and close my panels', desc: 'The Explorer, Objects, Inspector, Flow editor, Code, Timeline, Assets, Preview and Chat.' },
		{ kind: 'camera', label: 'Move my view', desc: 'Frame objects, go to a spot or look through a scene camera. Never in a VR headset, never while you drag or type.' },
		{ kind: 'code', label: 'Open code for me', desc: 'Open a file or a node’s code at a line and select it. It never changes the text.' }
	];
	/** @param {string} kind */
	const read = (kind) => {
		try {
			return safeStorage.getItem('show:allow:' + kind) === 'always';
		} catch {
			return false;
		}
	};
	let allow = $state(Object.fromEntries(ROWS.map((r) => [r.kind, read(r.kind)])));
	/** @param {string} kind @param {boolean} on */
	function set(kind, on) {
		allow[kind] = on;
		try {
			if (on) safeStorage.setItem('show:allow:' + kind, 'always');
			else safeStorage.removeItem('show:allow:' + kind);
		} catch {}
	}
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Assistant on your screen" badge="This device">
		{#each ROWS as row (row.kind)}
			<SettingRow id={'row-show-allow-' + row.kind} label={row.label} keywords="assistant claude show permission">
				{#snippet desc()}{row.desc} When off, the assistant asks first (Always / This time / No).{/snippet}
				<Toggle id={'show-allow-' + row.kind} label={row.label} checked={allow[row.kind]} onchange={(next) => set(row.kind, next)} />
			</SettingRow>
		{/each}
	</Section>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
