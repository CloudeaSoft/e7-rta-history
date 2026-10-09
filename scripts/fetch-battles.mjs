import { fileURLToPath } from 'node:url';
import { archiveResponse, fetchResponse } from './archive.mjs';

try {
  const raw = await fetchResponse();
  const result = await archiveResponse(raw, { dataDir: fileURLToPath(new URL('../data/', import.meta.url)) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Battle archive failed:', error);
  process.exitCode = 1;
}
