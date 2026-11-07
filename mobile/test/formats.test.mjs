// The extension's React viewers (Excel, Word, PowerPoint, EPUB, fonts, Parquet) inside the app: each
// opens through react-bridge.js + OfficeHost with a fake native plugin, in headless Chrome as an iPhone.
// Run: npm test (from mobile/). Screenshots go to test/output/.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { makeTextPdf } from '../../test/pdf-highlight/harness.mjs';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness, waitUntil } from './harness.mjs';
import {
    makeCsv, makeDocx, makeEpub, makeParquet, makePptx, makeTtf, makeWoff2, makeXls, makeXlsx,
} from './fixtures.mjs';

before(startHarness);
after(stopHarness);

/** Opens `name` in its viewer and waits for `ready` (a function run in the page) to be true. */
async function openFormat(name, bytes, ready, { dark = false } = {}) {
    const fake = new FakeNative();
    const id = fake.add(name, bytes);
    const route = {
        xlsx: 'excel', xls: 'excel', csv: 'excel', docx: 'word', pptx: 'ppt', epub: 'epub', ttf: 'font', woff2: 'font', parquet: 'parquet',
    }[name.split('.').pop()];
    const app = await openApp(fake, { path: `react/index.html?id=${id}&route=${route}`, dark });
    await app.page.waitForFunction(ready, { timeout: 20000 });
    return { ...app, fake, id };
}

async function assertNoErrors(app) {
    assert.equal(await app.page.$eval('#anyfileError', node => node.hidden), true, 'no error overlay');
    assert.deepEqual(app.errors, [], 'no page errors');
}

async function barTitle(page) {
    return page.$eval('#anyfileBarTitle', node => node.textContent);
}

test('F1. Excel (.xlsx) opens read-only in the spreadsheet viewer', async () => {
    const app = await openFormat('Scores.xlsx', makeXlsx(), () => !!document.querySelector('.x-spreadsheet canvas'));
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(await barTitle(app.page), 'Scores.xlsx');
        await assertNoErrors(app);
        await app.page.screenshot({ path: join(OUTPUT, 'format-xlsx.png') });
    } finally {
        await app.close();
    }
});

test('F2. old Excel (.xls) and CSV open too', async () => {
    for (const [name, bytes] of [['Old.xls', makeXls()], ['People.csv', makeCsv()]]) {
        const app = await openFormat(name, bytes, () => !!document.querySelector('.x-spreadsheet canvas'));
        try {
            await new Promise(resolve => setTimeout(resolve, 300));
            await assertNoErrors(app);
            await app.page.screenshot({ path: join(OUTPUT, `format-${name.split('.').pop()}.png`) });
        } finally {
            await app.close();
        }
    }
});

test('F3. Word (.docx) shows the document text', async () => {
    const app = await openFormat('Letter.docx', await makeDocx(), () => document.body.innerText.includes('The quick brown fox'));
    try {
        await assertNoErrors(app);
        await app.page.screenshot({ path: join(OUTPUT, 'format-docx.png') });
    } finally {
        await app.close();
    }
});

test('F4. PowerPoint (.pptx) renders the slides', async () => {
    const app = await openFormat('Deck.pptx', await makePptx(), () => document.querySelectorAll('canvas').length > 0);
    try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await assertNoErrors(app);
        await app.page.screenshot({ path: join(OUTPUT, 'format-pptx.png') });
    } finally {
        await app.close();
    }
});

test('F5. EPUB shows the first chapter', async () => {
    const app = await openFormat('Book.epub', await makeEpub(), () => [...document.querySelectorAll('iframe')]
        .some(frame => frame.contentDocument?.body?.innerText?.includes('Chapter One')));
    try {
        await assertNoErrors(app);
        await app.page.screenshot({ path: join(OUTPUT, 'format-epub.png') });
    } finally {
        await app.close();
    }
});

test('F6. fonts (.ttf and .woff2) show their glyphs', async () => {
    for (const [name, bytes] of [['Liberation.ttf', await makeTtf()], ['KaTeX.woff2', await makeWoff2()]]) {
        const app = await openFormat(name, bytes, () => document.querySelectorAll('canvas').length > 10);
        try {
            await assertNoErrors(app);
            await app.page.screenshot({ path: join(OUTPUT, `format-${name.split('.').pop()}.png`) });
        } finally {
            await app.close();
        }
    }
});

test('F7. Parquet shows the rows', async () => {
    const app = await openFormat('Data.parquet', await makeParquet(), () => document.body.innerText.includes('Grace'));
    try {
        await assertNoErrors(app);
        await app.page.screenshot({ path: join(OUTPUT, 'format-parquet.png') });
    } finally {
        await app.close();
    }
});

test('F8. the library shows each type with its icon, opens viewers and Quick Look, and Library goes back', async () => {
    const fake = new FakeNative();
    const pdf = (await makeTextPdf({ pages: [{}], withId: true })).bytes;
    fake.add('Report.pdf', pdf, { lastOpened: 6000 });
    const sheet = fake.add('Budget.xlsx', makeXlsx(), { lastOpened: 5000 });
    const photo = fake.add('Photo.heic', new Uint8Array([0, 1, 2]), { lastOpened: 4000 });
    fake.add('Slides.pptx', await makePptx(), { lastOpened: 3000 });
    const app = await openApp(fake);
    try {
        await app.page.waitForSelector('.file-name');
        const rows = await app.page.$$eval('.file-row', rows => rows.map(row => ({
            name: row.querySelector('.file-name').textContent,
            label: row.querySelector('.file-icon text').textContent,
        })));
        assert.deepEqual(rows, [
            { name: 'Report', label: 'PDF' }, { name: 'Budget', label: 'XLS' }, { name: 'Photo', label: 'IMG' }, { name: 'Slides', label: 'PPT' },
        ]);
        await app.page.screenshot({ path: join(OUTPUT, 'library-formats.png') });

        // An image opens in Quick Look (the page stays)
        const tapRow = async (index) => {
            const box = await (await app.page.$$('.file'))[index].boundingBox();
            await app.page.touchscreen.tap(box.x + 60, box.y + box.height / 2);
        };
        await tapRow(2);
        await waitUntil(() => fake.previews.length === 1);
        assert.deepEqual(fake.previews, [photo]);
        assert.ok(app.page.url().endsWith('/index.html'));

        // A spreadsheet opens in the React viewer; Library goes back
        await tapRow(1);
        await waitUntil(() => app.page.url().includes(`react/index.html?id=${sheet}&route=excel`));
        await app.page.waitForSelector('#anyfileBack');
        const back = await (await app.page.$('#anyfileBack')).boundingBox();
        await app.page.touchscreen.tap(back.x + back.width / 2, back.y + back.height / 2);
        await waitUntil(() => app.page.url().endsWith('/index.html'));
        await app.page.waitForSelector('.file-name');
        assert.deepEqual(app.errors, []);
    } finally {
        await app.close();
    }
});

test('F9. picking a file ANYfile cannot show removes it again and says which types it opens', async () => {
    const fake = new FakeNative();
    fake.handle = (original => async (method, options) => {
        if (method === 'pickFiles') {
            const id = fake.add('notes.zip', new Uint8Array([80, 75]));
            return { files: [fake.entry(fake.files.get(id))], failed: [] };
        }
        return original.call(fake, method, options);
    })(fake.handle);
    const app = await openApp(fake);
    try {
        await app.page.waitForSelector('#open');
        const box = await (await app.page.$('#open')).boundingBox();
        await app.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await app.page.waitForFunction(() => !document.getElementById('message').hidden, { timeout: 5000 });
        assert.match(await app.page.$eval('#message', node => node.textContent), /can't open notes\.zip\. It opens PDF, Excel/);
        assert.equal(fake.files.size, 0, 'removed from the library');
    } finally {
        await app.close();
    }
});
