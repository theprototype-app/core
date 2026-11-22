// uir-chat — THE TWO BUTTONS OF THE ONE WINDOW. Chat and the AI assistant are one window (#chat-window,
// key 'chat') with a Session and an Assistant tab; the Chat button / C opens it on Session, the AI
// assistant button on Assistant:
//
//   closed                         -> open on that tab (where it was: floating, a sidebar tab, a dock tab)
//   open on the OTHER tab          -> switch to this tab (and bring the window forward if it is covered)
//   open on this tab               -> the hosted window's own toggle (bring a covered tab forward, else close)
import { get } from 'svelte/store';
import { chatHidden, chatTab } from '../../stores/appStore';
import { toggleHostedWindow, revealHostedWindow } from '../panelToggles';

/** @typedef {import('../../stores/appStore').ChatTab} ChatTab */

/** the Chat / AI assistant button @param {ChatTab} tab */
export function toggleChatTab(tab) {
	if (get(chatHidden) === '' && get(chatTab) !== tab) {
		chatTab.set(tab);
		revealHostedWindow('chat');
		return;
	}
	chatTab.set(tab);
	toggleHostedWindow('chat');
}

/** open the window on a tab (never closes) @param {ChatTab} tab */
export function openChatTab(tab) {
	chatTab.set(tab);
	if (get(chatHidden) !== '') chatHidden.set('');
	else revealHostedWindow('chat');
}
