import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(currentFile), '..');
const sourceRoot = path.join(backendRoot, 'src');
const distRoot = path.join(backendRoot, 'dist');

async function collectSqlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSqlFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.sql')) {
      files.push(fullPath);
    }
  }

  return files;
}

const sqlFiles = await collectSqlFiles(sourceRoot);

for (const sourceFile of sqlFiles) {
  const relativePath = path.relative(sourceRoot, sourceFile);
  const targetFile = path.join(distRoot, relativePath);
  await mkdir(path.dirname(targetFile), { recursive: true });
  await cp(sourceFile, targetFile);
}
