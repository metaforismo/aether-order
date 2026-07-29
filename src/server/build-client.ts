/**
 * The client build: one esbuild call, no bundler config, no framework.
 *
 * docs/DESIGN.md §7.3 budgets 180 KB gzipped of JavaScript for ten screens, two
 * renderers, an audio engine, a verifier, a lobby and a clip encoder. This
 * graybox ships the screens, the choreography and the verifier; keeping the
 * toolchain to a single transpile is how that budget stays inspectable.
 */

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const clientSrc = fileURLToPath(new URL('../client/', import.meta.url));
const outDir = fileURLToPath(new URL('../../dist/client/', import.meta.url));

const options: esbuild.BuildOptions = {
  entryPoints: [`${clientSrc}main.ts`],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  outdir: outDir,
  entryNames: 'app',
  sourcemap: true,
  logLevel: 'warning',
};

export async function buildClient(watch = false): Promise<string> {
  await mkdir(outDir, { recursive: true });
  if (watch) {
    const context = await esbuild.context(options);
    await context.rebuild();
    await context.watch();
  } else {
    await esbuild.build(options);
  }
  await cp(`${clientSrc}index.html`, `${outDir}index.html`);
  await writeFile(
    `${outDir}.gitignore`,
    '# Build output. `npm run dev` and `npm run build` regenerate it.\n*\n',
  );
  return outDir;
}

export const CLIENT_OUT_DIR = outDir;
