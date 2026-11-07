// The spreadsheet filter dropdown in the real viewer (Chrome): a filter on just the header row lists
// the column's values, like Excel / Google Sheets (it showed "0 / 0" before).
// Run: node --test test/excel-filter.test.mjs (after node build.mjs)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REPO_ROOT } from '../../test/pdf-highlight/harness.mjs';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness } from './harness.mjs';

const rootRequire = createRequire(join(REPO_ROOT, 'package.json'));
const XLSX = rootRequire('xlsx');
const JSZip = rootRequire('jszip');

before(startHarness);
after(stopHarness);

/** Header, three data rows, an empty row, then an unrelated block (which a filter must not take in). */
async function workbook({ headerOnlyFilter }) {
    const sheet = XLSX.utils.aoa_to_sheet([
        ['Element', 'Axis', 'Code'],
        ['S1', 'option', 1],
        ['S1', 'option', 2],
        ['S2', 'scale', 3],
        [],
        ['Notes', 'x', 'y'],
    ]);
    if (headerOnlyFilter) {
        sheet['!autofilter'] = { ref: 'A1:C1' };
    }
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Options');
    const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    if (!headerOnlyFilter) {
        return new Uint8Array(bytes);
    }
    // SheetJS always writes the whole sheet as the filter range; some tools save just the header row.
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    zip.file('xl/worksheets/sheet1.xml', xml.replace(/<autoFilter ref="[^"]+"/, '<autoFilter ref="A1:C1"'));
    return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

// The VS Code layout: no mobile flag, editable file (the app opens files read-only).
const DESKTOP_MODE = `(() => {
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (this.id === 'office-configs' && name === 'data-config') {
            const config = JSON.parse(value);
            delete config.mobile;
            value = JSON.stringify(config);
        }
        return setAttribute.call(this, name, value);
    };
    const dispatchEvent = window.dispatchEvent.bind(window);
    window.dispatchEvent = (event) => {
        if (event instanceof MessageEvent && event.data?.type === 'open' && event.data.content) {
            event.data.content.readOnly = false;
        }
        return dispatchEvent(event);
    };
})();`;

async function openSheet(bytes, { desktop = false } = {}) {
    const fake = new FakeNative();
    const id = fake.add('Report.xlsx', bytes);
    const app = await openApp(fake, { path: `react/index.html?id=${id}&route=excel`, ...(desktop ? { beforeLoad: DESKTOP_MODE } : {}) });
    if (desktop) {
        await app.page.setViewport({ width: 1400, height: 900 });
        await app.page.evaluate(() => document.body.classList.remove('anyfile-app'));
    }
    await app.page.waitForFunction(() => [...document.querySelectorAll('.x-spreadsheet-selector-area')]
        .some(area => area.getBoundingClientRect().width > 0), { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    return app;
}

/** Clicks the filter arrow of the selected cell (A1 after loading): the bottom-right corner of the cell. */
async function openFilterOfSelectedCell(page) {
    const point = await page.evaluate(() => {
        // The visible selection box (frozen panes have their own, hidden ones)
        const area = [...document.querySelectorAll('.x-spreadsheet-selector-area')]
            .map(element => element.getBoundingClientRect()).find(rect => rect.width > 0);
        return { x: area.right - 8, y: area.bottom - 8 };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => {
        const menu = document.querySelector('.x-spreadsheet-sort-filter');
        return menu && getComputedStyle(menu).display !== 'none';
    }, { timeout: 5000 });
    return page.evaluate(() => ({
        header: document.querySelector('.x-spreadsheet-sort-filter .x-spreadsheet-header').textContent.trim(),
        items: [...document.querySelectorAll('.x-spreadsheet-sort-filter .x-spreadsheet-body .x-spreadsheet-item')]
            .map(item => item.textContent.replace(/\s+/g, ' ').trim()),
    }));
}

test('a filter saved on just the header row lists the column values', async () => {
    const app = await openSheet(await workbook({ headerOnlyFilter: true }));
    try {
        const menu = await openFilterOfSelectedCell(app.page);
        await app.page.screenshot({ path: join(OUTPUT, 'excel-filter-saved.png') });
        assert.deepEqual(menu.items, ['S1(2)', 'S2(1)']);
        assert.equal(menu.header, '2 / 2');
        assert.deepEqual(app.errors, []);
    } finally {
        await app.close();
    }
});

test('VS Code: a filter created from the header row (A1 selected) lists the column values', async () => {
    const app = await openSheet(await workbook({ headerOnlyFilter: false }), { desktop: true });
    try {
        await app.page.evaluate(() => {
            // The toolbar's Filter button (it may sit in the "more" menu; a click works either way)
            document.querySelector('.codicon-filter').closest('.x-spreadsheet-toolbar-btn').click();
        });
        const menu = await openFilterOfSelectedCell(app.page);
        await app.page.screenshot({ path: join(OUTPUT, 'excel-filter-created.png') });
        assert.deepEqual(menu.items, ['S1(2)', 'S2(1)']);
        assert.equal(menu.header, '2 / 2');
        assert.deepEqual(app.errors, []);
    } finally {
        await app.close();
    }
});
