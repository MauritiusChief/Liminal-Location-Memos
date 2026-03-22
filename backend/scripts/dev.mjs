import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createBaseBuildOptions, backendRoot, distEntryPath } from './esbuild.shared.mjs';

let serverProcess = null;

function runCopyRuntimeSql() {
  return new Promise((resolve, reject) => {
    const copyProcess = spawn(process.execPath, ['scripts/copy-runtime-sql.mjs'], {
      cwd: backendRoot,
      stdio: 'inherit',
      env: process.env,
    });

    copyProcess.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`copy-runtime-sql failed with code ${code}`));
    });
    copyProcess.on('error', reject);
  });
}

async function restartServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    try {
      await once(serverProcess, 'exit');
    } catch {
      // Ignore exit race when process already closed.
    }
  }

  serverProcess = spawn(process.execPath, [distEntryPath], {
    cwd: backendRoot,
    stdio: 'inherit',
    env: process.env,
  });
}

const devPlugin = {
  name: 'dev-restart',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) {
        return;
      }

      try {
        await runCopyRuntimeSql();
        await restartServer();
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    });
  },
};

const buildContext = await context(createBaseBuildOptions([devPlugin]));
await buildContext.watch();

const stop = async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }

  await buildContext.dispose();
  process.exit(0);
};

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
