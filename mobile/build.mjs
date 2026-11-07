// Builds the app's web content into www/ (then `npx cap sync ios` copies it into the Xcode project).
// - pdf/: the VS Code extension's PDF viewer (resource/pdf), unchanged except for the bridge script:
//   resource/lib/vscode.js is replaced by app/bridge.js, which talks to the native plugin.
// - react/: the extension's React viewer app (src/react: Excel, Word, PowerPoint, EPUB, fonts...), built
//   with Vite like the extension does, plus app/react-bridge.js standing in for acquireVsCodeApi.
// Set ANYFILE_SKIP_REACT=1 to reuse an existing www/react, ANYFILE_WWW=<folder> to build elsewhere.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..');
// ANYFILE_WWW: build somewhere else (e.g. one folder per parallel test run); default www/.
const www = process.env.ANYFILE_WWW || join(here, 'www');

const reuseReact = process.env.ANYFILE_SKIP_REACT === '1' && existsSync(join(www, 'react/index.html'));
for (const entry of ['app', 'pdf', 'index.html', ...(reuseReact ? [] : ['react'])]) {
    await rm(join(www, entry), { recursive: true, force: true });
}
await mkdir(join(www, 'app'), { recursive: true });

// The viewer
await cp(join(repo, 'resource/pdf'), join(www, 'pdf'), { recursive: true });
const viewerPath = join(www, 'pdf/viewer.html');
let viewer = await readFile(viewerPath, 'utf8');
const replace = (from, to) => {
    if (!viewer.includes(from)) {
        throw new Error(`viewer.html changed: "${from}" not found; update mobile/build.mjs`);
    }
    viewer = viewer.replace(from, to);
};
replace('<base href="{{baseUrl}}/">\n', '');
replace('content="width=device-width, initial-scale=1, maximum-scale=1"',
    'content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"');
replace('<script src="../lib/vscode.js"></script>', '<script src="../app/bridge.js"></script>');
replace('<link rel="stylesheet" href="viewer_adjust.css">',
    '<link rel="stylesheet" href="viewer_adjust.css">\n  <link rel="stylesheet" href="../app/theme.css">\n  <link rel="stylesheet" href="../app/mobile.css">');
await writeFile(viewerPath, viewer);

// The app's scripts (the PDF writer is the extension's src/provider/handlers/pdfHighlightWriter.ts)
await build({
    entryPoints: {
        bridge: join(here, 'src/bridge.ts'),
        'react-bridge': join(here, 'src/reactBridge.ts'),
        library: join(here, 'src/library.ts'),
    },
    outdir: join(www, 'app'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['safari15'],
    // Node's crypto is only a fallback in the writer (it gets the fingerprint from the viewer here).
    external: ['crypto'],
    nodePaths: [join(here, 'node_modules')],
    legalComments: 'none',
    logLevel: 'warning',
});

await copyFile(join(here, 'src/index.html'), join(www, 'index.html'));
await copyFile(join(here, 'src/library.css'), join(www, 'app/library.css'));
await copyFile(join(here, 'src/mobile.css'), join(www, 'app/mobile.css'));
await copyFile(join(here, 'src/theme.css'), join(www, 'app/theme.css'));
await copyFile(join(here, 'src/react-mobile.css'), join(www, 'app/react-mobile.css'));

// The React viewer app (same settings as the repo's vite.config.ts, without its side effects)
if (!reuseReact) {
    const { build: viteBuild } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    await viteBuild({
        configFile: false,
        root: repo,
        base: '',
        mode: 'production',
        logLevel: 'warn',
        plugins: [react()],
        define: { global: 'globalThis' },
        resolve: {
            alias: {
                buffer: 'buffer',
                stream: join(repo, 'src/react/shims/nodeStream.ts'),
                util: join(repo, 'src/react/shims/nodeUtil.ts'),
            },
        },
        build: {
            outDir: join(www, 'react'),
            emptyOutDir: true,
            // The app's minimum iOS version (the Word viewer needs Safari 16.4).
            target: 'safari16.4',
            chunkSizeWarningLimit: 4096,
            reportCompressedSize: false,
        },
    });
    const reactPath = join(www, 'react/index.html');
    let page = await readFile(reactPath, 'utf8');
    const patch = (from, to) => {
        if (!page.includes(from)) {
            throw new Error(`index.html changed: "${from}" not found; update mobile/build.mjs`);
        }
        page = page.replace(from, to);
    };
    patch('<base href="/">', '');
    patch('content="width=device-width, initial-scale=1.0"',
        'content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"');
    // The bridge must run before the app's module script (modules are deferred; this classic script is not).
    patch(`<meta id="office-configs" data-config='{{configs}}'>`, `<meta id="office-configs" data-config='{{configs}}'>
  <link rel="stylesheet" href="../app/theme.css">
  <link rel="stylesheet" href="../app/react-mobile.css">
  <script src="../app/react-bridge.js"></script>`);
    await writeFile(reactPath, page);
}
await copyFile(join(repo, 'image/anyfile-logo.png'), join(www, 'app/logo.png'));
console.log('Built www/');
