// uir-int — THE FIRST-USE HINT for "New menus and panels": the first time the one Chat window opens on this
// device it says, once, that Chat and the AI assistant now share it (Session | Assistant, one History).
// Once ever (safeStorage), LOCAL, and quiet in an automated browser unless a suite opts in
// (`chatHint:e2e` = '1', the guestName `joinName:e2e` rule) — a toast under the header would sit on every
// suite that opens Chat.
import { safeStorage } from '../safeStorage.js';

export const CHAT_HINT =
	'Chat and the AI assistant are one window now: Session for the people here, Assistant for AI. History lists both, and chats come back after a reload.';
export const CHAT_HINT_KEY = 'tp:chat-hint';

const automated = () => typeof navigator !== 'undefined' && !!navigator.webdriver && safeStorage.getItem('chatHint:e2e') !== '1';

/**
 * Show the hint if this device has not seen it.
 * @param {{show: (id: string, message: string, actions: any[]) => void}} ui
 * @returns {boolean} shown
 */
export function chatHintOnce(ui) {
	if (automated() || safeStorage.getItem(CHAT_HINT_KEY)) return false;
	safeStorage.setItem(CHAT_HINT_KEY, '1');
	ui.show('chat-hint', CHAT_HINT, [{ label: 'Got it', action: () => {} }]);
	return true;
}
