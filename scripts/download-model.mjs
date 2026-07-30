import { pipeline, env } from '@xenova/transformers';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(__dirname, '..', 'models');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

async function main() {
  console.log(`Downloading model: ${MODEL_ID}`);
  console.log(`Model directory: ${MODEL_DIR}`);

  if (!existsSync(MODEL_DIR)) {
    await mkdir(MODEL_DIR, { recursive: true });
  }

  env.cacheDir = MODEL_DIR;
  env.allowRemoteModels = true;

  try {
    const extractor = await pipeline('feature-extraction', MODEL_ID, {
      quantized: true,
      progress_callback: function (progress) {
        if (progress.status === 'download') {
          const pct = ((progress.loaded / progress.total) * 100).toFixed(1);
          process.stdout.write(`\rDownloading: ${pct}% (${(progress.loaded / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB)`);
        }
      },
    });

    console.log('\nTesting model...');
    const result = await extractor('Repository Memory Engine test', {
      pooling: 'mean',
      normalize: true,
    });

    const arr = Array.from(result.data);
    console.log(`Embedding dimensions: ${arr.length}`);
    console.log(`First 5 values: ${arr.slice(0, 5).map(v => v.toFixed(4)).join(', ')}`);
    console.log('\nModel downloaded and verified successfully!');
    console.log(`Cached at: ${MODEL_DIR}`);
  } catch (error) {
    console.error('\nFailed to download model:', error);
    process.exit(1);
  }
}

main();
