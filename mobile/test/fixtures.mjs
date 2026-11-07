// Small sample files for each format the app opens, generated in Node.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from '../../test/pdf-highlight/harness.mjs';

const rootRequire = createRequire(join(REPO_ROOT, 'package.json'));
const mobileRequire = createRequire(import.meta.url);
const XLSX = rootRequire('xlsx');
const JSZip = rootRequire('jszip');

export const SHEET_ROWS = [
    ['Name', 'City', 'Score'],
    ['Ada', 'London', 91],
    ['Grace', 'New York', 87],
    ['Linus', 'Helsinki', 78],
];

function workbook() {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(SHEET_ROWS), 'People');
    return book;
}

export function makeXlsx() {
    return new Uint8Array(XLSX.write(workbook(), { type: 'buffer', bookType: 'xlsx' }));
}

export function makeXls() {
    return new Uint8Array(XLSX.write(workbook(), { type: 'buffer', bookType: 'biff8' }));
}

export function makeCsv() {
    return new TextEncoder().encode(SHEET_ROWS.map(row => row.join(',')).join('\n') + '\n');
}

export const WORD_PARAGRAPHS = ['ANYfile Word sample', 'The quick brown fox jumps over the lazy dog.', 'Second paragraph of the document.'];

export async function makeDocx() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
    const body = WORD_PARAGRAPHS.map(text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`);
    return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

export async function makePptx() {
    const PptxGenJS = mobileRequire('pptxgenjs');
    const deck = new PptxGenJS();
    for (const title of ['ANYfile slides', 'Second slide', 'Third slide']) {
        deck.addSlide().addText(title, { x: 0.5, y: 0.5, w: 9, h: 1.5, fontSize: 36, color: '1F2937' });
    }
    return new Uint8Array(await deck.write({ outputType: 'nodebuffer' }));
}

export async function makeEpub() {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
    zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">anyfile-sample</dc:identifier><dc:title>ANYfile Book</dc:title><dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`);
    zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li><li><a href="c2.xhtml">Chapter Two</a></li></ol></nav></body></html>`);
    for (const [file, title] of [['c1.xhtml', 'Chapter One'], ['c2.xhtml', 'Chapter Two']]) {
        const paragraphs = Array.from({ length: 30 }, (_, i) => `<p>${title}, paragraph ${i + 1}. The quick brown fox jumps over the lazy dog.</p>`).join('');
        zip.file(`OEBPS/${file}`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1>${paragraphs}</body></html>`);
    }
    return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' }));
}

export async function makeTtf() {
    return new Uint8Array(await readFile(join(REPO_ROOT, 'resource/pdf/standard_fonts/LiberationSans-Regular.ttf')));
}

export async function makeWoff2() {
    return new Uint8Array(await readFile(join(REPO_ROOT, 'resource/markdown/dist/js/katex/fonts/KaTeX_Main-Regular.woff2')));
}

export async function makeParquet() {
    const { parquetWriteBuffer } = await import(join(REPO_ROOT, 'node_modules/hyparquet-writer/src/index.js'));
    const buffer = parquetWriteBuffer({
        columnData: [
            { name: 'name', data: ['Ada', 'Grace', 'Linus'], type: 'STRING' },
            { name: 'score', data: [91, 87, 78], type: 'INT32' },
        ],
    });
    return new Uint8Array(buffer);
}
