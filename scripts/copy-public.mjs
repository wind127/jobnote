import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'dist', 'public'), { recursive: true });
await cp(join(root, 'public'), join(root, 'dist', 'public'), { recursive: true });

// Keep the browser entry point self-contained so an already-running local server
// can serve a fresh build without needing a new static route.
const sorting = await readFile(join(root, 'public', 'sorting.js'), 'utf8');
const app = await readFile(join(root, 'public', 'app.js'), 'utf8');
const importLine = "import {STAGE_PROGRESS,compareProgressRows} from './sorting.js';";
if (!app.startsWith(importLine)) throw new Error('Unexpected browser entry point');
await writeFile(
  join(root, 'dist', 'public', 'app.js'),
  `${sorting.replace(/^export /gm, '')}\n${app.slice(importLine.length).trimStart()}`,
);
