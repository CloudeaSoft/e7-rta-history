import { fileURLToPath } from 'node:url';
import { rebuildArchive } from './archive.mjs';

try {
  const result = await rebuildArchive({ dataDir: fileURLToPath(new URL('../data/', import.meta.url)) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Battle rebuild failed:', error);
  process.exitCode = 1;
}
