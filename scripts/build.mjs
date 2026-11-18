// Builds the three Electron bundles with esbuild (the same tool Presage's
// official quickstart uses) and copies the static page.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });

const common = { bundle: true, logLevel: 'warning', sourcemap: 'linked', target: 'es2022' };

await Promise.all([
    // Main process. The SDK stays external: it loads its native runtime at run time.
    build({
        ...common,
        entryPoints: ['src/main/main.ts'],
        outfile: 'build/main.js',
        platform: 'node',
        format: 'cjs',
        external: ['electron', '@smartspectra/node-sdk', '@smartspectra/node-sdk/*'],
    }),
    // Preload: Drift's narrow bridge plus the SDK's own bridge, bundled into one
    // file because a sandboxed preload can only require('electron').
    build({
        ...common,
        entryPoints: ['src/preload/preload.ts'],
        outfile: 'build/preload.js',
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
    }),
    // Renderer: React UI, the renderer-side SDK, styles and the bundled Inter font.
    build({
        ...common,
        entryPoints: ['src/renderer/main.tsx'],
        outfile: 'build/renderer.js',
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        loader: { '.woff2': 'file', '.woff': 'file' },
        assetNames: 'assets/[name]-[hash]',
        define: { 'process.env.NODE_ENV': '"production"' },
    }),
]);

copyFileSync('src/renderer/index.html', 'build/index.html');
console.log('Built build/main.js, build/preload.js, build/renderer.js');
