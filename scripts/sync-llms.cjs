// Regenerate static/llms-full.txt = static/llms.txt (the map) + MODULES.md (the
// full SDK guide, inlined). Run after editing MODULES.md or llms.txt:
//   npm run sync-llms
// Keeps the AI-readable copy served at /llms-full.txt in sync with the docs so
// an assistant without repo/link access still gets the real API.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const map = fs.readFileSync(path.join(root, 'static', 'llms.txt'), 'utf8').trimEnd();
const modules = fs.readFileSync(path.join(root, 'MODULES.md'), 'utf8').trimEnd();

const out =
	map +
	'\n\n---\n\n# Module SDK — full guide (MODULES.md, inlined)\n\n' +
	modules +
	'\n';

fs.writeFileSync(path.join(root, 'static', 'llms-full.txt'), out);
console.log(`Wrote static/llms-full.txt (${out.length} bytes)`);
