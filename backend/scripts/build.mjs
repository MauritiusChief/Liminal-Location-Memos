import { build } from 'esbuild';
import { createBaseBuildOptions } from './esbuild.shared.mjs';

await build(createBaseBuildOptions());
