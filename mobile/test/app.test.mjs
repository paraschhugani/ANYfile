// The app's web side (library, PDF viewer bridge, host, writer) in headless Chrome as an iPhone (touch,
// 390x844), with the native plugin replaced by a fake whose files live in this Node process.
// Run: npm test (from mobile/). Screenshots go to test/output/.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { makeTextPdf, pdfLib } from '../../test/pdf-highlight/harness.mjs';
import {
    FakeNative, OUTPUT, goToPage, highlightAnnotations, openApp, startHarness, stopHarness, storedView,
    tapBack, tapHighlightButton, touchSelect, waitForCommits, waitForViewer,
} from './harness.mjs';

const KEY = 'ANYfileLastView';

before(startHarness);
after(stopHarness);

/* ------------------------------------------------------------------ tests */

test('M1. the library lists PDFs (most recent first) and opens one in the viewer', async () => {
    const fake = new FakeNative();
    const pdf = await makeTextPdf({ pages: [{}, {}, {}], withId: true });
    fake.add('Older.pdf', pdf.bytes, { lastOpened: 5000, lastPage: 2, pageCount: 3 });
    const id = fake.add('Newer.pdf', pdf.bytes, { lastOpened: Date.now() - 3 * 3600 * 1000 });
    const app = await openApp(fake);
    try {
        await app.page.waitForSelector('.file-name');
        const rows = await app.page.$$eval('.file-row', rows => rows.map(row => ({
            name: row.querySelector('.file-name').textContent,
            meta: row.querySelector('.file-meta').textContent,
        })));
        assert.deepEqual(rows.map(row => row.name), ['Newer', 'Older']);
        assert.match(rows[0].meta, /^iCloud Drive · 3 hours ago$/);
        assert.match(rows[1].meta, /Page 2 of 3/);
        await app.page.screenshot({ path: join(OUTPUT, 'library.png') });
        const box = await (await app.page.$('.file')).boundingBox();
        await Promise.all([app.page.waitForNavigation({ waitUntil: 'load' }), app.page.touchscreen.tap(box.x + 40, box.y + 20)]);
        assert.match(app.page.url(), new RegExp(`viewer\\.html\\?id=${id}$`));
        await waitForViewer(app.page, 3);
        await app.page.screenshot({ path: join(OUTPUT, 'viewer.png') });
        assert.deepEqual(app.errors, []);
    } finally {
        await app.close();
    }
});

test('M2. going back to the library saves the page into the PDF; the library shows it', async () => {
    const fake = new FakeNative();
    const id = fake.add('Book.pdf', (await makeTextPdf({ pages: [{}, {}, {}, {}, {}], withId: true })).bytes);
    const app = await openApp(fake, { path: `pdf/viewer.html?id=${id}` });
    try {
        await waitForViewer(app.page, 5);
        assert.equal(fake.commits, 0, 'opening writes nothing');
        await goToPage(app.page, 3);
        await tapBack(app.page);
        const view = await storedView(fake.bytes(id));
        assert.equal(view.page, 3);
        assert.ok(view.t > Date.now() - 60000, 'save time stored');
        await app.page.waitForSelector('.file-meta');
        assert.match(await app.page.$eval('.file-meta', node => node.textContent), /Page 3 of 5/);
        assert.deepEqual(app.errors, []);
    } finally {
        await app.close();
    }
});

test('M3. a position saved by another device (e.g. VS Code on the Mac) opens at that page', async () => {
    const fake = new FakeNative();
    const pdf = await makeTextPdf({ pages: [{}, {}, {}, {}], withId: true });
    const doc = await pdfLib.PDFDocument.load(pdf.bytes, { updateMetadata: false });
    doc.setTitle('Book');
    doc.getInfoDict().set(pdfLib.PDFName.of(KEY), pdfLib.PDFString.of(JSON.stringify({ v: 1, page: 3, t: Date.now() })));
    const id = fake.add('Book.pdf', await doc.save());
    const app = await openApp(fake, { path: `pdf/viewer.html?id=${id}` });
    try {
        await waitForViewer(app.page, 4);
        assert.equal(await app.page.evaluate(() => window.PDFViewerApplication.page), 3);
        await tapBack(app.page);
        assert.equal(fake.commits, 0, 'unchanged position: not written again');
    } finally {
        await app.close();
    }
});

test('M4. touch: selecting text shows a Highlight button; tapping it saves a highlight into the PDF', async () => {
    const fake = new FakeNative();
    const id = fake.add('Notes.pdf', (await makeTextPdf({ pages: [{}, {}], withId: true })).bytes);
    const app = await openApp(fake, { path: `pdf/viewer.html?id=${id}` });
    try {
        await waitForViewer(app.page, 2);
        await touchSelect(app.page, 1, 'quick brown fox');
        await app.page.waitForSelector('.office-hl-select-button:not([hidden])', { timeout: 5000 });
        assert.equal(fake.commits, 0, 'a touch selection alone does not highlight (its handles can still move)');
        await app.page.screenshot({ path: join(OUTPUT, 'touch-select.png') });
        await tapHighlightButton(app.page);
        await app.page.waitForFunction(() => document.querySelector('.office-hl-layer > *'), { timeout: 5000 });
        await waitForCommits(app.page, fake, 1);
        const annotations = await highlightAnnotations(fake.bytes(id));
        assert.equal(annotations.length, 1);
        assert.equal(annotations[0].pageIndex, 0);
        assert.equal(await app.page.evaluate(() => document.getSelection().isCollapsed), true, 'selection cleared');
        assert.equal(await app.page.$eval('.office-hl-select-button', node => node.hidden), true, 'button hidden');
        await app.page.screenshot({ path: join(OUTPUT, 'touch-highlighted.png') });
        assert.deepEqual(app.errors, []);
    } finally {
        await app.close();
    }
});

test('M5. a save that races another device re-reads the file and keeps both changes', async () => {
    const fake = new FakeNative();
    const id = fake.add('Shared.pdf', (await makeTextPdf({ pages: [{}, {}], withId: true })).bytes);
    let raced = false;
    fake.onCommit = async (fileId) => {
        if (raced) {
            return;
        }
        raced = true;
        // Meanwhile on the Mac: something else is saved into the same PDF.
        const doc = await pdfLib.PDFDocument.load(fake.bytes(fileId), { updateMetadata: false });
        doc.setTitle('Changed on the Mac');
        fake.replace(fileId, await doc.save());
    };
    const app = await openApp(fake, { path: `pdf/viewer.html?id=${id}` });
    try {
        await waitForViewer(app.page, 2);
        await touchSelect(app.page, 1, 'lazy dog');
        await tapHighlightButton(app.page);
        await app.page.waitForFunction(() => document.querySelector('.office-hl-layer > *'), { timeout: 5000 });
        await waitForCommits(app.page, fake, 2);
        assert.equal(fake.conflicts, 1, 'the first write was refused');
        const doc = await pdfLib.PDFDocument.load(fake.bytes(id), { updateMetadata: false });
        assert.equal(doc.getTitle(), 'Changed on the Mac', "the other device's change survived");
        assert.equal((await highlightAnnotations(fake.bytes(id))).length, 1, 'and the highlight was saved');
        assert.equal(await app.page.$('.office-hl-toast.visible'), null, 'no error shown');
    } finally {
        await app.close();
    }
});

test('M6. leaving the app (home screen, app switcher) saves the page and ends the background task', async () => {
    const fake = new FakeNative();
    const id = fake.add('Book.pdf', (await makeTextPdf({ pages: [{}, {}, {}], withId: true })).bytes);
    const app = await openApp(fake, { path: `pdf/viewer.html?id=${id}` });
    try {
        await waitForViewer(app.page, 3);
        await goToPage(app.page, 2);
        await app.page.evaluate(() => window.__anyfileEmit('willResignActive'));
        await app.page.waitForFunction(() => true);
        for (let i = 0; i < 50 && fake.endedBackgroundTasks === 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(fake.endedBackgroundTasks, 1);
        assert.equal((await storedView(fake.bytes(id))).page, 2);
        assert.equal(fake.files.get(id).lastPage, 2);
    } finally {
        await app.close();
    }
});

test('M7. a position the app could not save (closed by iOS) is written next launch, unless the file has a newer one', async () => {
    const fake = new FakeNative();
    const pdf = await makeTextPdf({ pages: [{}, {}, {}], withId: true });
    const plain = fake.add('Plain.pdf', pdf.bytes);
    const doc = await pdfLib.PDFDocument.load(pdf.bytes, { updateMetadata: false });
    doc.getInfoDict().set(pdfLib.PDFName.of(KEY), pdfLib.PDFString.of(JSON.stringify({ v: 1, page: 1, t: 9_000 })));
    const newer = fake.add('Newer elsewhere.pdf', await doc.save());
    const pending = {
        [plain]: { state: { page: 3, left: 0, top: 792, t: 5_000 }, fingerprint: null },
        [newer]: { state: { page: 2, left: 0, top: 792, t: 5_000 }, fingerprint: null },
    };
    const app = await openApp(fake, { storage: { 'anyfile.pendingView': JSON.stringify(pending) } });
    try {
        await app.page.waitForFunction(() => localStorage.getItem('anyfile.pendingView') === '{}', { timeout: 10000 });
        assert.equal((await storedView(fake.bytes(plain))).page, 3, 'written');
        assert.equal((await storedView(fake.bytes(plain))).t, 5_000, 'with the time the reader was there');
        assert.equal((await storedView(fake.bytes(newer))).page, 1, 'a newer position from another device is kept');
    } finally {
        await app.close();
    }
});

test('M8. a read-only PDF opens, but highlighting is off and nothing is written', async () => {
    const fake = new FakeNative();
    const id = fake.add('Locked.pdf', (await makeTextPdf({ pages: [{}, {}, {}, {}, {}], withId: true })).bytes, { writable: false });
    const app = await openApp(fake, { path: `pdf/viewer.html?id=${id}` });
    try {
        await waitForViewer(app.page, 5);
        assert.match(await app.page.$eval('#highlightModeToggle', node => node.title), /read-only/);
        await touchSelect(app.page, 1, 'quick brown fox');
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(await app.page.$('.office-hl-select-button:not([hidden])'), null, 'no Highlight button');
        await goToPage(app.page, 3);
        await tapBack(app.page);
        assert.equal(fake.commits, 0);
    } finally {
        await app.close();
    }
});

test('M9. a PDF opened from another app ("Open in ANYfile") goes straight to the viewer', async () => {
    const fake = new FakeNative();
    const id = fake.add('Shared.pdf', (await makeTextPdf({ pages: [{}, {}], withId: true })).bytes);
    fake.opened = id;
    const app = await openApp(fake);
    try {
        await app.page.waitForFunction((fileId) => location.href.endsWith(`viewer.html?id=${fileId}`), { timeout: 10000 }, id);
        await waitForViewer(app.page, 2);
    } finally {
        await app.close();
    }
});

test('M10. a file that is gone shows an error with a way back', async () => {
    const fake = new FakeNative();
    const app = await openApp(fake, { path: 'pdf/viewer.html?id=missing', dark: true });
    try {
        await app.page.waitForSelector('#anyfileError:not([hidden])', { timeout: 10000 });
        assert.match(await app.page.$eval('#anyfileErrorText', node => node.textContent), /no longer in your library/);
        await app.page.screenshot({ path: join(OUTPUT, 'error-dark.png') });
    } finally {
        await app.close();
    }
});
