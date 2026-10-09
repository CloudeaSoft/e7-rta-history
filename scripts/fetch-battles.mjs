import { fileURLToPath } from 'node:url';
import { saveSnapshot, fetchResponse } from './archive.mjs';

try {
  const raw = await fetchResponse();
  const result = await saveSnapshot(raw, { dataDir: fileURLToPath(new URL('../data/', import.meta.url)) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Battle archive failed:', error);
  process.exitCode = 1;
}
