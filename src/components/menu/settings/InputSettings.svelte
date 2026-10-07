<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	// the old labels of the rows this redesign renamed (Decision C) + the words people search with
	const ROW_WORDS = {
		'use a connected gamepad': ['gamepad', 'controller', 'xbox', 'playstation', 'joystick', 'pad'],
		'swap sticks': ['southpaw', 'controller', 'gamepad'],
		'invert look y': ['controller', 'gamepad', 'flight'],
		'stick deadzone': ['drift', 'controller', 'gamepad'],
		'look sensitivity': ['controller', 'gamepad', 'speed'],
		'node editor mouse': ['mouse bindings', 'node editor', 'pan', 'select', 'drag'],
		'node editor opens': ['node editor', 'graph', 'open', 'opens', 'frame', 'framed', 'fit', 'view', 'zoom', 'pan', 'where it was left', 'centre', 'center']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
</script>

<script>
	// 37-settings (R21) — Settings ▸ Input on the redesign kit (docs/settings-inventory.md §3.3). Same
	// stores / keys as 1.25.0 (gamepadPrefs through setGamepadPrefs, flow:mouseBindings, flow:opens);
	// the ranged numbers are sliders with a mono readout (Decision F). Absorbs NodeEditorViewSettings.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Slider from '../../ui/Slider.svelte';
	import { gamepadPrefs, setGamepadPrefs, DEADZONE_RANGE, SENSITIVITY_RANGE } from '$lib/gamepadPrefs';
	import { flowMouseBindings } from '$lib/flowPrefs';
	import { nodeEditorOpens } from '$lib/flowView';

	const MOUSE = [
		{ value: 'classic', label: 'Classic' },
		{ value: 'select', label: 'Select-first' }
	];
	const OPENS = [
		{ value: 'left', label: 'Where left' },
		{ value: 'framed', label: 'Framed' }
	];
</script>

<div class="settings-page-body" data-keywords="gamepad controller joystick">
	<Section variant="card" label="Gamepad" badge="This device">
		<SettingRow id="row-gamepad" label="Use a connected gamepad" description="The left stick walks, the right stick looks, the d-pad and A work a game menu.">
			<Toggle id="gamepad-enabled" label="Use a connected gamepad" checked={$gamepadPrefs.enabled} onchange={(on) => setGamepadPrefs({ enabled: on })} />
		</SettingRow>
		<SettingRow id="row-swap-sticks" label="Swap sticks" description="Move with the right stick and look with the left.">
			<Toggle id="gamepad-swap" label="Swap sticks" checked={$gamepadPrefs.swapSticks} onchange={(on) => setGamepadPrefs({ swapSticks: on })} />
		</SettingRow>
		<SettingRow id="row-invert-y" label="Invert look Y" description="Push the look stick up to look down.">
			<Toggle id="gamepad-invert-y" label="Invert look Y" checked={$gamepadPrefs.invertY} onchange={(on) => setGamepadPrefs({ invertY: on })} />
		</SettingRow>
		<SettingRow id="row-deadzone" label="Stick deadzone" description="How far a stick may drift at rest before it counts as pushed.">
			<Slider
				id="gamepad-deadzone"
				label="Stick deadzone"
				min={DEADZONE_RANGE.min}
				max={DEADZONE_RANGE.max}
				step={0.01}
				value={$gamepadPrefs.deadzone}
				format={(v) => v.toFixed(2)}
				onchange={(v) => setGamepadPrefs({ deadzone: v })}
			/>
		</SettingRow>
		<SettingRow id="row-sensitivity" label="Look sensitivity" description="How fast the look stick turns. Mouse look has its own speed.">
			<Slider
				id="gamepad-sensitivity"
				label="Look sensitivity"
				min={SENSITIVITY_RANGE.min}
				max={SENSITIVITY_RANGE.max}
				step={0.1}
				value={$gamepadPrefs.lookSensitivity}
				format={(v) => v.toFixed(1) + '×'}
				onchange={(v) => setGamepadPrefs({ lookSensitivity: v })}
			/>
		</SettingRow>
	</Section>
	<p class="settings-footnote">
		A scene can bind the pad itself with the <strong>Gamepad Button</strong> and <strong>Gamepad Axis</strong> nodes (Input group). Module bindings are listed under Shortcuts.
	</p>

	<Section variant="card" label="Node editor" badge="This device">
		<SettingRow id="row-node-mouse" label="Node editor mouse" description="Classic: a left drag pans. Select-first: a left drag selects and a right drag pans." wide>
			<Segmented id="flow-mouse-bindings" label="Node editor mouse" options={MOUSE} value={$flowMouseBindings} onchange={(v) => flowMouseBindings.set(/** @type {any} */ (v))} />
		</SettingRow>
		<SettingRow id="row-node-opens" label="Node editor opens" description="A graph nobody moved always opens framed, every node in view." wide>
			<Segmented id="flow-opens" label="Node editor opens" options={OPENS} value={$nodeEditorOpens} onchange={(v) => nodeEditorOpens.set(/** @type {any} */ (v))} />
		</SettingRow>
	</Section>
</div>

<style>
	.settings-page-body {
		display: contents;
	}
</style>
