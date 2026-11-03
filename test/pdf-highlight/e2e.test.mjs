// End-to-end test of PDF highlighting: the real viewer (resource/pdf) in headless Chrome, with a
// fake extension host that saves through the real pdfHighlightWriter, like pdfHighlightHandler does.
// Run: node test/pdf-highlight/e2e.test.mjs   (PDF_HL_HEADFUL=1 to watch)
import assert from 'node:assert/strict';
import { Module } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import {
    REPO_ROOT, pdfLib, startStaticServer, makeTextPdf, expectedTextBox, openViewer, selectText,
    textClientRect, overlayRects, pdfToClient, scrollPageIntoView,
} from './harness.mjs';

async function bundleWriter() {
    const result = await build({
        entryPoints: [join(REPO_ROOT, 'src/provider/handlers/pdfHighlightWriter.ts')],
        bundle: true, platform: 'node', format: 'cjs', external: ['pdf-lib'], write: false, logLevel: 'silent',
    });
    const filename = join(REPO_ROOT, 'test/pdf-highlight/pdfHighlightWriter.e2e.cjs');
    const mod = new Module(filename);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(join(REPO_ROOT, 'test/pdf-highlight'));
    mod._compile(result.outputFiles[0].text, filename);
    return mod.exports;
}

const writer = await bundleWriter();
let server;
before(async () => { server = await startStaticServer(); });
after(async () => { await server?.close(); });

// Fake extension host: applies ops with the real writer, answers like pdfHighlightHandler.
function createHost(initialBytes) {
    const host = { bytes: initialBytes, saves: 0, chain: Promise.resolve() };
    host.onMessage = async (message, viewer) => {
        if (message.type !== 'pdfHighlightAdd' && message.type !== 'pdfHighlightRemove') {
            return false;
        }
        const op = { ...message.content, type: message.type === 'pdfHighlightAdd' ? 'add' : 'remove' };
        host.chain = host.chain.then(async () => {
            const document = await writer.PdfHighlightDocument.load(host.bytes);
            const [result] = document.apply([op]);
            if (result.changed) {
                host.bytes = await document.save({ fingerprint: op.fingerprint });
                host.saves++;
            }
            await viewer.post('pdfHighlightResult', { ok: result.ok, ids: op.type === 'add' ? [op.id] : [], error: result.error });
            if (result.removedRef) {
                await viewer.post('open', { buffer: host.bytes });
            }
        });
        await host.chain;
        return true;
    };
    host.settle = () => host.chain;
    return host;
}

async function fileHighlights(bytes) {
    const doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
    const { PDFName, PDFArray, PDFDict } = pdfLib;
    return doc.getPages().map((page) => {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) return [];
        return annots.asArray().map((ref) => doc.context.lookup(ref)).filter((dict) => dict instanceof PDFDict
            && dict.lookup(PDFName.of('Subtype')) === PDFName.of('Highlight'))
            .map((dict) => {
                const qp = dict.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map((n) => n.asNumber());
                const quads = [];
                for (let i = 0; i < qp.length; i += 8) {
                    const xs = [qp[i], qp[i + 2], qp[i + 4], qp[i + 6]];
                    const ys = [qp[i + 1], qp[i + 3], qp[i + 5], qp[i + 7]];
                    quads.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
                }
                return { quads };
            });
    });
}

async function fingerprintOf(viewer) {
    return viewer.page.evaluate(() => PDFViewerApplication.pdfDocument.fingerprints[0]);
}

// Fractions of "highlight colored" and "white" pixels inside a client rect (glyph pixels are neither).
async function regionColors(viewer, rect, inset = 2) {
    const clip = { x: Math.round(rect.left + inset), y: Math.round(rect.top + inset), width: Math.max(2, Math.round(rect.right - rect.left - 2 * inset)), height: Math.max(2, Math.round(rect.bottom - rect.top - 2 * inset)) };
    // captureBeyondViewport would resize the viewport, making PDF.js re-zoom and re-render mid-capture
    const base64 = await viewer.page.screenshot({ clip, encoding: 'base64', captureBeyondViewport: false });
    return viewer.page.evaluate(async (b64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${b64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, image.width, image.height).data;
        let yellow = 0, white = 0, total = 0;
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
            const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
            total++;
            if (r > 200 && g > 170 && b < 170) yellow++;
            if (r > 235 && g > 235 && b > 235) white++;
            const key = `${r >> 2},${g >> 2},${b >> 2}`;
            buckets.set(key, (buckets.get(key) || 0) + 1);
        }
        // Most frequent colour: the highlight background, unaffected by glyph pixels in light or dark mode
        const [dominantKey] = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
        const dominant = dominantKey.split(',').map((v) => Number(v) * 4 + 2);
        return { yellow: yellow / total, white: white / total, dominant };
    }, base64);
}

async function pdfQuadToClientRect(viewer, pageNumber, [x1, y1, x2, y2]) {
    const [ax, ay] = await pdfToClient(viewer.page, pageNumber, x1, y1);
    const [bx, by] = await pdfToClient(viewer.page, pageNumber, x2, y2);
    return { left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by) };
}

async function clickAt(viewer, x, y) {
    await viewer.page.evaluate((cx, cy) => {
        window.getSelection().removeAllRanges();
        const target = document.elementFromPoint(cx, cy);
        const init = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: cx, clientY: cy };
        target.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
        target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    }, x, y);
    await new Promise((r) => setTimeout(r, 60));
}

async function waitForNewDocument(viewer, previousFingerprintCheck) {
    await viewer.page.waitForFunction(() => window.__vsoDocCount && PDFViewerApplication.pdfDocument && window.__vsoDocCount > window.__vsoDocCountBefore, { timeout: 15000 });
}

// Waits until the page is rendered (RenderingStates.FINISHED === 3) and its layout has stopped
// changing: restoring the sidebar on load re-runs "auto" zoom, which moves and rescales pages.
async function waitForRendered(viewer, pageNumber) {
    await viewer.waitForTextLayer(pageNumber);
    let last = '', stableSince = Date.now();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const snapshot = await viewer.page.evaluate((n) => {
            const view = PDFViewerApplication.pdfViewer.getPageView(n - 1);
            const r = view?.div.getBoundingClientRect();
            return view && view.renderingState === 3 ? `${view.viewport.scale}|${Math.round(r.left)}|${Math.round(r.top)}|${Math.round(r.width)}` : null;
        }, pageNumber);
        if (snapshot !== last) {
            last = snapshot;
            stableSince = Date.now();
        } else if (snapshot && Date.now() - stableSince >= 300) {
            return;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`page ${pageNumber} did not settle`);
}

async function trackDocuments(viewer) {
    await viewer.page.evaluate(() => {
        window.__vsoDocCount = 1;
        PDFViewerApplication.eventBus.on('documentloaded', () => { window.__vsoDocCount++; });
    });
}

function near(actual, expected, tolerance, label) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);
}

async function open(pdf, options = {}) {
    const host = createHost(pdf.bytes);
    const viewer = await openViewer({ pdfBytes: pdf.bytes, server, onMessage: host.onMessage, ...options });
    await waitForRendered(viewer, 1);
    return { host, viewer };
}

test('1. selecting a phrase highlights it and writes a matching /Highlight into the PDF', async () => {
    const pdf = await makeTextPdf();
    const { host, viewer } = await open(pdf);
    try {
        const selected = await selectText(viewer.page, { startText: 'quick brown fox' });
        assert.equal(selected, 'quick brown fox');
        const add = await viewer.waitForMessage('pdfHighlightAdd');
        await host.settle();
        assert.equal(add.content.pageIndex, 0);
        assert.equal((await overlayRects(viewer.page, 1)).length, 1, 'one overlay quad');
        const [page1] = await fileHighlights(host.bytes);
        assert.equal(page1.length, 1);
        assert.equal(page1[0].quads.length, 1);
        const expected = expectedTextBox(pdf, pdf.layout[0][0], 'quick brown fox');
        const [x1, y1, x2, y2] = page1[0].quads[0];
        near(x1, expected.x1, 1.5, 'left');
        near(x2, expected.x2, 1.5, 'right');
        assert.ok(y1 <= expected.baseline && y2 >= expected.top - 1, `quad y ${y1}..${y2} covers baseline ${expected.baseline}..top ${expected.top}`);
        assert.ok(y2 - y1 < pdf.fontSize * 1.6, 'quad height is about one line');
        assert.equal(await viewer.page.evaluate(() => window.getSelection().toString()), 'quick brown fox', 'selection kept so copy still works');
        await viewer.page.screenshot({ path: join(process.env.SHOT_DIR || '/tmp', 'hl-1-session.png') });
        assert.deepEqual(viewer.pageErrors, []);
    } finally { await viewer.close(); }
});

test('2. multi-line selection gives one quad per line, none overlapping', async () => {
    const pdf = await makeTextPdf();
    const { host, viewer } = await open(pdf);
    try {
        await selectText(viewer.page, { startText: 'lazy dog.', endText: 'Third line' });
        await viewer.waitForMessage('pdfHighlightAdd');
        await host.settle();
        const [page1] = await fileHighlights(host.bytes);
        assert.equal(page1.length, 1);
        const quads = page1[0].quads.sort((a, b) => b[1] - a[1]);
        assert.equal(quads.length, 3, `3 lines -> 3 quads, got ${JSON.stringify(quads)}`);
        for (let i = 1; i < quads.length; i++) {
            assert.ok(quads[i][3] <= quads[i - 1][1] + 0.5, `line ${i} does not overlap line ${i - 1}`);
        }
    } finally { await viewer.close(); }
});

test('3. a selection spanning two pages creates one highlight per page', async () => {
    const pdf = await makeTextPdf();
    const { host, viewer } = await open(pdf);
    try {
        await scrollPageIntoView(viewer.page, 1, 120);
        await viewer.waitForTextLayer(2);
        await selectText(viewer.page, { pageNumber: 1, startText: 'closes the first', endPageNumber: 2, endText: 'The quick' });
        await host.settle();
        await new Promise((r) => setTimeout(r, 100));
        await host.settle();
        const adds = await viewer.messages('pdfHighlightAdd');
        assert.deepEqual(adds.map((m) => m.content.pageIndex).sort(), [0, 1]);
        const pages = await fileHighlights(host.bytes);
        assert.equal(pages[0].length, 1);
        assert.equal(pages[1].length, 1);
    } finally { await viewer.close(); }
});

test('4+5. saved highlight renders from the file, keeps the fingerprint, and can be removed in place', async () => {
    const pdf = await makeTextPdf();
    // Session 1: create the highlight on page 2 (exercise view restore on a non-first page)
    let saved, originalFingerprint;
    {
        const { host, viewer } = await open(pdf);
        try {
            originalFingerprint = await fingerprintOf(viewer);
            await scrollPageIntoView(viewer.page, 2, 760);
            await waitForRendered(viewer, 2);
            await selectText(viewer.page, { pageNumber: 2, startText: 'Second line of sample' });
            await viewer.waitForMessage('pdfHighlightAdd');
            await host.settle();
            saved = host.bytes;
        } finally { await viewer.close(); }
    }
    // Session 2: reopen the saved file
    const host = createHost(saved);
    const viewer = await openViewer({ pdfBytes: saved, server, onMessage: host.onMessage });
    try {
        await waitForRendered(viewer, 1);
        assert.equal(await fingerprintOf(viewer), originalFingerprint, 'fingerprint (last-page restore key) unchanged after saving');
        await scrollPageIntoView(viewer.page, 2, 760);
        await waitForRendered(viewer, 2);
        assert.equal((await overlayRects(viewer.page, 2)).length, 0, 'no session overlay: highlight is drawn from the file');
        const [, page2] = await fileHighlights(saved);
        const rect = await pdfQuadToClientRect(viewer, 2, page2[0].quads[0]);
        const colors = await regionColors(viewer, rect);
        assert.ok(colors.yellow > 0.4, `baked highlight is yellow (${JSON.stringify(colors)})`);
        await viewer.page.screenshot({ path: join(process.env.SHOT_DIR || '/tmp', 'hl-4-baked.png') });
        const unhighlighted = await textClientRect(viewer.page, 2, 'Third line closes');
        assert.ok((await regionColors(viewer, { ...unhighlighted, top: unhighlighted.top, bottom: unhighlighted.bottom })).yellow < 0.05, 'other text is not highlighted');

        // Text across an existing highlight is still selectable (no annotation DOM blocks it)
        const blocker = await viewer.page.evaluate((x, y) => document.elementFromPoint(x, y)?.closest('.annotationLayer') ? 'annotationLayer' : null, (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        assert.equal(blocker, null, 'no annotation-layer element over the highlight');

        // 5. click it -> popup -> remove -> file updated, viewer reloads, stays on page 2
        await trackDocuments(viewer);
        await viewer.page.evaluate(() => { window.__vsoDocCountBefore = window.__vsoDocCount; });
        await clickAt(viewer, rect.left + 3, (rect.top + rect.bottom) / 2);
        await viewer.page.waitForSelector('.office-hl-popup-remove', { timeout: 3000 });
        await viewer.page.click('.office-hl-popup-remove');
        await viewer.waitForMessage('pdfHighlightRemove', (c) => !!c.ref);
        await host.settle();
        assert.equal((await fileHighlights(host.bytes))[1].length, 0, 'highlight removed from the file');
        await waitForNewDocument(viewer);
        await viewer.page.waitForFunction(() => PDFViewerApplication.page === 2, { timeout: 5000 }).catch(() => {});
        assert.equal(await viewer.page.evaluate(() => PDFViewerApplication.page), 2, 'still on page 2 after reload');
        await waitForRendered(viewer, 2);
        const after = await pdfQuadToClientRect(viewer, 2, page2[0].quads[0]);
        assert.ok((await regionColors(viewer, after)).yellow < 0.05, 'highlight gone from the canvas');
        assert.equal(await fingerprintOf(viewer), originalFingerprint);
        assert.deepEqual(viewer.pageErrors, []);
    } finally { await viewer.close(); }
});

test('6. toggling mode off stops highlighting and persists; default is on', async () => {
    const pdf = await makeTextPdf();
    const { viewer } = await open(pdf);
    try {
        assert.equal(await viewer.page.$eval('#highlightModeToggle', (b) => b.classList.contains('toggled')), true, 'on by default');
        await viewer.page.click('#highlightModeToggle');
        assert.equal(await viewer.page.$eval('#highlightModeToggle', (b) => b.classList.contains('toggled')), false);
        await selectText(viewer.page, { startText: 'quick brown' });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal((await viewer.messages('pdfHighlightAdd')).length, 0, 'no highlight while off');
        await viewer.page.reload({ waitUntil: 'load' });
        await viewer.waitForTextLayer(1);
        assert.equal(await viewer.page.$eval('#highlightModeToggle', (b) => b.classList.contains('toggled')), false, 'stays off after reload');
    } finally { await viewer.close(); }
});

test('7. read-only config disables the toggle and highlighting', async () => {
    const pdf = await makeTextPdf();
    const { viewer } = await open(pdf, { config: { writable: false, reason: 'read-only' } });
    try {
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(await viewer.page.$eval('#highlightModeToggle', (b) => b.disabled), true);
        await selectText(viewer.page, { startText: 'quick brown' });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal((await viewer.messages('pdfHighlightAdd')).length, 0);
    } finally { await viewer.close(); }
});

test('8. rotated page: highlight lands on the selected text', async () => {
    const base = await makeTextPdf({ pages: [{}] });
    const doc = await pdfLib.PDFDocument.load(base.bytes);
    doc.getPage(0).setRotation(pdfLib.degrees(90));
    const pdf = { ...base, bytes: await doc.save({ useObjectStreams: false }) };
    const { host, viewer } = await open(pdf);
    try {
        await selectText(viewer.page, { startText: 'quick brown fox' });
        await viewer.waitForMessage('pdfHighlightAdd');
        await host.settle();
        const [page1] = await fileHighlights(host.bytes);
        const expected = expectedTextBox(pdf, pdf.layout[0][0], 'quick brown fox');
        const [x1, y1, x2, y2] = page1[0].quads[0];
        near(x1, expected.x1, 1.5, 'left');
        near(x2, expected.x2, 1.5, 'right');
        assert.ok(y1 <= expected.baseline && y2 >= expected.top - 1, 'covers the line');
    } finally { await viewer.close(); }
});

test('9. overlay stays aligned with the text after zooming to 200%', async () => {
    const pdf = await makeTextPdf();
    const { viewer } = await open(pdf);
    try {
        await selectText(viewer.page, { startText: 'quick brown fox' });
        await viewer.waitForMessage('pdfHighlightAdd');
        const rendered = await viewer.armTextLayerRendered(1);
        await viewer.page.evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = '2'; });
        await rendered();
        await new Promise((r) => setTimeout(r, 150));
        await scrollPageIntoView(viewer.page, 1, 720);
        await new Promise((r) => setTimeout(r, 300));
        const [overlay] = await overlayRects(viewer.page, 1);
        const text = await textClientRect(viewer.page, 1, 'quick brown fox');
        assert.ok(overlay, 'overlay re-attached after zoom');
        near(overlay.left, text.left, 3, 'overlay left');
        near(overlay.right, text.right, 3, 'overlay right');
        assert.ok(overlay.top <= text.top + 3 && overlay.bottom >= text.bottom - 3, 'overlay covers text vertically');
    } finally { await viewer.close(); }
});

test('10. dark mode: session overlay looks like the saved highlight', async () => {
    const pdf = await makeTextPdf({ pages: [{}] });
    const storage = { 'office-pdf-dark-mode': '1' };
    let sessionMean, saved, quad;
    {
        const { host, viewer } = await open(pdf, { localStorage: storage });
        try {
            await selectText(viewer.page, { startText: 'quick brown fox' });
            await viewer.waitForMessage('pdfHighlightAdd');
            await host.settle();
            await viewer.page.evaluate(() => window.getSelection().removeAllRanges());
            await waitForRendered(viewer, 1);
            saved = host.bytes;
            quad = (await fileHighlights(saved))[0][0].quads[0];
            sessionMean = (await regionColors(viewer, await pdfQuadToClientRect(viewer, 1, quad))).dominant;
            await viewer.page.screenshot({ path: join(process.env.SHOT_DIR || '/tmp', 'hl-10-dark-session.png') });
        } finally { await viewer.close(); }
    }
    const viewer = await openViewer({ pdfBytes: saved, server, localStorage: storage });
    try {
        await waitForRendered(viewer, 1);
        const bakedMean = (await regionColors(viewer, await pdfQuadToClientRect(viewer, 1, quad))).dominant;
        await viewer.page.screenshot({ path: join(process.env.SHOT_DIR || '/tmp', 'hl-10-dark-baked.png') });
        for (let i = 0; i < 3; i++) {
            near(sessionMean[i], bakedMean[i], 24, `dark-mode channel ${i} (session ${sessionMean} vs baked ${bakedMean})`);
        }
    } finally { await viewer.close(); }
});

test('11. Ctrl/Cmd+Z undoes the last highlight in the file too', async () => {
    const pdf = await makeTextPdf();
    const { host, viewer } = await open(pdf);
    try {
        await selectText(viewer.page, { startText: 'quick brown fox' });
        await viewer.waitForMessage('pdfHighlightAdd');
        await host.settle();
        assert.equal((await fileHighlights(host.bytes))[0].length, 1);
        await viewer.page.keyboard.down('Control');
        await viewer.page.keyboard.press('KeyZ');
        await viewer.page.keyboard.up('Control');
        await viewer.waitForMessage('pdfHighlightRemove');
        await host.settle();
        assert.equal((await fileHighlights(host.bytes))[0].length, 0, 'undo removed it from the file');
        assert.equal((await overlayRects(viewer.page, 1)).length, 0, 'overlay removed');
    } finally { await viewer.close(); }
});
