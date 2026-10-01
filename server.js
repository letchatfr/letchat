// Compatibility entry point; the maintained application lives in letchat-v4.
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('./letchat-v4/', import.meta.url)));
await import('./letchat-v4/scripts/build-assets.mjs');
await import('./letchat-v4/server.js');
