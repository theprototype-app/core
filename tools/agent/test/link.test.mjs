// Session links → page URL / signaling / TURN (roadmap 55 A3, test flight 2 T3/T4).
// Pure: no network. Run: node test/link.test.mjs
import { parseLink, pageUrl, redactLink, endpointsFor, isLocalOrigin, PRODUCTION } from '../src/link.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
	if (cond) {
		pass++;
		console.log('PASS ' + name);
	} else {
		fail++;
		console.log('FAIL ' + name);
	}
};
const throws = (fn) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

// --- the shapes a person pastes ---
const full = parseLink('https://theprototype.app/#F0FD3');
check('full link: origin', full.origin === 'https://theprototype.app');
check('full link: peer id lower-cased like the app dials it', full.peerId === 'f0fd3');
check('full link: no invite, no agent flag', full.invite === null && full.agent === false);

const noSlash = parseLink('https://theprototype.app#F0FD3');
check('link without a slash before the hash', noSlash.peerId === 'f0fd3' && noSlash.origin === 'https://theprototype.app');

const noScheme = parseLink('theprototype.app/#F0FD3');
check('link without a scheme gets https', noScheme.origin === 'https://theprototype.app' && noScheme.peerId === 'f0fd3');

const bare = parseLink('F0FD3');
check('bare id = production', bare.origin === PRODUCTION.origin && bare.peerId === 'f0fd3');
check('#id = production', parseLink('#F0FD3').peerId === 'f0fd3');
check('surrounding whitespace ignored', parseLink('  F0FD3\n').peerId === 'f0fd3');

const inv = parseLink('https://theprototype.app/#F0FD3&agent&invite=tok_SECRET123');
check('invite token parsed', inv.invite === 'tok_SECRET123');
check('agent flag parsed', inv.agent === true);
check('peer id stops at the first &', inv.peerId === 'f0fd3');

const srv = parseLink('https://theprototype.app/#F0FD3~srv=peer.example.org%3A9000%2Fsig');
check('~srv tail parsed', srv.srv === 'peer.example.org%3A9000%2Fsig' && srv.peerId === 'f0fd3');
const both = parseLink('https://theprototype.app/#F0FD3&invite=abc~srv=public');
check('invite + ~srv together', both.invite === 'abc' && both.srv === 'public');

const local = parseLink('https://theprototype.app:5456/#abc12');
check('dev-server link keeps its port', local.origin === 'https://theprototype.app:5456');
check('preview deployment link', parseLink('https://preview-1-45.theprototype.pages.dev/#X1Y2Z').origin === 'https://preview-1-45.theprototype.pages.dev');
const extra = parseLink('https://theprototype.app/#F0FD3&agent&safe');
check('unknown hash keys are kept', extra.extra.length === 1 && extra.extra[0] === 'safe');

// --- refusals ---
check('empty input refused', throws(() => parseLink('')));
check('link with no id refused', throws(() => parseLink('https://theprototype.app/')));
check('nonsense id refused', throws(() => parseLink('https://theprototype.app/#<script>')));
check('non-http scheme refused', throws(() => parseLink('ftp://theprototype.app/#F0FD3')));

// --- the page the browser engine opens ---
check('page url carries &agent', pageUrl(full) === 'https://theprototype.app/#f0fd3&agent');
check('page url carries the invite', pageUrl(inv) === 'https://theprototype.app/#f0fd3&agent&invite=tok_SECRET123');
check('page url keeps ~srv last', pageUrl(both) === 'https://theprototype.app/#f0fd3&agent&invite=abc~srv=public');
check('compat page url is the bare id (an old app reads id&agent as the id)', pageUrl(inv, { compat: true }) === 'https://theprototype.app/#f0fd3');
check('compat page url keeps ~srv', pageUrl(both, { compat: true }) === 'https://theprototype.app/#f0fd3~srv=public');
check('extra keys travel', pageUrl(extra) === 'https://theprototype.app/#f0fd3&agent&safe');

// --- the token never prints ---
const red = redactLink(inv);
check('redacted link hides the token', !red.includes('SECRET') && red.includes('invite=…'));
check('redacted string link hides the token', !redactLink('https://x.app/#a1&invite=SECRET&agent').includes('SECRET'));
check('a refusal message does not echo a token', (() => {
	try {
		parseLink('ftp://x/#ab&invite=SECRET');
	} catch (e) {
		return !String(e.message).includes('SECRET');
	}
	return false;
})());

// --- signaling + ICE from the link (T3/T4) ---
const ep = endpointsFor(full);
check('production link → peerjs.theprototype.app', ep.server && ep.server.host === 'peerjs.theprototype.app' && ep.server.path === '/peerjs');
check('production link → STUN on the box', ep.stun[0] === 'stun:peerjs.theprototype.app:3478');
check('production link → TURN from PocketBase', ep.turnApi === 'https://pb.theprototype.app/api/tp/turn');
check('production link is not a guess', ep.guessed === false && ep.source === 'origin');
check('bare id never lands on the public cloud', endpointsFor(bare).server !== null);
check('preview deployment → production signaling', endpointsFor(parseLink('https://abc.theprototype.pages.dev/#X1Y2Z')).server.host === 'peerjs.theprototype.app');
const unknown = endpointsFor(parseLink('https://my-fork.example/#ab12'));
check('unknown origin → production signaling, flagged as a guess', unknown.server.host === 'peerjs.theprototype.app' && unknown.guessed === true);
check('~srv=public → the public cloud (asked for)', endpointsFor(both).server === null && endpointsFor(both).source === 'link:public');
const custom = endpointsFor(srv);
check('~srv=host:port/path decoded', custom.server.host === 'peer.example.org' && custom.server.port === 9000 && custom.server.path === '/sig');
check('a foreign ~srv gets no production TURN', custom.turnApi === null);
check('--peer-server wins over the link', endpointsFor(full, { override: { host: 'h', port: 1, path: '/p' } }).server.host === 'h');
check('--peer-server public', endpointsFor(full, { override: 'public' }).server === null);
check('--no-turn', endpointsFor(full, { turnUrl: false }).turnApi === null);
check('--turn-url', endpointsFor(full, { turnUrl: 'https://t.example/turn' }).turnApi === 'https://t.example/turn');

// --- local dev cert detection ---
check('dev server with a port is local', isLocalOrigin('https://theprototype.app:5456'));
check('localhost is local', isLocalOrigin('https://localhost'));
check('production is not local', !isLocalOrigin('https://theprototype.app'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
