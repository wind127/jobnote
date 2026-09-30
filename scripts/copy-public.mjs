import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'dist', 'public'), { recursive: true });
await cp(join(root, 'public'), join(root, 'dist', 'public'), { recursive: true });
