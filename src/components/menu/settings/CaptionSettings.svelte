<script module>
	// 77 — what the settings search matches beyond the row names (`data-keywords` on the root)
	export const keywords = ['captions', 'subtitles', 'transcribe', 'transcription', 'speech to text', 'stt', 'whisper', 'moonshine', 'auto captions', 'srt', 'vtt', 'language', 'deaf', 'hard of hearing', 'in-browser', 'on device', 'offline', 'live captions', 'live subtitles', 'voice chat', 'consent', 'cc'];
</script>

<script>
	// 77 C1/C2 — Settings ▸ Accessibility ▸ Captions from speech: which engine turns speech into
	// timed captions (the Timeline's "Caption the speech in audio clips"), and in what language.
	// Auto = the in-browser Captions module (Moonshine, English, nothing leaves the device) when it
	// is installed, else the speech-to-text server of Settings ▸ AI ▸ Voice typing. LOCAL to this
	// device (captionEngines.js; keys captions:engine / captions:language).
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { liveCaptionConsent, liveCaptionsShown, liveTranscribe, canTranscribe, transcriberId, consentingSpeakers } from '$lib/liveCaptions';
	import { peers, userdata } from '../../../stores/appStore';
	import { captionEngines, captionEnginePref, captionLanguage, pickCaptionEngine } from '$lib/captionEngines';
	import { sttConfig, sttReady } from '$lib/ai/stt.js';

	// the built-in server engine registers itself when the (lazy) caption-job module loads
	$effect(() => {
		void import('$lib/captionJobs');
	});
	const localEngine = $derived($captionEngines.find((e) => e.local) ?? null);
	const serverOk = $derived(sttReady($sttConfig));
	const choice = $derived($captionEnginePref === 'auto' ? 'auto' : $captionEnginePref === 'whisper' ? 'server' : 'local');
	const options = $derived([
		{ value: 'auto', label: 'Auto' },
		{ value: 'local', label: 'On this device', disabled: !localEngine, title: localEngine ? localEngine.label : 'Install the Captions module (Modules) to caption without sending audio anywhere' },
		{ value: 'server', label: 'Server', disabled: !serverOk, title: serverOk ? 'Your speech-to-text server (Settings ▸ AI ▸ Voice typing)' : 'Set up a speech-to-text server first (Settings ▸ AI ▸ Voice typing)' }
	]);
	/** @param {string} v */
	function choose(v) {
		captionEnginePref.set(v === 'local' ? (localEngine?.id ?? 'auto') : v === 'server' ? 'whisper' : 'auto');
	}
	// what Auto would pick now ($captionEngines read so it follows an install)
	const picked = $derived.by(() => {
		void $captionEngines;
		void $captionLanguage;
		return pickCaptionEngine({ serverReady: serverOk });
	});
	const pickedText = $derived(
		picked ? (picked.local ? `${picked.label} — on this device` : `your speech-to-text server (${$sttConfig.model})`) : 'nothing yet — install the Captions module or set up a speech-to-text server'
	);

	// 77 C3: who transcribes the session's voices right now, in words
	const me = $derived(/** @type {any} */ ($peers)?.peer?.id ?? '');
	const transcriberText = $derived(
		!$transcriberId
			? 'Nobody in the session can transcribe yet — a desktop with the Captions module installed does it.'
			: $transcriberId === me
				? `This device transcribes for the session${$consentingSpeakers.length ? ` (${$consentingSpeakers.length} ${$consentingSpeakers.length === 1 ? 'voice' : 'voices'})` : ''}.`
				: `${/** @type {any[]} */ ($userdata).find((u) => u[0] === $transcriberId)?.[1] || 'Another peer'} transcribes for the session.`
	);
	const TRANSCRIBE = [
		{ value: 'auto', label: 'Auto', title: 'Volunteer when this is a desktop with the Captions module (audio stays on this device)' },
		{ value: 'on', label: 'On', title: 'Volunteer with any engine — the speech-to-text server included (voices are sent to it)' },
		{ value: 'off', label: 'Off' }
	];

	const LANGUAGES = [
		['', 'English (default)'],
		['es', 'Spanish'],
		['fr', 'French'],
		['de', 'German'],
		['it', 'Italian'],
		['pt', 'Portuguese'],
		['nl', 'Dutch'],
		['pl', 'Polish'],
		['ru', 'Russian'],
		['uk', 'Ukrainian'],
		['ja', 'Japanese'],
		['ko', 'Korean'],
		['zh', 'Chinese'],
		['ar', 'Arabic'],
		['hi', 'Hindi'],
		['tr', 'Turkish'],
		['sv', 'Swedish']
	].map(([value, name]) => ({ value, name }));
</script>

<div class="settings-page-body" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Captions from speech" badge="This device">
		<SettingRow
			id="row-caption-engine"
			label="Caption engine"
			description={`Turns speech into timed captions (Timeline ▸ sequence menu ▸ Captions ▸ Caption the speech). Auto uses ${pickedText}.`}
			keywords="engine moonshine whisper module server on device in-browser offline transcribe"
		>
			<Segmented id="caption-engine" label="Caption engine" {options} value={choice} onchange={choose} />
		</SettingRow>
		<SettingRow
			id="row-caption-language"
			label="Spoken language"
			description="The in-browser engine hears English; other languages use the speech-to-text server."
			keywords="language english spanish french german translate"
		>
			<ThemedSelect id="caption-language" items={LANGUAGES} value={$captionLanguage} onchange={(v) => captionLanguage.set(String(v ?? ''))} />
		</SettingRow>
	</Section>
	<Section variant="card" label="Live captions in voice chat" badge="This device">
		<SettingRow
			id="row-live-consent"
			label="Let others caption my voice"
			description="While on, what you say in voice chat is turned into text and shown to the session — under your avatar and at the bottom of the screen — and a CC mark shows beside your name. Off by default; turning it off stops it at once."
			keywords="consent caption my voice live subtitles cc privacy"
		>
			<Toggle id="live-caption-consent" label="Let others caption my voice" bind:checked={$liveCaptionConsent} />
		</SettingRow>
		<SettingRow id="row-live-show" label="Show live captions" description="Captions of the people who allow them (CC beside their name)." keywords="show live captions subtitles voice">
			<Toggle id="live-captions-shown" label="Show live captions" bind:checked={$liveCaptionsShown} />
		</SettingRow>
		<SettingRow
			id="row-live-transcribe"
			label="Transcribe for the session"
			description={`One device turns the voices into text for everyone, so a headset or a phone needs no model. ${transcriberText}`}
			keywords="transcribe host relay live captions engine"
		>
			<Segmented id="live-transcribe" label="Transcribe for the session" options={TRANSCRIBE} value={$liveTranscribe} onchange={(/** @type {string} */ v) => liveTranscribe.set(v)} />
		</SettingRow>
		{#if $liveTranscribe !== 'off' && !$canTranscribe}
			<p class="live-note">This device cannot transcribe yet: {$liveTranscribe === 'on' ? 'install the Captions module or set up a speech-to-text server.' : 'Auto needs a desktop with the Captions module installed.'}</p>
		{/if}
	</Section>
</div>

<style>
	.settings-page-body {
		display: contents;
	}
	.live-note {
		margin: 4px 0 0;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
</style>
