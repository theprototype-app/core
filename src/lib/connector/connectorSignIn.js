// FW-AI (roadmap 76): the AI window's "Sign in to connect". There is one sign-in place, the top-right profile
// pop-up; this asks for it. On the phone the AI window is a sheet over the screen, so it steps aside first
// (the pop-up is a sheet too, and only one should be in front).
import { get } from 'svelte/store';
import { aiAssistantHidden, profileMenuRequest } from '../../stores/appStore';
import { phoneShellActive } from '../ui/phoneShell.js';

export function requestSignIn() {
	if (get(phoneShellActive)) aiAssistantHidden.set('hidden');
	profileMenuRequest.set(true);
}
