<script context="module">
	// what the I4 settings search matches this section by, beyond its row names
	export const keywords = ['voice', 'voice typing', 'speech', 'speech to text', 'stt', 'whisper', 'dictation', 'dictate', 'microphone', 'mic', 'transcription', 'openai', 'groq', 'self-hosted', 'faster-whisper', 'vr', 'ai'];
</script>

<script>
	// 36-vr-ai (plan F2) — VOICE TYPING, one section in its own file, registered in Settings ▸ AI with one line.
	// The speech-to-text provider the AI assistant's mic uses, on desktop and in the headset (where there are no
	// AI settings of its own). Three presets, all the OpenAI-compatible /audio/transcriptions shape; the config
	// is LOCAL to this device (safeStorage, plaintext like every AI key here).
	import SettingRow from './SettingRow.svelte';
	import { STT_PRESETS, sttConfig, setSttConfig, applySttPreset, sttReady, sttPresetFor, transcribe, describeSttError } from '$lib/ai/stt.js';

	/** @type {{ok: boolean, detail: string} | null} */
	let testResult = null;
	let testing = false;

	/** @param {Event} e */
	const value = (e) => /** @type {HTMLInputElement} */ (e.currentTarget).value;

	/** half a second of silence as a 16 kHz mono WAV — enough for the server to answer, nothing to transcribe */
	function silentWav() {
		const samples = 8000;
		const buffer = new ArrayBuffer(44 + samples * 2);
		const view = new DataView(buffer);
		const text = (/** @type {number} */ at, /** @type {string} */ s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
		text(0, 'RIFF');
		view.setUint32(4, 36 + samples * 2, true);
		text(8, 'WAVE');
		text(12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 16000, true);
		view.setUint32(28, 32000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		text(36, 'data');
		view.setUint32(40, samples * 2, true);
		return new Blob([buffer], { type: 'audio/wav' });
	}

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

	$: preset = sttPresetFor($sttConfig.preset);
	$: ready = sttReady($sttConfig);
</script>

<div id="ai-stt-settings" data-keywords={keywords.join(' ')}>
	<SettingRow name="Voice typing provider">
		<svelte:fragment slot="control">
			<select id="ai-stt-preset" class="ui-input" aria-label="Voice typing provider" value={$sttConfig.preset} on:change={(e) => { applySttPreset(value(e)); testResult = null; }}>
				{#each STT_PRESETS as p}
					<option value={p.preset}>{p.label}</option>
				{/each}
			</select>
		</svelte:fragment>
		<span class="font-semibold">Speech to text</span> for the assistant's mic — in the AI window and in VR (Tools ▸ AI: hold the mic or the
		talk button). OpenAI and Groq need an API key; a self-hosted faster-whisper / whisper.cpp server only its URL.
		<span id="ai-stt-status" class={ready ? 'text-[var(--ink-good)]' : 'text-[var(--ink-warn)]'}>{ready ? '✓ Ready' : preset.needsKey ? 'Needs an API key' : 'Needs a base URL'}</span>
	</SettingRow>
	<SettingRow name="Voice typing server" noControl>
		<span class="flex flex-col gap-1.5">
			<input id="ai-stt-base" class="ui-input" placeholder="Base URL (…/v1)" autocomplete="off" value={$sttConfig.baseUrl} on:change={(e) => setSttConfig({ baseUrl: value(e) })} />
			<!-- new-password: keeps the browser's password manager from pairing the URL and the key -->
			<input id="ai-stt-key" class="ui-input" type="password" placeholder={preset.needsKey ? 'API key' : 'API key (only if your server asks for one)'} autocomplete="new-password" value={$sttConfig.apiKey} on:change={(e) => setSttConfig({ apiKey: value(e) })} />
			<input id="ai-stt-model" class="ui-input" placeholder="Model (whisper-1)" autocomplete="off" value={$sttConfig.model} on:change={(e) => setSttConfig({ model: value(e) })} />
			<input id="ai-stt-language" class="ui-input" placeholder="Language hint, e.g. en (blank = detect)" autocomplete="off" value={$sttConfig.language} on:change={(e) => setSttConfig({ language: value(e) })} />
			<span class="flex items-center gap-1.5">
				<button id="ai-stt-test" class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500 disabled:opacity-50" disabled={testing} on:click={test}>{testing ? 'Testing…' : 'Test connection'}</button>
				{#if testResult}
					<span id="ai-stt-test-result" class="text-[12px] {testResult.ok ? 'text-[var(--ink-good)]' : 'text-[var(--ink-bad)]'}">{testResult.ok ? '✓' : '✗'} {testResult.detail}</span>
				{/if}
			</span>
		</span>
	</SettingRow>
</div>
