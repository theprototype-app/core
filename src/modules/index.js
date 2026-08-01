// Built-in (core) modules. App boot loads the ones not disabled in the
// modules manager; add your module folder under src/modules/<name>/ and
// list it here (every peer needs the same list — see MODULES.md).

import hello from './hello/module.js';
import button from './button/module.js';
import dungeon from './dungeon/module.js';
import piano from './piano/module.js';
import pong from './pong/module.js';
import avatar from './avatar/module.js';
import essentials from './essentials/module.js';
import car from './car/module.js';
import vrsleeve from './vrsleeve/module.js';

export const coreModules = [hello, button, dungeon, piano, pong, avatar, essentials, car, vrsleeve];
