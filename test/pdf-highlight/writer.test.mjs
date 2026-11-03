// Self-test for src/provider/handlers/pdfHighlightWriter.ts.
// Run: node --test test/pdf-highlight/writer.test.mjs
// Bundles the writer with esbuild (pdf-lib external), builds fixture PDFs with pdf-lib, and checks the
// output with pdf-lib, PDF.js 3.1.81 (resource/pdf, in Node), and optionally PyMuPDF and headless Chrome.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire, Module } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const {
    PDFDocument, StandardFonts, PDFName, PDFArray, PDFDict, PDFString, PDFHexString, PDFRef, degrees, decodePDFRawStream,
} = require('pdf-lib');
const pdfjs = require(path.join(repo, 'resource/pdf/pdf.js'));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(repo, 'resource/pdf/pdf.worker.js');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const YELLOW = [1, 1, 0];
const GREEN = [0.4, 0.9, 0.4];
const BLUE = [0.5, 0.75, 1];
const tempDir = mkdtempSync(path.join(tmpdir(), 'vso-pdf-highlight-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));

// ---------------------------------------------------------------- writer bundle

async function bundleWriter() {
    const result = await build({
        entryPoints: [path.join(repo, 'src/provider/handlers/pdfHighlightWriter.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['pdf-lib'],
        write: false,
        logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const filename = path.join(here, 'pdfHighlightWriter.bundle.cjs');
    const mod = new Module(filename);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(here);
    mod._compile(code, filename);
    return { code, writer: mod.exports };
}
const { code: bundleCode, writer } = await bundleWriter();

// ---------------------------------------------------------------- helpers

const LINES = [
    { text: 'The quick brown fox jumps over the lazy dog.', x: 72, y: 700 },
    { text: 'Second line of text that gets highlighted.', x: 72, y: 670 },
    { text: 'Third line, highlighted in another color.', x: 72, y: 640 },
];
const ROTATED_LINE = { text: 'Text on a page rotated by 90 degrees.', x: 72, y: 500 };
const SIZE = 18;

/** Acrobat quad order: xLeft,yTop, xRight,yTop, xLeft,yBottom, xRight,yBottom */
function lineQuad(font, line) {
    const width = font.widthOfTextAtSize(line.text, SIZE);
    const top = line.y + SIZE * 0.78;
    const bottom = line.y - SIZE * 0.24;
    return [line.x, top, line.x + width, top, line.x, bottom, line.x + width, bottom];
}

function bboxOf(quadPoints) {
    const xs = quadPoints.filter((_, i) => i % 2 === 0);
    const ys = quadPoints.filter((_, i) => i % 2 === 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

let cachedFont;
async function makeTextPdf({ id, header14 = false, useObjectStreams = true, mutate } = {}) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    cachedFont = font;
    const page1 = doc.addPage([612, 792]);
    for (const line of LINES) {
        page1.drawText(line.text, { x: line.x, y: line.y, size: SIZE, font });
    }
    const page2 = doc.addPage([612, 792]);
    page2.setRotation(degrees(90));
    page2.drawText(ROTATED_LINE.text, { x: ROTATED_LINE.x, y: ROTATED_LINE.y, size: SIZE, font });
    if (id) {
        doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id[0]), PDFHexString.of(id[1])]);
    }
    if (mutate) {
        await mutate(doc);
    }
    const bytes = await doc.save({ useObjectStreams });
    if (header14) {
        const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
        assert.equal(head, '%PDF-1.7');
        bytes.set(Buffer.from('%PDF-1.4', 'latin1'), 0);
    }
    return bytes;
}

async function pdfjsInfo(bytes) {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        pages.push({ rotate: page.rotate, annotations: await page.getAnnotations() });
    }
    const fingerprints = pdf.fingerprints;
    await pdf.destroy();
    return { fingerprints, pages };
}

async function loadAnnots(bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = doc.getPages().map(page => {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) {
            return [];
        }
        return annots.asArray().map(entry => ({ entry, dict: doc.context.lookup(entry) }));
    });
    return { doc, pages };
}

const nm = dict => dict.get(PDFName.of('NM'))?.decodeText();
const numbers = (dict, key) => dict.lookup(PDFName.of(key), PDFArray).asArray().map(n => n.asNumber());
const latin1 = bytes => Buffer.from(bytes).toString('latin1');

function trailerId(doc) {
    const id = doc.context.lookup(doc.context.trailerInfo.ID);
    if (!(id instanceof PDFArray)) {
        return undefined;
    }
    return id.asArray().map(item => (item instanceof PDFHexString ? item.asString().toLowerCase() : Buffer.from(item.asBytes()).toString('hex')));
}

async function expectRejectCode(promise, code) {
    await assert.rejects(promise, error => {
        assert.equal(error.name, 'PdfHighlightError');
        assert.equal(error.code, code);
        return true;
    });
}

// ---------------------------------------------------------------- shared fixture: add A (2 quads), B (rotated page), C

const ids = { A: 'vso-hl-aaaa1', B: 'vso-hl-bbbb2', C: 'vso-hl-cccc3' };
let addResults;
const original = await makeTextPdf();
const originalFingerprint = (await pdfjsInfo(original)).fingerprints[0];
const quads = {
    A: [...lineQuad(cachedFont, LINES[0]), ...lineQuad(cachedFont, LINES[1])],
    B: lineQuad(cachedFont, ROTATED_LINE),
    C: lineQuad(cachedFont, LINES[2]),
};
const added = await writer.applyPdfHighlightOps(original, [
    { type: 'add', id: ids.A, pageIndex: 0, quadPoints: quads.A, rect: bboxOf(quads.A), color: YELLOW, text: 'x', fingerprint: originalFingerprint },
    { type: 'add', id: ids.B, pageIndex: 1, quadPoints: quads.B, rect: bboxOf(quads.B), color: GREEN, text: 'y', fingerprint: originalFingerprint },
    { type: 'add', id: ids.C, pageIndex: 0, quadPoints: quads.C, rect: bboxOf(quads.C), color: BLUE, text: 'z', fingerprint: originalFingerprint },
], {
    now: new Date(Date.UTC(2026, 10, 3, 12, 34, 56)),
    onResults: results => { addResults = results; },
});

// ---------------------------------------------------------------- tests

test('bundle has no vscode dependency and requires pdf-lib lazily', () => {
    assert.ok(!/require\(["']vscode["']\)/.test(bundleCode), 'writer must not import vscode');
    assert.ok(/require\(["']pdf-lib["']\)/.test(bundleCode));
    assert.equal(writer.isPdfLibAvailable(), true);
});

test('helpers: ref parsing, fingerprint normalization, rect padding', () => {
    assert.deepEqual(writer.parseAnnotationRef('12R'), { objectNumber: 12, generationNumber: 0 });
    assert.deepEqual(writer.parseAnnotationRef('7R3'), { objectNumber: 7, generationNumber: 3 });
    assert.equal(writer.parseAnnotationRef('annot_p0_1'), null);
    assert.equal(writer.parseAnnotationRef(undefined), null);
    assert.equal(writer.normalizeFingerprint('ABCDEF0123456789abcdef0123456789'), 'abcdef0123456789abcdef0123456789');
    assert.equal(writer.normalizeFingerprint('00000000000000000000000000000000'), null);
    assert.equal(writer.normalizeFingerprint('xyz'), null);
    assert.equal(writer.normalizeFingerprint(null), null);
    const rect = writer.computeHighlightRect([10.0004, 20.9996, 30, 21, 10, 5, 30, 5]);
    assert.ok(rect[0] < 10 && rect[1] < 5 && rect[2] > 30 && rect[3] > 21);
});

test('computeFallbackFingerprint matches PDF.js for a file without /ID (including files < 1024 bytes)', async () => {
    assert.equal(writer.computeFallbackFingerprint(original), originalFingerprint);
    const tiny = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    assert.ok(tiny.length < 1024);
    assert.equal(writer.computeFallbackFingerprint(tiny), (await pdfjsInfo(tiny)).fingerprints[0]);
});

test('add: annotation dicts are standard /Highlight annotations', async () => {
    assert.deepEqual(addResults.map(r => [r.ok, r.changed]), [[true, true], [true, true], [true, true]]);
    const { doc, pages } = await loadAnnots(added);
    assert.equal(pages[0].length, 2);
    assert.equal(pages[1].length, 1);
    const expected = { [ids.A]: [0, quads.A, YELLOW], [ids.B]: [1, quads.B, GREEN], [ids.C]: [0, quads.C, BLUE] };
    for (const [pageIndex, annots] of pages.entries()) {
        for (const { entry, dict } of annots) {
            assert.ok(entry instanceof PDFRef, 'annotation is an indirect object');
            const id = nm(dict);
            const [expectedPage, expectedQuads, expectedColor] = expected[id];
            assert.equal(pageIndex, expectedPage);
            assert.equal(dict.lookup(PDFName.of('Type')), PDFName.of('Annot'));
            assert.equal(dict.lookup(PDFName.of('Subtype')), PDFName.of('Highlight'));
            const qp = numbers(dict, 'QuadPoints');
            assert.equal(qp.length, expectedQuads.length);
            qp.forEach((value, i) => assert.ok(Math.abs(value - expectedQuads[i]) < 0.001));
            const rect = numbers(dict, 'Rect');
            for (let i = 0; i < qp.length; i += 2) {
                assert.ok(qp[i] > rect[0] && qp[i] < rect[2] && qp[i + 1] > rect[1] && qp[i + 1] < rect[3], `quad point inside Rect for ${id}`);
            }
            assert.deepEqual(numbers(dict, 'C'), expectedColor);
            assert.equal(dict.lookup(PDFName.of('F')).asNumber(), 4);
            assert.equal(dict.get(PDFName.of('P')), doc.getPage(pageIndex).ref);
            assert.equal(dict.lookup(PDFName.of('M')).decodeText(), 'D:20261103123456Z');
            assert.equal(dict.lookup(PDFName.of('CreationDate')).decodeText(), 'D:20261103123456Z');
            for (const key of ['T', 'Contents', 'Popup', 'RC']) {
                assert.equal(dict.has(PDFName.of(key)), false, `${id} must not have /${key}`);
            }
            const ap = dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
            assert.deepEqual(numbers(ap.dict, 'BBox'), rect);
            assert.equal(ap.dict.lookup(PDFName.of('Subtype')), PDFName.of('Form'));
            const gs = ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('GS0'), PDFDict);
            assert.equal(gs.lookup(PDFName.of('BM')), PDFName.of('Multiply'));
            const content = latin1(decodePDFRawStream(ap).decode());
            assert.match(content, /^\/GS0 gs\n/);
            assert.ok(content.includes(`${expectedColor.join(' ')} rg`));
            assert.equal((content.match(/ re$/gm) ?? []).length, expectedQuads.length / 8);
            assert.match(content, /\nf\n$/);
        }
    }
});

test('add: missing /ID becomes [fp fp] so the PDF.js fingerprint (view history key) is preserved', async () => {
    const before = await PDFDocument.load(original, { updateMetadata: false });
    assert.equal(before.context.trailerInfo.ID, undefined);
    const { doc } = await loadAnnots(added);
    assert.deepEqual(trailerId(doc), [originalFingerprint, originalFingerprint]);
    assert.ok(latin1(added).startsWith('%PDF-1.7'));
    // pdf-lib writes /ID before /Type /XRef in the xref stream dict
    assert.match(latin1(added), /\d+ 0 obj\n<<[^>]*?\/ID \[ <[0-9a-f]{32}> <[0-9a-f]{32}> \][^>]*?\/Type \/XRef/i, 'object-stream path writes /ID in the xref stream dict');
    const info = await pdfjsInfo(added);
    assert.equal(info.fingerprints[0], originalFingerprint);
});

test('PDF.js getAnnotations reports subtype Highlight with quadPoints and is not rendered as a DOM element', async () => {
    const info = await pdfjsInfo(added);
    assert.equal(info.pages[1].rotate, 90);
    const all = info.pages.flatMap((page, pageIndex) => page.annotations.map(a => ({ ...a, pageIndex })));
    assert.equal(all.length, 3);
    for (const annotation of all) {
        assert.equal(annotation.subtype, 'Highlight');
        assert.match(annotation.id, /^\d+R$/);
        assert.equal(annotation.hasAppearance, true);
        assert.ok(Array.isArray(annotation.quadPoints));
        for (const quad of annotation.quadPoints) {
            assert.equal(quad.length, 4);
            for (const point of quad) {
                assert.equal(typeof point.x, 'number');
                assert.equal(typeof point.y, 'number');
            }
        }
        // HighlightAnnotationElement.isRenderable (pdf.js 3.1.81) is false -> no <section> over the text layer.
        const renderable = !!(annotation.hasPopup || annotation.titleObj?.str || annotation.contentsObj?.str || annotation.richText?.str);
        assert.equal(renderable, false);
    }
    const a = all.find(x => x.pageIndex === 0 && x.quadPoints.length === 2);
    assert.ok(a, 'highlight A has two quads');
    const [line1] = a.quadPoints;
    assert.ok(Math.abs(line1[0].x - quads.A[0]) < 0.001 && Math.abs(line1[0].y - quads.A[1]) < 0.001);
});

let removed;
let removeResults;
let refB;
test('remove: by /NM (session highlight) and by PDF.js ref (file highlight)', async () => {
    const info = await pdfjsInfo(added);
    refB = info.pages[1].annotations[0].id;
    const { doc: before, pages: beforePages } = await loadAnnots(added);
    const annotA = beforePages[0].find(x => nm(x.dict) === ids.A);
    const apA = annotA.dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'));
    const annotB = beforePages[1][0].entry;
    assert.equal(annotB.toString(), `${refB.replace('R', '')} 0 R`);

    removed = await writer.applyPdfHighlightOps(added, [
        { type: 'remove', id: ids.A, pageIndex: 0, fingerprint: originalFingerprint },
        { type: 'remove', ref: refB, pageIndex: 1, fingerprint: originalFingerprint },
    ], { onResults: results => { removeResults = results; } });
    assert.deepEqual(removeResults.map(r => [r.ok, r.changed, !!r.removedRef]), [[true, true, false], [true, true, true]]);

    const { doc, pages } = await loadAnnots(removed);
    assert.deepEqual(pages[0].map(x => nm(x.dict)), [ids.C]);
    assert.equal(pages[1].length, 0);
    assert.equal(doc.context.lookup(annotA.entry), undefined, 'removed annotation object deleted');
    assert.equal(doc.context.lookup(apA), undefined, 'own appearance stream deleted');
    assert.equal(doc.context.lookup(annotB), undefined);
    assert.ok(before.context.lookup(annotB));
    // Existing /ID (written by the previous save) is kept as is.
    assert.deepEqual(trailerId(doc), [originalFingerprint, originalFingerprint]);
    const after = await pdfjsInfo(removed);
    assert.equal(after.fingerprints[0], originalFingerprint);
    assert.deepEqual(after.pages.map(p => p.annotations.map(a => a.subtype)), [['Highlight'], []]);
});

test('remove by id of a highlight never written is a no-op; unknown ref is an error', async () => {
    const results = [];
    const doc = await writer.PdfHighlightDocument.load(removed);
    results.push(...doc.apply([
        { type: 'remove', id: 'vso-hl-neverwritten', pageIndex: 0 },
        { type: 'remove', ref: '9999R', pageIndex: 0 },
        { type: 'remove', ref: 'annot_p0_1', pageIndex: 0 },
        { type: 'remove', pageIndex: 0 },
    ]));
    assert.deepEqual(results.map(r => [r.ok, r.changed]), [[true, false], [false, false], [false, false], [false, false]]);
    assert.match(results[1].error, /not found/);
});

test('existing /ID is never changed', async () => {
    const idPair = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'];
    const source = await makeTextPdf({ id: idPair });
    const beforeInfo = await pdfjsInfo(source);
    assert.deepEqual(beforeInfo.fingerprints, idPair);
    const out = await writer.applyPdfHighlightOps(source, [
        { type: 'add', id: 'vso-hl-id1', pageIndex: 0, quadPoints: quads.C, color: YELLOW, fingerprint: 'ffffffffffffffffffffffffffffffff' },
    ]);
    const { doc } = await loadAnnots(out);
    assert.deepEqual(trailerId(doc), idPair);
    assert.deepEqual((await pdfjsInfo(out)).fingerprints, idPair);
});

test('classic xref path (PDF 1.4 header) keeps the fingerprint via trailer /ID', async () => {
    const source = await makeTextPdf({ header14: true, useObjectStreams: false });
    const fp = (await pdfjsInfo(source)).fingerprints[0];
    const out = await writer.applyPdfHighlightOps(source, [
        { type: 'add', id: 'vso-hl-classic', pageIndex: 1, quadPoints: quads.B, color: YELLOW, fingerprint: fp },
    ]);
    const text = latin1(out);
    // pdf-lib always writes a %PDF-1.7 header; a classic xref table is still valid there
    assert.ok(text.startsWith('%PDF-1.7'));
    assert.ok(!/\/Type \/XRef/.test(text), 'no xref stream');
    assert.match(text, /\nxref\n0 \d+\n/);
    assert.match(text, /trailer\n<<[\s\S]*?\/ID \[ <[0-9a-f]{32}> <[0-9a-f]{32}> \][\s\S]*?>>/i);
    const info = await pdfjsInfo(out);
    assert.equal(info.fingerprints[0], fp);
    assert.equal(info.pages[1].annotations[0].subtype, 'Highlight');
});

test('no fingerprint supplied: falls back to the MD5 PDF.js computed for the original file', async () => {
    const out = await writer.applyPdfHighlightOps(original, [
        { type: 'add', id: 'vso-hl-nofp', pageIndex: 0, quadPoints: quads.C, color: YELLOW, fingerprint: null },
    ]);
    assert.equal((await pdfjsInfo(out)).fingerprints[0], originalFingerprint);
});

test('encrypted PDF is refused', async (t) => {
    const plainPath = path.join(tempDir, 'plain.pdf');
    writeFileSync(plainPath, original);
    const variants = [];
    const python = spawnSync('python3', ['-I', '-c', [
        'import sys, fitz',
        'doc = fitz.open(sys.argv[1])',
        'doc.save(sys.argv[2], encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner-secret", user_pw="", permissions=fitz.PDF_PERM_PRINT | fitz.PDF_PERM_COPY)',
        'doc.save(sys.argv[3], encryption=fitz.PDF_ENCRYPT_RC4_128, owner_pw="owner-secret", user_pw="", permissions=fitz.PDF_PERM_PRINT)',
    ].join('\n'), plainPath, path.join(tempDir, 'aes256.pdf'), path.join(tempDir, 'rc4.pdf')], { encoding: 'utf8' });
    if (python.status === 0) {
        variants.push(['PyMuPDF AES-256', readFileSync(path.join(tempDir, 'aes256.pdf'))]);
        variants.push(['PyMuPDF RC4-128', readFileSync(path.join(tempDir, 'rc4.pdf'))]);
    } else {
        t.diagnostic(`PyMuPDF unavailable (${python.stderr?.trim().split('\n').pop()}); using a synthetic /Encrypt trailer only`);
    }
    const synthetic = await makeTextPdf({
        useObjectStreams: false,
        mutate: doc => {
            doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }));
        },
    });
    variants.push(['synthetic /Encrypt', synthetic]);
    for (const [label, bytes] of variants) {
        if (label.startsWith('PyMuPDF')) {
            const info = await pdfjsInfo(bytes);
            assert.equal(info.pages.length, 2, `${label} opens in PDF.js (empty user password)`);
        }
        await expectRejectCode(writer.PdfHighlightDocument.load(bytes), 'encrypted');
        await expectRejectCode(writer.applyPdfHighlightOps(bytes, [
            { type: 'add', id: 'vso-hl-enc', pageIndex: 0, quadPoints: quads.C, color: YELLOW },
        ]), 'encrypted');
        t.diagnostic(`refused: ${label}`);
    }
});

async function makeSignedPdf({ withValue, inherited }) {
    return makeTextPdf({
        mutate: doc => {
            const ctx = doc.context;
            const sigValue = ctx.register(ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached' }));
            const widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: doc.getPage(0).ref });
            let fieldRef;
            if (inherited) {
                const parent = ctx.obj({ FT: 'Sig', T: PDFString.of('Signature1') });
                const parentRef = ctx.register(parent);
                if (withValue) {
                    widget.set(PDFName.of('V'), sigValue);
                }
                widget.set(PDFName.of('Parent'), parentRef);
                const widgetRef = ctx.register(widget);
                parent.set(PDFName.of('Kids'), ctx.obj([widgetRef]));
                doc.getPage(0).node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
                fieldRef = parentRef;
            } else {
                widget.set(PDFName.of('FT'), PDFName.of('Sig'));
                widget.set(PDFName.of('T'), PDFString.of('Signature1'));
                if (withValue) {
                    widget.set(PDFName.of('V'), sigValue);
                }
                fieldRef = ctx.register(widget);
                doc.getPage(0).node.set(PDFName.of('Annots'), ctx.obj([fieldRef]));
            }
            doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [fieldRef], SigFlags: 3 }));
        },
    });
}

test('digitally signed PDF is detected; save needs allowSigned', async () => {
    const op = { type: 'add', id: 'vso-hl-sig', pageIndex: 0, quadPoints: quads.C, color: YELLOW };
    const signed = await makeSignedPdf({ withValue: true, inherited: false });
    assert.equal((await writer.PdfHighlightDocument.load(signed)).signed, true);
    await expectRejectCode(writer.applyPdfHighlightOps(signed, [op]), 'signed');
    const out = await writer.applyPdfHighlightOps(signed, [op], { allowSigned: true });
    assert.equal((await pdfjsInfo(out)).pages[0].annotations.filter(a => a.subtype === 'Highlight').length, 1);

    const inheritedSigned = await makeSignedPdf({ withValue: true, inherited: true });
    assert.equal((await writer.PdfHighlightDocument.load(inheritedSigned)).signed, true, 'FT inherited from parent field');

    const emptySigField = await makeSignedPdf({ withValue: false, inherited: false });
    assert.equal((await writer.PdfHighlightDocument.load(emptySigField)).signed, false, 'unsigned signature field');
    assert.equal((await writer.PdfHighlightDocument.load(original)).signed, false);
});

test('removing a third-party highlight by ref also removes its /Popup; non-highlights are refused', async () => {
    const source = await makeTextPdf({
        mutate: doc => {
            const ctx = doc.context;
            const page = doc.getPage(0);
            const q = quads.A.slice(0, 8);
            const popup = ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 560, 450, 620], Open: false });
            const popupRef = ctx.register(popup);
            const highlight = ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: bboxOf(q), QuadPoints: q, C: [1, 1, 0], F: 4, Popup: popupRef, P: page.ref });
            highlight.set(PDFName.of('T'), PDFString.of('Alice'));
            highlight.set(PDFName.of('Contents'), PDFString.of('A comment'));
            const highlightRef = ctx.register(highlight);
            popup.set(PDFName.of('Parent'), highlightRef);
            const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 20, 40, 40], F: 4 });
            note.set(PDFName.of('Contents'), PDFString.of('sticky note'));
            const noteRef = ctx.register(note);
            // Annots as an indirect array.
            page.node.set(PDFName.of('Annots'), ctx.register(ctx.obj([highlightRef, popupRef, noteRef])));
        },
    });
    const info = await pdfjsInfo(source);
    const byType = Object.fromEntries(info.pages[0].annotations.map(a => [a.subtype, a.id]));
    assert.ok(byType.Highlight && byType.Popup && byType.Text);

    let results;
    const out = await writer.applyPdfHighlightOps(source, [
        { type: 'remove', ref: byType.Text, pageIndex: 0 },
        { type: 'remove', ref: byType.Highlight, pageIndex: 0 },
        { type: 'add', id: 'vso-hl-after', pageIndex: 0, quadPoints: quads.C, color: GREEN },
    ], { onResults: r => { results = r; } });
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /Only highlight/);
    assert.deepEqual([results[1].ok, results[1].removedRef], [true, true]);
    assert.equal(results[2].ok, true);

    const { doc } = await loadAnnots(out);
    const annotsRaw = doc.getPage(0).node.get(PDFName.of('Annots'));
    assert.ok(annotsRaw instanceof PDFRef, 'indirect /Annots stays indirect');
    const after = await pdfjsInfo(out);
    assert.deepEqual(after.pages[0].annotations.map(a => a.subtype).sort(), ['Highlight', 'Text']);
    assert.equal(doc.context.lookup(PDFRef.of(Number(byType.Popup.replace('R', '')), 0)), undefined, 'popup object deleted');
});

test('per-op validation, idempotent re-add, add+remove in one batch', async () => {
    const doc = await writer.PdfHighlightDocument.load(original);
    const results = doc.apply([
        { type: 'add', id: 'vso-hl-bad1', pageIndex: 5, quadPoints: quads.C },
        { type: 'add', id: 'bad id (x)', pageIndex: 0, quadPoints: quads.C },
        { type: 'add', id: 'vso-hl-bad3', pageIndex: 0, quadPoints: quads.C.slice(0, 7) },
        { type: 'add', id: 'vso-hl-bad4', pageIndex: 0, quadPoints: [...quads.C.slice(0, 7), Number.NaN] },
        { type: 'add', id: 'vso-hl-ok', pageIndex: 0, quadPoints: quads.C, color: 'not a color' },
        { type: 'add', id: 'vso-hl-ok', pageIndex: 0, quadPoints: quads.C },
        { type: 'add', id: 'vso-hl-gone', pageIndex: 0, quadPoints: quads.A },
        { type: 'remove', id: 'vso-hl-gone', pageIndex: 0 },
        { type: 'bogus' },
    ]);
    assert.deepEqual(results.map(r => [r.ok, r.changed]), [
        [false, false], [false, false], [false, false], [false, false],
        [true, true], [true, false], [true, true], [true, true], [false, false],
    ]);
    const out = await doc.save({ fingerprint: originalFingerprint });
    const { pages } = await loadAnnots(out);
    assert.deepEqual(pages[0].map(x => nm(x.dict)), ['vso-hl-ok']);
    assert.deepEqual(numbers(pages[0][0].dict, 'C'), YELLOW, 'invalid color falls back to yellow');
});

test('cross-check with MuPDF (optional)', async (t) => {
    const file = path.join(tempDir, 'added.pdf');
    writeFileSync(file, added);
    const run = spawnSync('python3', ['-I', '-c', [
        'import sys, json, fitz',
        'doc = fitz.open(sys.argv[1])',
        'out = []',
        'for page in doc:',
        '    for a in page.annots():',
        '        out.append([page.number, a.type[1], len(a.vertices or []), a.info.get("name", "")])',
        'print(json.dumps(out))',
    ].join('\n'), file], { encoding: 'utf8' });
    if (run.status !== 0) {
        t.skip('PyMuPDF not available');
        return;
    }
    const annots = JSON.parse(run.stdout);
    t.diagnostic(`MuPDF annots: ${JSON.stringify(annots)}`);
    assert.deepEqual(annots.map(a => [a[0], a[1], a[2]]).sort(), [[0, 'Highlight', 8], [0, 'Highlight', 4], [1, 'Highlight', 4]].sort());
});

test('PDF.js renders the appearance in headless Chrome (multiply over text, rotated page)', async (t) => {
    let puppeteer;
    try {
        puppeteer = require('puppeteer-core');
    } catch {
        t.skip('puppeteer-core not installed');
        return;
    }
    if (!existsSync(CHROME)) {
        t.skip('Google Chrome not found');
        return;
    }
    const pdfDir = path.join(repo, 'resource/pdf');
    let current = added;
    const html = `<!doctype html><html><body><script src="/pdf.js"></script><script>
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.js';
window.renderPage = async (pageNumber) => {
  document.body.innerHTML = '';
  const pdf = await pdfjsLib.getDocument('/test.pdf?' + Math.random()).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  document.body.appendChild(canvas);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  window.__viewport = viewport; window.__canvas = canvas;
  return pdf.fingerprints[0];
};
window.regionStats = (pdfRect, color) => {
  const r = window.__viewport.convertToViewportRectangle(pdfRect);
  const left = Math.ceil(Math.min(r[0], r[2])) + 2, right = Math.floor(Math.max(r[0], r[2])) - 2;
  const top = Math.ceil(Math.min(r[1], r[3])) + 2, bottom = Math.floor(Math.max(r[1], r[3])) - 2;
  const data = window.__canvas.getContext('2d').getImageData(left, top, right - left, bottom - top).data;
  const want = color.map(c => c * 255);
  let tinted = 0, white = 0, dark = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    n++;
    const px = [data[i], data[i + 1], data[i + 2]];
    if (px.every((v, k) => Math.abs(v - want[k]) < 20)) tinted++;
    if (px.every(v => v > 240)) white++;
    if (px[0] < 90 && px[1] < 90 && px[2] < 90) dark++;
  }
  return { n, tinted: tinted / n, white: white / n, dark: dark / n };
};
</script></body></html>`;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/' || url.pathname === '/index.html') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(html);
            return;
        }
        if (url.pathname === '/test.pdf') {
            res.writeHead(200, { 'content-type': 'application/pdf' });
            res.end(Buffer.from(current));
            return;
        }
        const file = path.join(pdfDir, path.normalize(url.pathname));
        if (!file.startsWith(pdfDir + path.sep) || !existsSync(file)) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
        const stats = async (pageNumber, quad, color) => {
            await page.evaluate(n => window.renderPage(n), pageNumber);
            return page.evaluate((rect, c) => window.regionStats(rect, c), bboxOf(quad), color);
        };
        const fp = await page.evaluate(() => window.renderPage(1));
        assert.equal(fp, originalFingerprint);
        const a1 = await stats(1, quads.A.slice(0, 8), YELLOW);
        const c = await stats(1, quads.C, BLUE);
        const b = await stats(2, quads.B, GREEN);
        t.diagnostic(`highlighted: A line1 ${JSON.stringify(a1)}, C ${JSON.stringify(c)}, B (rotated) ${JSON.stringify(b)}`);
        for (const s of [a1, c, b]) {
            assert.ok(s.tinted > 0.5, 'background inside the quad has the highlight color');
            assert.ok(s.white < 0.05, 'no untinted background left inside the quad');
            assert.ok(s.dark > 0.02, 'text stays dark (multiply blend)');
        }
        current = removed;
        const a1Removed = await stats(1, quads.A.slice(0, 8), YELLOW);
        const bRemoved = await stats(2, quads.B, GREEN);
        const cKept = await stats(1, quads.C, BLUE);
        t.diagnostic(`after removal: A line1 ${JSON.stringify(a1Removed)}, B ${JSON.stringify(bRemoved)}, C ${JSON.stringify(cKept)}`);
        assert.ok(a1Removed.white > 0.5 && a1Removed.tinted < 0.05);
        assert.ok(bRemoved.white > 0.5 && bRemoved.tinted < 0.05);
        assert.ok(cKept.tinted > 0.5);
    } finally {
        await browser.close();
        server.close();
    }
});
