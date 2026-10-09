import { fileURLToPath } from 'node:url';
import { generateAnalysis } from './analysis.mjs';

try {
  const result = await generateAnalysis({ dataDir: fileURLToPath(new URL('../data/', import.meta.url)) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Analysis generation failed:', error);
  process.exitCode = 1;
}
