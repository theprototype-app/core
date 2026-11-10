<script>
	// panel-gestures item 5 — Settings ▸ Interface ▸ "Customize buttons": every chrome button a person
	// can hide (right-click / long press ▸ Hide this button), as switches grouped by strip, plus Show
	// all. Its own file so the settings page stays a one-line union. LOCAL, and saved with a named
	// workspace layout ($lib/chromeButtons). The "+" of a strip is never listed: it always stays.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Button from '../../ui/Button.svelte';
	import { CHROME_KINDS, chromeButtonDefs, hiddenChromeIds, setChromeButtonShown, showAllChromeButtons } from '$lib/chromeButtons';

	const kinds = Object.keys(CHROME_KINDS).filter((k) => chromeButtonDefs(k).length);
</script>

<SettingRow
	id="row-chrome-buttons"
	label="Customize buttons"
	description="The small buttons on panel headers and the dock. Right-click one (long-press on touch) and pick Hide this button; switch it back on here. The + that adds a panel always stays."
	badge="This device"
	keywords="customize buttons hide show chrome header strip sidebar dock split undock minimize full height lock tabs pin unpin"
	wide
	stack
>
	<div class="cb-list">
		{#each kinds as kind (kind)}
			<div class="cb-kind" role="group" aria-labelledby="cb-kind-{kind}">
				<div class="cb-kind-title" id="cb-kind-{kind}">{CHROME_KINDS[kind]}</div>
				{#each chromeButtonDefs(kind) as def (def.id)}
					<div class="cb-row">
						<span class="cb-label" id="cb-label-{def.id.replace(/\W/g, '-')}">{def.label}</span>
						<Toggle
							id="cb-toggle-{def.id.replace(/\W/g, '-')}"
							labelledby="cb-label-{def.id.replace(/\W/g, '-')}"
							checked={!$hiddenChromeIds.includes(def.id)}
							onchange={(/** @type {boolean} */ on) => setChromeButtonShown(def.id, on)}
						/>
					</div>
				{/each}
			</div>
		{/each}
		<div class="cb-actions">
			<Button id="chrome-buttons-show-all" size="sm" variant="outline" disabled={!$hiddenChromeIds.length} onclick={() => showAllChromeButtons()}>Show all</Button>
		</div>
	</div>
</SettingRow>

<style>
	.cb-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		width: 100%;
	}
	.cb-kind {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.cb-kind-title {
		color: var(--text-muted);
		font-size: var(--fs-desc);
		font-weight: 600;
	}
	.cb-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-height: 32px;
	}
	.cb-label {
		color: var(--text);
		font-size: var(--fs-desc);
	}
	.cb-actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
