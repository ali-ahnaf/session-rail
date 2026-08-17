// Build script for Session Rail.
//
// Usage:
//   node esbuild.js              one-off development build (sourcemap, no minify)
//   node esbuild.js --watch      incremental rebuild on file change
//   node esbuild.js --production minified build, no sourcemap (used by vscode:prepublish)

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').Plugin} */
const rebuildLogPlugin = {
  name: 'rebuild-log',
  setup(build) {
    build.onStart(() => {
      console.log('[session-rail] build starting...');
    });
    build.onEnd((result) => {
      for (const err of result.errors) {
        const loc = err.location;
        if (loc) {
          console.error(`${loc.file}:${loc.line}:${loc.column}: error: ${err.text}`);
        } else {
          console.error(`extension.ts:0:0: error: ${err.text}`);
        }
      }
      if (result.errors.length > 0) {
        console.error('[session-rail] build failed');
      } else {
        console.log('[session-rail] build succeeded');
      }
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    logLevel: 'silent',
    plugins: [rebuildLogPlugin],
  });

  if (watch) {
    await ctx.watch();
    console.log('[session-rail] watching for changes...');
  } else {
    const result = await ctx.rebuild();
    await ctx.dispose();
    if (result.errors.length > 0) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
