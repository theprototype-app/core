// certs — generate the self-signed pair the dev server serves HTTPS with.
// WebXR and getUserMedia only work over TLS, and vite.config.ts reads
// certs/localhost.crt + certs/localhost.key inside a try/catch: when they are
// missing it silently falls back to plain http, so VR and voice chat break with
// no error. The pair is gitignored (it holds a private key), so every fresh
// clone runs this once. Idempotent — pass --force to overwrite an existing pair.
const { execFileSync } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const DIR = join(__dirname, '..', 'certs');
const CRT = join(DIR, 'localhost.crt');
const KEY = join(DIR, 'localhost.key');
const CNF = join(DIR, 'req.cnf');
const DAYS = 825; // the max browsers accept for a leaf certificate

const force = process.argv.includes('--force');

if (!existsSync(CNF)) {
	console.error('certs — missing ' + CNF + ' (it is committed; are you in the repo root?)');
	process.exit(1);
}

if (!force && existsSync(CRT) && existsSync(KEY)) {
	console.log('certs — certs/localhost.crt and .key already exist; nothing to do.');
	console.log('certs — pass --force to replace them (npm run certs -- --force).');
	process.exit(0);
}

// On Windows openssl is usually not on PATH for cmd.exe, but Git for Windows
// ships one. Try PATH first, then the standard Git install locations.
const candidates = ['openssl'];
if (process.platform === 'win32') {
	candidates.push(
		'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
		'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe'
	);
}

let openssl = null;
for (const c of candidates) {
	try {
		execFileSync(c, ['version'], { stdio: 'ignore' });
		openssl = c;
		break;
	} catch {
		// not this one — keep looking
	}
}

if (!openssl) {
	console.error('certs — could not find openssl.');
	console.error(
		'certs — Windows: install Git for Windows (it bundles one), or add openssl to PATH.'
	);
	console.error('certs — macOS: preinstalled, or `brew install openssl`.');
	console.error('certs — Linux: `apt install openssl` / your package manager.');
	process.exit(1);
}

mkdirSync(DIR, { recursive: true });

try {
	execFileSync(
		openssl,
		[
			'req',
			'-x509',
			'-nodes',
			'-days',
			String(DAYS),
			'-newkey',
			'rsa:2048',
			'-keyout',
			KEY,
			'-out',
			CRT,
			'-config',
			CNF
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] }
	);
} catch (e) {
	console.error('certs — openssl failed:');
	console.error(String(e.stderr || e.message).trim());
	process.exit(1);
}

console.log('certs — wrote certs/localhost.crt and certs/localhost.key (valid ' + DAYS + ' days).');
console.log('certs — self-signed, so the browser warns once per port; accept it and continue.');
console.log('certs — restart `npm run dev` if it is already running.');
