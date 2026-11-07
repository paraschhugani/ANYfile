// The Excel viewer (src/react/view/excel) in the app: view only, sized to #root below the app's bar, touch,
// and colors that follow the system's light / dark appearance. Headless Chrome as an iPhone (harness.mjs).
// Run: node --test test/format-excel.test.mjs (from mobile/). Screenshots go to test/output/.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REPO_ROOT } from '../../test/pdf-highlight/harness.mjs';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness, waitUntil } from './harness.mjs';
import { makeCsv } from './fixtures.mjs';

const rootRequire = createRequire(join(REPO_ROOT, 'package.json'));
const XLSX = rootRequire('xlsx');
const JSZip = rootRequire('jszip');

before(startHarness);
after(stopHarness);

const SHEETS = 6;
const ROWS = 120;
const REGIONS = ['North', 'South', 'East', 'West'];

/** Six sheets of 120 rows; on the first, a light yellow header row (default text color) and dark gray
 *  text in column C (the workbook's colors for a white sheet). */
async function makeWorkbook() {
    const book = XLSX.utils.book_new();
    for (let s = 1; s <= SHEETS; s++) {
        const rows = [['Item', 'Region', 'Amount', 'Note']];
        for (let i = 1; i <= ROWS; i++) {
            rows.push([`S${s} item ${i}`, REGIONS[i % 4], i * s, `note ${i}`]);
        }
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), `Sheet number ${s}`);
    }
    const zip = await JSZip.loadAsync(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const patch = async (path, edit) => zip.file(path, edit(await zip.file(path).async('string')));
    await patch('xl/styles.xml', xml => xml
        .replace(/<fonts count="1">(.*?)<\/fonts>/, '<fonts count="2">$1<font><sz val="12"/><color rgb="FF404040"/><name val="Calibri"/></font></fonts>')
        .replace(/<fills count="2">(.*?)<\/fills>/, '<fills count="3">$1<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>')
        .replace(/<cellXfs count="1">(.*?)<\/cellXfs>/, '<cellXfs count="3">$1'
            + '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>'
            + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'));
    await patch('xl/worksheets/sheet1.xml', xml => xml
        .replace(/<c r="([A-D]1)"/g, '<c r="$1" s="1"')
        .replace(/<c r="(C\d+)"(?! s=)/g, '<c r="$1" s="2"'));
    return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

async function openSheet(name, bytes, { dark = false } = {}) {
    const fake = new FakeNative();
    const id = fake.add(name, bytes);
    const app = await openApp(fake, { path: `react/index.html?id=${id}&route=excel`, dark });
    if (!dark) {
        // The harness only emulates dark; the machine running the tests may be in dark mode.
        await setAppearance(app.page, 'light');
        await app.page.reload({ waitUntil: 'load' });
    }
    await waitForGrid(app.page);
    return app;
}

async function setAppearance(page, value) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value }]);
}

async function waitForGrid(page) {
    await page.waitForFunction(() => document.querySelector('.x-spreadsheet canvas')
        && document.querySelectorAll('.x-spreadsheet-menu > li').length > 0, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 400));
}

async function assertNoErrors(app) {
    assert.equal(await app.page.$eval('#anyfileError', node => node.hidden), true, 'no error overlay');
    assert.deepEqual(app.errors, [], 'no page errors');
}

/** The boxes of #root and the viewer's parts. */
async function layout(page) {
    return page.evaluate(() => {
        const box = (selector) => {
            const node = document.querySelector(selector);
            if (!node || getComputedStyle(node).display === 'none') {
                return null;
            }
            const { top, bottom, left, right, width, height } = node.getBoundingClientRect();
            return { top, bottom, left, right, width, height };
        };
        return {
            root: box('#root'), viewer: box('.excel-viewer'), sheet: box('.x-spreadsheet'), toolbar: box('.x-spreadsheet-toolbar'),
            formulaBar: box('.x-spreadsheet-formula-bar'), canvas: box('.x-spreadsheet-table'), bottombar: box('.x-spreadsheet-bottombar'),
            toggle: box('.dark-mode-toggle'), banner: box('.excel-readonly-banner'), find: box('.frp-panel'),
        };
    });
}

function assertInside(inner, outer, label) {
    assert.ok(inner, `${label} is shown`);
    assert.ok(inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5
        && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5,
        `${label} ${JSON.stringify(inner)} is inside #root ${JSON.stringify(outer)}`);
}

/** The middle of a cell of the canvas grid (default sizes: 60px row index, 100px columns, 30px rows). */
async function cellPoint(page, ci, ri) {
    const canvas = await page.$eval('.x-spreadsheet-table', node => node.getBoundingClientRect().toJSON());
    return { x: canvas.left + 60 + ci * 100 + 50, y: canvas.top + 30 + ri * 30 + 15 };
}

async function tap(page, { x, y }) {
    await page.touchscreen.tap(x, y);
    await new Promise(resolve => setTimeout(resolve, 150));
}

async function tapSelector(page, selector) {
    const box = await (await page.$(selector)).boundingBox();
    await tap(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

/** Records what gets focus: an input or text area focused from a tap opens the keyboard on iOS. */
async function trackFocus(page) {
    await page.evaluate(() => {
        window.__focused = [];
        document.addEventListener('focusin', event => window.__focused.push(event.target.tagName), true);
    });
}

async function formulaBar(page) {
    return page.evaluate(() => ({
        address: document.querySelector('.x-spreadsheet-formula-bar-name').value,
        text: document.querySelector('.x-spreadsheet-formula-bar-input').value,
        focused: [document.activeElement?.tagName ?? '', ...window.__focused ?? []]
            .filter(tag => tag === 'INPUT' || tag === 'TEXTAREA').join(','),
    }));
}

/** Luminance (0..1) of the canvas pixels in a CSS-pixel rect: the darkest, the brightest and the average. */
async function canvasLuminance(page, rect) {
    return page.$eval('.x-spreadsheet-table', (canvas, rect) => {
        const scale = canvas.width / canvas.getBoundingClientRect().width;
        const bounds = canvas.getBoundingClientRect();
        const data = canvas.getContext('2d').getImageData(
            Math.round((rect.x - bounds.left) * scale), Math.round((rect.y - bounds.top) * scale),
            Math.round(rect.width * scale), Math.round(rect.height * scale)).data;
        let min = 1;
        let max = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
            const value = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
        }
        return { min, max, avg: sum / (data.length / 4) };
    }, rect);
}

/** A cell's inner area (without its grid lines). */
async function cellRect(page, ci, ri) {
    const { x, y } = await cellPoint(page, ci, ri);
    return { x: x - 46, y: y - 12, width: 92, height: 24 };
}

/** Empty grid: the right half of a cell in column B (its short text is on the left). */
async function backgroundRect(page, ri) {
    const { x, y } = await cellPoint(page, 1, ri);
    return { x: x + 10, y: y - 12, width: 36, height: 24 };
}

async function toolbarButtons(page) {
    return page.$$eval('.x-spreadsheet-toolbar-btns > *', nodes => nodes
        .filter(node => getComputedStyle(node).display !== 'none' && !node.classList.contains('x-spreadsheet-toolbar-divider'))
        .map(node => node.querySelector('.codicon')?.className.match(/codicon-([\w-]+)/)?.[1] ?? node.textContent.trim()));
}

test('E1. the grid, toolbar and sheet tabs fit inside #root, with only the viewing tools', async () => {
    const app = await openSheet('Sales.xlsx', await makeWorkbook());
    try {
        const box = await layout(app.page);
        assertInside(box.viewer, box.root, 'the viewer');
        assertInside(box.sheet, box.root, 'the spreadsheet');
        assertInside(box.bottombar, box.root, 'the sheet tabs');
        assertInside(box.toggle, box.root, 'the light / dark toggle');
        assert.ok(box.toolbar.top >= box.root.top - 0.5, 'the toolbar is below the app bar');
        // The grid uses the height there is: toolbar + formula bar + grid + tabs fill #root.
        const used = box.toolbar.height + box.formulaBar.height + box.canvas.height + box.bottombar.height;
        assert.ok(box.root.height - used >= 0 && box.root.height - used < 8, `grid fills #root (${used} of ${box.root.height})`);
        assert.equal(box.banner, null, 'no read-only banner (files are always view only in the app)');

        // Only find, freeze panes and auto-fit: no undo / redo / format painter / clear format / save /
        // save as / Edit in VS Code / formatting.
        assert.deepEqual(await toolbarButtons(app.page), ['search', 'pin', 'AF']);

        // All six sheets have a tab; the ones that do not fit are in the "more" menu.
        assert.equal(await app.page.$$eval('.x-spreadsheet-menu > li', nodes => nodes.length), SHEETS);
        assert.equal(await app.page.$eval('.x-spreadsheet-sheet-action-btn.add', node => getComputedStyle(node).display), 'none',
            'no "add sheet" button');
        await app.page.screenshot({ path: join(OUTPUT, 'format-excel-light.png') });

        // Auto-fit's message shows below the app's bar
        await tapSelector(app.page, '.excel-autofit-badge');
        await app.page.waitForSelector('.ant-message-notice', { visible: true });
        await new Promise(resolve => setTimeout(resolve, 600)); // its slide-in animation
        const notice = await app.page.$eval('.ant-message-notice', node => node.getBoundingClientRect().toJSON());
        assertInside(notice, box.root, 'the auto-fit message');
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('E2. touch: a tap selects a cell without the keyboard, one finger scrolls, tabs switch sheets', async () => {
    const app = await openSheet('Sales.xlsx', await makeWorkbook());
    const { page } = app;
    try {
        await trackFocus(page);
        // Tap B3
        await tap(page, await cellPoint(page, 1, 2));
        let bar = await formulaBar(page);
        assert.equal(bar.address, 'B3');
        assert.equal(bar.text, 'East');
        assert.equal(bar.focused, '', 'no input focused (the keyboard)');

        // A one-finger drag up scrolls the grid down
        const start = await cellPoint(page, 1, 15);
        await page.touchscreen.touchStart(start.x, start.y);
        for (let step = 1; step <= 10; step++) {
            await page.touchscreen.touchMove(start.x, start.y - step * 40);
        }
        await page.touchscreen.touchEnd();
        await waitUntil(() => page.$eval('.x-spreadsheet-overlayer', node => node.scrollTop > 200));
        await new Promise(resolve => setTimeout(resolve, 400));
        // ...and the grid follows: the first visible row is a later one now
        const top = await page.$eval('.x-spreadsheet-table', node => node.getBoundingClientRect().top);
        await tap(page, { x: (await cellPoint(page, 0, 0)).x, y: top + 30 + 5 });
        bar = await formulaBar(page);
        assert.ok(Number(bar.address.slice(1)) > 6, `a lower row is at the top after scrolling (got ${bar.address})`);
        assert.match(bar.text, /^S1 item \d+$/);
        assert.equal(bar.focused, '');

        // Tap the second sheet's tab
        const tabs = await page.$$('.x-spreadsheet-menu > li');
        const tabBox = await tabs[1].boundingBox();
        await tap(page, { x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 });
        assert.equal(await page.$eval('.x-spreadsheet-menu > li.active', node => node.textContent), 'Sheet number 2');
        await tap(page, await cellPoint(page, 0, 1));
        bar = await formulaBar(page);
        assert.equal(bar.address, 'A2');
        assert.equal(bar.text, 'S2 item 1');

        // A swipe scrolls the tab strip (the whole width on a phone: no scroll buttons)
        assert.equal(await page.$eval('.x-spreadsheet-sheet-nav', node => getComputedStyle(node).display), 'none');
        const strip = await (await page.$('.x-spreadsheet-menu')).boundingBox();
        const stripY = strip.y + strip.height / 2;
        await page.touchscreen.touchStart(strip.x + strip.width - 20, stripY);
        for (let step = 1; step <= 8; step++) {
            await page.touchscreen.touchMove(strip.x + strip.width - 20 - step * 30, stripY);
        }
        await page.touchscreen.touchEnd();
        await waitUntil(() => page.$eval('.x-spreadsheet-menu', node => node.scrollLeft > 50));

        // The last sheet from the "more" menu
        await tapSelector(page, '.x-spreadsheet-sheet-action-btn.more');
        await page.waitForSelector('.x-spreadsheet-sheet-more-menu', { visible: true });
        const menu = await layout(page);
        const more = await page.$eval('.x-spreadsheet-sheet-more-menu', node => node.getBoundingClientRect().toJSON());
        assertInside(more, menu.root, 'the sheets menu');
        await page.screenshot({ path: join(OUTPUT, 'format-excel-sheets.png') });
        const items = await page.$$('.x-spreadsheet-sheet-more-item');
        assert.equal(items.length, SHEETS);
        const itemBox = await items[SHEETS - 1].boundingBox();
        await tap(page, { x: itemBox.x + itemBox.width / 2, y: itemBox.y + itemBox.height / 2 });
        assert.equal(await page.$eval('.x-spreadsheet-menu > li.active', node => node.textContent), `Sheet number ${SHEETS}`);
        await tap(page, await cellPoint(page, 0, 1));
        assert.equal((await formulaBar(page)).text, `S${SHEETS} item 1`);

        // Double tap: still no editor / keyboard
        const point = await cellPoint(page, 2, 3);
        await page.touchscreen.tap(point.x, point.y);
        await page.touchscreen.tap(point.x, point.y);
        await new Promise(resolve => setTimeout(resolve, 200));
        bar = await formulaBar(page);
        assert.equal(bar.focused, '', 'no input focused after a double tap');
        assert.equal(await page.$eval('.x-spreadsheet-editor', node => getComputedStyle(node).display), 'none', 'no cell editor');
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('E3. find works and stays inside #root', async () => {
    const app = await openSheet('Sales.xlsx', await makeWorkbook());
    const { page } = app;
    try {
        await tapSelector(page, '.x-spreadsheet-toolbar-btns .codicon-search');
        await page.waitForSelector('.frp-panel input');
        // read only: find, no replace
        assert.equal(await page.$$eval('.frp-panel input', nodes => nodes.length), 1);
        await page.type('.frp-panel input', 'S1 item 50');
        await page.keyboard.press('Enter');
        await waitUntil(async () => (await formulaBar(page)).address === 'A51');
        assert.equal((await formulaBar(page)).text, 'S1 item 50');
        const box = await layout(page);
        assertInside(box.find, box.root, 'the find panel');
        await page.screenshot({ path: join(OUTPUT, 'format-excel-find.png') });
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('E4. dark appearance: a dark grid with readable text; it follows the system appearance live', async () => {
    const app = await openSheet('Sales.xlsx', await makeWorkbook(), { dark: true });
    const { page } = app;
    try {
        assert.ok(await page.evaluate(() => document.body.classList.contains('office-dark')), 'Excel uses its dark colors');
        const empty = await canvasLuminance(page, await backgroundRect(page, 10));
        assert.ok(empty.max < 0.15, `empty cells are dark (${JSON.stringify(empty)})`);
        const text = await canvasLuminance(page, await cellRect(page, 0, 5));
        assert.ok(text.max > 0.8, `default text is light on the dark grid (${JSON.stringify(text)})`);
        // The workbook's light yellow header with default text: dark text on it
        const header = await canvasLuminance(page, await cellRect(page, 0, 0));
        assert.ok(header.avg > 0.6, `the header keeps its light fill (${JSON.stringify(header)})`);
        assert.ok(header.min < 0.35, `with dark text on it (${JSON.stringify(header)})`);
        // The workbook's dark gray text (column C): light on the dark grid
        const note = await canvasLuminance(page, await cellRect(page, 2, 5));
        assert.ok(note.max > 0.8, `dark gray text is readable on the dark grid (${JSON.stringify(note)})`);

        const box = await layout(page);
        assertInside(box.bottombar, box.root, 'the sheet tabs');
        await page.screenshot({ path: join(OUTPUT, 'format-excel-dark.png') });

        // The system switches to light: the grid follows without reopening
        await setAppearance(page, 'light');
        await waitUntil(async () => (await canvasLuminance(page, await backgroundRect(page, 10))).min > 0.9);
        const lightText = await canvasLuminance(page, await cellRect(page, 0, 5));
        assert.ok(lightText.min < 0.2, `dark text on the light grid (${JSON.stringify(lightText)})`);
        const lightNote = await canvasLuminance(page, await cellRect(page, 2, 5));
        assert.ok(lightNote.min < 0.35, `the workbook's dark gray text as it is (${JSON.stringify(lightNote)})`);
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('E5. the light / dark toggle still switches to the light palette, and back', async () => {
    const app = await openSheet('Sales.xlsx', await makeWorkbook(), { dark: true });
    const { page } = app;
    try {
        await tapSelector(page, '.dark-mode-toggle');
        await waitUntil(async () => (await canvasLuminance(page, await backgroundRect(page, 10))).min > 0.9);
        assert.equal(await page.evaluate(() => document.body.classList.contains('office-dark')), false);
        await tapSelector(page, '.dark-mode-toggle');
        await waitUntil(async () => (await canvasLuminance(page, await backgroundRect(page, 10))).max < 0.15);
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('E6. rotating to landscape (and back) resizes the grid to #root', async () => {
    const app = await openSheet('Sales.xlsx', await makeWorkbook());
    const { page } = app;
    try {
        for (const [width, height] of [[844, 390], [390, 844]]) {
            await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
            await new Promise(resolve => setTimeout(resolve, 400));
            const box = await layout(page);
            assertInside(box.sheet, box.root, `the spreadsheet at ${width}x${height}`);
            assertInside(box.bottombar, box.root, `the sheet tabs at ${width}x${height}`);
            assert.ok(Math.abs(box.canvas.width - box.root.width) < 1, `the grid is as wide as #root at ${width}x${height}`);
            const used = box.toolbar.height + box.formulaBar.height + box.canvas.height + box.bottombar.height;
            assert.ok(box.root.height - used >= 0 && box.root.height - used < 8, `grid fills #root at ${width}x${height}`);
            if (width > height) {
                await page.screenshot({ path: join(OUTPUT, 'format-excel-landscape.png') });
            }
        }
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('E7. a CSV opens the same way (no Edit in VS Code button)', async () => {
    const app = await openSheet('People.csv', makeCsv());
    try {
        assert.deepEqual(await toolbarButtons(app.page), ['search', 'pin', 'AF']);
        const box = await layout(app.page);
        assertInside(box.bottombar, box.root, 'the sheet tabs');
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});
