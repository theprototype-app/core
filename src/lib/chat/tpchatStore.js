// 56 C10 — STUB of 56-media's `.tpchat` store (the real one lands on feat/56-media at this same
// path, with the same exports; 56-int takes that file over this one). In memory only: chats
// saved here last for this page's life, so the window's history, New chat and reopen can be
// built and tested before the scene-data store (replication, saves, Explorer cards) exists.
// Contract: QUESTIONS-56-chat Q2 + 56-media's answer.
import { writable, get } from 'svelte/store';

/** @type {Map<string, any>} */
const docs = new Map();

/** the scene's chats, newest first `[{id, title, target, updatedAt, count, include}]` */
export const chatList = writable(/** @type {any[]} */ ([]));

function publish() {
	chatList.set(
		[...docs.values()]
			.map((d) => ({ id: d.id, title: d.title, target: d.target, updatedAt: d.updatedAt ?? 0, count: d.messages?.length ?? 0, include: !!d.include }))
			.sort((a, b) => b.updatedAt - a.updatedAt)
	);
}

/** the whole chat document, or null (synchronous; `await` works on it too) @param {string} id */
export function readChat(id) {
	return docs.get(id) ?? null;
}

/** save a whole chat (the window's one writer calls this) @param {any} chat */
export function saveChat(chat) {
	if (!chat || typeof chat.id !== 'string') return;
	docs.set(chat.id, { ...docs.get(chat.id), ...chat });
	publish();
}

/** @param {string} id @param {string} title */
export function renameChat(id, title) {
	const d = docs.get(id);
	if (!d) return;
	docs.set(id, { ...d, title });
	publish();
}

/** @param {string} id */
export function deleteChat(id) {
	if (docs.delete(id)) publish();
}

/** the chat id an Explorer `.tpchat` card stands for @param {any} item */
export async function chatIdOfItem(item) {
	return typeof item?.chatId === 'string' ? item.chatId : null;
}

/** @type {((chatId: string) => void) | null} */
let opener = null;
/** the AI window registers how a chat opens in it @param {((chatId: string) => void) | null} fn */
export function registerChatOpener(fn) {
	opener = fn;
}
/** the Explorer / a drop: open this chat in the AI window @param {string} id */
export function openChat(id) {
	opener?.(id);
}

/** test seam: what the stub holds */
export const _stubDocs = () => get(chatList);
