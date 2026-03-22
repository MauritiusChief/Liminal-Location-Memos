import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
export const backendRoot = path.resolve(path.dirname(currentFile), '..');
export const sourceRoot = path.join(backendRoot, 'src');
export const distRoot = path.join(backendRoot, 'dist');
export const distEntryPath = path.join(distRoot, 'db', 'index.js');

export function createBaseBuildOptions(plugins = []) {
  return {
    absWorkingDir: backendRoot,
    entryPoints: [path.join(sourceRoot, 'index.ts')],
    outfile: distEntryPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    tsconfig: path.join(backendRoot, 'tsconfig.json'),
    logLevel: 'info',
    alias: {
      '@': sourceRoot,
    },
    plugins,
  };
}
