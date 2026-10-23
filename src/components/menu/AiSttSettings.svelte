<script module>
	// what the I4 settings search matches this section by, beyond its row names
	export const keywords = ['voice', 'voice typing', 'speech', 'speech to text', 'stt', 'whisper', 'dictation', 'dictate', 'microphone', 'mic', 'transcription', 'openai', 'groq', 'self-hosted', 'faster-whisper', 'vr', 'ai'];
</script>

<script>
	// 36-vr-ai (plan F2) — VOICE TYPING, one section in its own file, registered in Settings ▸ AI with one
	// line. The speech-to-text provider the AI assistant's mic uses, on desktop and in the headset. Three
	// presets, all the OpenAI-compatible /audio/transcriptions shape; the config is LOCAL to this device
	// (safeStorage, plaintext like every AI key here).
	//
	// 37-settings (R21): the provider is a segmented control with its status as a badge; the server form
	// is a SUB-PAGE ("AI › Voice typing server") reached by a NavRow. 59 T4: the NavRow is the Tools &
	// connections hub's Voice typing row now, and the preset picker moved into the sub-page.
	// `subpage` renders that form (the
	// AI page passes it while the sub-page is open). Same store, same key (aiStt).
	import Section from '../ui/Section.svelte';
	import SettingRow from '../ui/SettingRow.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Button from '../ui/Button.svelte';
	import Badge from '../ui/Badge.svelte';
	import { STT_PRESETS, sttConfig, setSttConfig, applySttPreset, sttReady, sttPresetFor, transcribe, describeSttError, silentWav } from '$lib/ai/stt.js';

	/** @type {{subpage?: boolean}} */
	let { subpage = false } = $props();

	/** @type {{ok: boolean, detail: string} | null} */
	let testResult = $state(null);
	let testing = $state(false);

	/** @param {Event} e */
	const value = (e) => /** @type {HTMLInputElement} */ (e.currentTarget).value;

	async function test() {
		testing = true;
		testResult = null;
		try {
			await transcribe(silentWav());
			testResult = { ok: true, detail: 'Connected — the server accepted a recording' };
		} catch (error) {
			testResult = { ok: false, detail: describeSttError(error) };
		}
		testing = false;
	}

	const preset = $derived(sttPresetFor($sttConfig.preset));
	const ready = $derived(sttReady($sttConfig));
	const PRESETS = STT_PRESETS.map((p) => ({ value: p.preset, label: p.preset === 'custom' ? 'Self-hosted' : p.label, title: p.label }));
</script>

<div id="ai-stt-settings" class="contents" data-keywords={keywords.join(' ')}>
	{#if subpage}
		<!-- 59 T4: Tools & connections ▸ Voice typing ▸ Set up — the provider picker sits above the form -->
		<Section variant="card" label="Voice typing" badge="This device">
			<SettingRow id="row-stt-preset" label="Voice typing provider" description="Speech to text for the assistant’s mic, in the AI window and in VR." wide>
				<Segmented id="ai-stt-preset" label="Voice typing provider" options={PRESETS} value={$sttConfig.preset} onchange={(v) => { applySttPreset(v); testResult = null; }} />
				<span id="ai-stt-status"><Badge tone={ready ? 'ok' : 'warn'} text={ready ? 'Ready' : $sttConfig.enabled === false ? 'Switched off' : preset.needsKey ? 'Needs an API key' : 'Needs a base URL'} /></span>
			</SettingRow>
		</Section>
		<Section variant="card" label="Voice typing server" badge="This device">
			<SettingRow id="row-stt-base" label="Base URL" description="The OpenAI-compatible endpoint, ending in /v1." wide>
				<input id="ai-stt-base" class="settings-text" placeholder="https://…/v1" autocomplete="off" value={$sttConfig.baseUrl} onchange={(e) => setSttConfig({ baseUrl: value(e) })} />
			</SettingRow>
			<SettingRow id="row-stt-key" label="API key" description={preset.needsKey ? 'Needed for this provider.' : 'Only if your server asks for one.'} wide>
				<!-- new-password: keeps the browser's password manager from pairing the URL and the key -->
				<input id="ai-stt-key" class="settings-text" type="password" placeholder="API key" autocomplete="new-password" value={$sttConfig.apiKey} onchange={(e) => setSttConfig({ apiKey: value(e) })} />
			</SettingRow>
			<SettingRow id="row-stt-model" label="Model" wide>
				<input id="ai-stt-model" class="settings-text" placeholder="whisper-1" autocomplete="off" value={$sttConfig.model} onchange={(e) => setSttConfig({ model: value(e) })} />
			</SettingRow>
			<SettingRow id="row-stt-language" label="Language hint" description="For example en. Blank detects the language." wide>
				<input id="ai-stt-language" class="settings-text" placeholder="en" autocomplete="off" value={$sttConfig.language} onchange={(e) => setSttConfig({ language: value(e) })} />
			</SettingRow>
			<SettingRow id="row-stt-test" label="Test connection" description="Sends half a second of silence to the server.">
				<Button id="ai-stt-test" size="sm" variant="outline" disabled={testing} onclick={test}>{testing ? 'Testing…' : 'Test'}</Button>
				{#snippet extra()}
					{#if testResult}
						<span id="ai-stt-test-result" class={testResult.ok ? 'stt-ok' : 'stt-bad'}>{testResult.ok ? '✓' : '✗'} {testResult.detail}</span>
					{/if}
				{/snippet}
			</SettingRow>
		</Section>
	{/if}
</div>

<style>
	.contents {
		display: contents;
	}
	.stt-ok {
		font-size: var(--fs-desc);
		color: var(--ink-good);
	}
	.stt-bad {
		font-size: var(--fs-desc);
		color: var(--ink-bad);
	}
</style>
