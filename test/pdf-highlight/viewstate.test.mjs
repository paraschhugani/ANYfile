// Reading position stored in the PDF file (/ANYfileLastView document info entry): the writer op,
// and the real viewer (headless Chrome) restoring/reporting it through a fake extension host that
// mirrors pdfHighlightHandler's saveViewState rule.
// Run: node test/pdf-highlight/viewstate.test.mjs
import assert from 'node:assert/strict';
import { Module } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { REPO_ROOT, pdfLib, startStaticServer, makeTextPdf, openViewer, scrollPageIntoView } from './harness.mjs';

const KEY = 'ANYfileLastView';
const FIXED_ID = '00112233445566778899aabbccddeeff';

async function bundleWriter() {
    const result = await build({
        entryPoints: [join(REPO_ROOT, 'src/provider/handlers/pdfHighlightWriter.ts')],
        bundle: true, platform: 'node', format: 'cjs', external: ['pdf-lib'], write: false, logLevel: 'silent',
    });
    const filename = join(REPO_ROOT, 'test/pdf-highlight/pdfHighlightWriter.viewstate.cjs');
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

async function writeView(bytes, state, fingerprint = null) {
    const document = await writer.PdfHighlightDocument.load(bytes);
    const [result] = document.apply([{ type: 'view', state, fingerprint }]);
    return { result, bytes: result.changed ? await document.save({ fingerprint }) : bytes };
}

async function storedView(bytes) {
    const doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    const value = info?.lookup(pdfLib.PDFName.of(KEY));
    return value ? JSON.parse(value.decodeText()) : null;
}

const threePages = () => makeTextPdf({ pages: [{}, {}, {}], withId: true });

// Fake extension host: records what the viewer reports and saves like pdfHighlightHandler.saveViewState.
function createHost(bytes) {
    const host = { bytes, storedPage: undefined, viewState: null, fingerprint: null, writes: 0 };
    host.onMessage = async (message) => {
        if (message.type === 'pdfViewStored') {
            host.storedPage = Number.isInteger(message.content?.page) ? message.content.page : null;
            host.fingerprint = message.content?.fingerprint ?? null;
            return true;
        }
        if (message.type === 'pdfViewChanged') {
            host.viewState = message.content;
            return true;
        }
        return false;
    };
    // = saveViewState(): only when the page differs from the stored one (missing counts as page 1)
    host.saveViewState = async () => {
        const state = host.viewState;
        if (!state || host.storedPage === undefined || state.page === (host.storedPage ?? 1)) {
            return false;
        }
        host.storedPage = state.page;
        const { result, bytes: saved } = await writeView(host.bytes, { ...state, t: Date.now() }, host.fingerprint);
        if (result.changed) {
            host.bytes = saved;
            host.writes++;
        }
        return result.changed;
    };
    return host;
}

async function currentPage(viewer) {
    return viewer.page.evaluate(() => PDFViewerApplication.page);
}

async function waitForPage(viewer, page, timeout = 6000) {
    await viewer.page.waitForFunction((n) => PDFViewerApplication.page === n, { timeout }, page)
        .catch(() => { });
    return currentPage(viewer);
}

async function waitForStored(viewer, host) {
    await viewer.waitForMessage('pdfViewStored', () => true, 8000);
    return host.storedPage;
}

// scrollTop is in PDF coordinates (y up): 792 is the top edge of these Letter-size pages
function historySeed(page) {
    return JSON.stringify({ files: [{ fingerprint: FIXED_ID, page, zoom: 'auto', scrollLeft: '0', scrollTop: '792', rotation: 0, sidebarView: 0, scrollMode: 0, spreadMode: 0 }] });
}

// ------------------------------------------------------------------ writer

test('W1. view op stores JSON in the document info and keeps other info entries and /ID', async () => {
    const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
    doc.addPage(); doc.addPage();
    doc.setTitle('Quarterly report');
    doc.context.trailerInfo.ID = doc.context.obj([pdfLib.PDFHexString.of(FIXED_ID), pdfLib.PDFHexString.of(FIXED_ID)]);
    const original = await doc.save();
    const { result, bytes } = await writeView(original, { page: 2, left: 12.6, top: 700.4 });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(await storedView(bytes), { v: 1, page: 2, left: 13, top: 700 });
    const reloaded = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(reloaded.getTitle(), 'Quarterly report', 'existing info entries kept');
    // same position again: nothing to write
    const again = await writeView(bytes, { page: 2, left: 13, top: 700 });
    assert.equal(again.result.changed, false);
    // invalid pages are refused
    assert.equal((await writeView(bytes, { page: 3 })).result.ok, false);
    assert.equal((await writeView(bytes, { page: 0 })).result.ok, false);
    assert.equal((await writeView(bytes, { page: 1.5 })).result.ok, false);
});

test('W2. a PDF without an info dictionary gets one', async () => {
    const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    const bytes = await doc.save();
    const raw = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
    delete raw.context.trailerInfo.Info;
    const noInfo = await raw.save();
    const { result, bytes: saved } = await writeView(noInfo, { page: 1, top: 10 });
    assert.equal(result.changed, true);
    assert.deepEqual(await storedView(saved), { v: 1, page: 1, top: 10 });
});

// ------------------------------------------------------------------ viewer

test('V1. opening a PDF with a stored position lands on that page (fresh profile, no local history)', async () => {
    const pdf = await threePages();
    const { bytes } = await writeView(pdf.bytes, { page: 3, top: 792 });
    const host = createHost(bytes);
    const viewer = await openViewer({ pdfBytes: bytes, server, onMessage: host.onMessage });
    try {
        assert.equal(await waitForStored(viewer, host), 3, 'viewer reports the stored page');
        assert.equal(host.fingerprint, FIXED_ID, 'and the fingerprint');
        assert.equal(await waitForPage(viewer, 3), 3);
        assert.deepEqual(viewer.pageErrors, []);
    } finally { await viewer.close(); }
});

test('V2. the stored position wins over local history', async () => {
    const pdf = await threePages();
    const { bytes } = await writeView(pdf.bytes, { page: 3, top: 792 });
    const host = createHost(bytes);
    const viewer = await openViewer({ pdfBytes: bytes, server, onMessage: host.onMessage, localStorage: { 'pdfjs.history': historySeed(1) } });
    try {
        await waitForStored(viewer, host);
        assert.equal(await waitForPage(viewer, 3), 3);
    } finally { await viewer.close(); }
});

test('V3. with the setting off the stored position is ignored (local history is used)', async () => {
    const pdf = await threePages();
    const { bytes } = await writeView(pdf.bytes, { page: 3, top: 792 });
    const host = createHost(bytes);
    const viewer = await openViewer({ pdfBytes: bytes, server, onMessage: host.onMessage, viewConfig: { rememberPosition: false }, localStorage: { 'pdfjs.history': historySeed(2) } });
    try {
        await waitForStored(viewer, host);
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(await waitForPage(viewer, 2), 2, 'history page, not the stored one');
    } finally { await viewer.close(); }
});

test('V4. reading to another page reports it; saving writes it; reopening elsewhere lands there', async () => {
    const pdf = await threePages();
    const host = createHost(pdf.bytes);
    let viewer = await openViewer({ pdfBytes: pdf.bytes, server, onMessage: host.onMessage });
    try {
        assert.equal(await waitForStored(viewer, host), null, 'no stored position yet');
        assert.equal(await host.saveViewState(), false, 'no write while still on page 1');
        await scrollPageIntoView(viewer.page, 2, 500);
        await viewer.page.waitForFunction(() => PDFViewerApplication.page === 2, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 700)); // debounce
        assert.equal(host.viewState?.page, 2, 'viewer reported page 2');
        assert.equal(await host.saveViewState(), true, 'page changed: written');
        assert.equal(await host.saveViewState(), false, 'second flush (e.g. close after hide): no rewrite');
        const stored = await storedView(host.bytes);
        assert.equal(stored.page, 2);
        assert.equal(typeof stored.top, 'number');
    } finally { await viewer.close(); }
    // "another device": fresh browser profile, same file
    const host2 = createHost(host.bytes);
    viewer = await openViewer({ pdfBytes: host.bytes, server, onMessage: host2.onMessage });
    try {
        assert.equal(await waitForStored(viewer, host2), 2);
        assert.equal(await waitForPage(viewer, 2), 2);
        assert.equal(await viewer.page.evaluate(() => PDFViewerApplication.pdfDocument.fingerprints[0]), FIXED_ID, 'fingerprint unchanged');
    } finally { await viewer.close(); }
});

test('V5. a reload in the same viewer (e.g. after removing a highlight) does not jump back to the stored page', async () => {
    const pdf = await threePages();
    const { bytes } = await writeView(pdf.bytes, { page: 3, top: 792 });
    const host = createHost(bytes);
    const viewer = await openViewer({ pdfBytes: bytes, server, onMessage: host.onMessage });
    try {
        await waitForStored(viewer, host);
        assert.equal(await waitForPage(viewer, 3), 3);
        await scrollPageIntoView(viewer.page, 1, 792);
        await viewer.page.waitForFunction(() => PDFViewerApplication.page === 1, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 700));
        await viewer.clearMessages();
        await viewer.post('open', { buffer: bytes });
        await viewer.waitForMessage('pdfViewStored', () => true, 8000);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await currentPage(viewer), 1, 'stays where the reader was');
    } finally { await viewer.close(); }
});

// ------------------------------------------------------------------ review fixes

function lastSeenSeed(t) {
    return JSON.stringify({ [FIXED_ID]: t });
}

test('W3. save time, PDF 2.0 version and an all-zero /ID are handled', async () => {
    const pdf = await threePages();
    const { bytes } = await writeView(pdf.bytes, { page: 2, t: 1730000000123 });
    assert.equal((await storedView(bytes)).t, 1730000000123, 'save time stored');

    const v20 = Buffer.from(pdf.bytes);
    v20.set(Buffer.from('%PDF-2.0', 'latin1'), 0);
    const out20 = (await writeView(v20, { page: 1, top: 10 })).bytes;
    const doc20 = await pdfLib.PDFDocument.load(out20, { updateMetadata: false });
    assert.equal(doc20.catalog.lookup(pdfLib.PDFName.of('Version'))?.decodeText(), '2.0', 'PDF 2.0 kept via catalog /Version');

    const zero = await pdfLib.PDFDocument.load(pdf.bytes, { updateMetadata: false });
    const zeroId = pdfLib.PDFHexString.of('00000000000000000000000000000000');
    zero.context.trailerInfo.ID = zero.context.obj([zeroId, zeroId]);
    const zeroBytes = await zero.save({ useObjectStreams: false });
    const first = (await writeView(zeroBytes, { page: 2, top: 10 }, 'abcdefabcdefabcdefabcdefabcdefab')).bytes;
    const second = (await writeView(first, { page: 3, top: 10 })).bytes;
    const ids = await Promise.all([first, second].map(async (b) => {
        const d = await pdfLib.PDFDocument.load(b, { updateMetadata: false });
        return d.context.lookup(d.context.trailerInfo.ID).lookup(0).asString();
    }));
    assert.deepEqual(ids, ['abcdefabcdefabcdefabcdefabcdefab', 'abcdefabcdefabcdefabcdefabcdefab'], 'zero /ID replaced once, then stable');
});

test('V6. same device after quitting without closing: local history wins over an older stored position', async () => {
    const pdf = await threePages();
    const { bytes } = await writeView(pdf.bytes, { page: 3, top: 792, t: 1000 });
    const host = createHost(bytes);
    const viewer = await openViewer({ pdfBytes: bytes, server, onMessage: host.onMessage, localStorage: { 'pdfjs.history': historySeed(2), 'anyfile.pdf.lastSeen': lastSeenSeed(Date.now()) } });
    try {
        await waitForStored(viewer, host);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await currentPage(viewer), 2, 'stays on the newer local position');
    } finally { await viewer.close(); }
});

test('V7. a position saved after this device last saw the PDF (another device) wins', async () => {
    const pdf = await threePages();
    const { bytes } = await writeView(pdf.bytes, { page: 3, top: 792, t: Date.now() });
    const host = createHost(bytes);
    const viewer = await openViewer({ pdfBytes: bytes, server, onMessage: host.onMessage, localStorage: { 'pdfjs.history': historySeed(2), 'anyfile.pdf.lastSeen': lastSeenSeed(Date.now() - 86400000) } });
    try {
        await waitForStored(viewer, host);
        assert.equal(await waitForPage(viewer, 3), 3);
    } finally { await viewer.close(); }
});

test('V8. mixed page sizes: the stored position survives PDF.js re-applying its initial view', async () => {
    const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
    for (const [w, h] of [[612, 792], [792, 612], [612, 792], [400, 600], [612, 792]]) {
        doc.addPage([w, h]).drawText(`page ${doc.getPageCount()}`, { x: 50, y: h - 80, size: 24, font });
    }
    doc.context.trailerInfo.ID = doc.context.obj([pdfLib.PDFHexString.of(FIXED_ID), pdfLib.PDFHexString.of(FIXED_ID)]);
    const base = await doc.save();
    const { bytes } = await writeView(base, { page: 4, top: 600, t: Date.now() });
    const host = createHost(bytes);
    const viewer = await openViewer({ pdfBytes: bytes, server, onMessage: host.onMessage, localStorage: { 'pdfjs.history': historySeed(1) } });
    try {
        await waitForStored(viewer, host);
        await viewer.page.evaluate(() => PDFViewerApplication.pdfViewer.pagesPromise);
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(await currentPage(viewer), 4, 'still on the stored page after all pages are laid out');
        assert.equal(host.viewState?.page, 4, 'and that is what the viewer reports');
    } finally { await viewer.close(); }
});

test('V9. a page change is reported right away (no debounce), so a quick close still saves it', async () => {
    const pdf = await threePages();
    const host = createHost(pdf.bytes);
    const viewer = await openViewer({ pdfBytes: pdf.bytes, server, onMessage: host.onMessage });
    try {
        await waitForStored(viewer, host);
        await scrollPageIntoView(viewer.page, 3, 792);
        await viewer.page.waitForFunction(() => PDFViewerApplication.page === 3, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(host.viewState?.page, 3, 'reported within ~100 ms of the page change');
    } finally { await viewer.close(); }
});
