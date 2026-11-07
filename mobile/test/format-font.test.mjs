// The font viewer (src/react/view/fontViewer) in the app: a full-width glyph grid sized to the screen,
// search on top, a sheet for the tapped glyph and for the font's details, light and dark, and lazy drawing
// (only the rows near the viewport have canvases) for fonts with tens of thousands of glyphs.
// Run: node --test test/format-font.test.mjs (from mobile/). Screenshots go to test/output/.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness, waitUntil } from './harness.mjs';
import { makeTtf, makeWoff2 } from './fixtures.mjs';

before(startHarness);
after(stopHarness);

// A big font from this Mac (read here, not copied into the repo); the test is skipped without one.
const BIG_FONTS = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/AppleMyungjo.ttf',
    '/System/Library/Fonts/Supplemental/AppleGothic.ttf',
];

async function openFont(name, bytes, { dark = false } = {}) {
    const fake = new FakeNative();
    const id = fake.add(name, bytes);
    const app = await openApp(fake, { path: `react/index.html?id=${id}&route=font`, dark });
    if (!dark) {
        // Headless Chrome follows the Mac's appearance otherwise
        await app.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    }
    await app.page.waitForFunction(() => document.querySelectorAll('.fv-cells canvas.glyph-cell').length > 10, { timeout: 60000 });
    return app;
}

function assertNoErrors(app) {
    assert.deepEqual(app.errors, [], 'no page errors');
}

/** The grid's layout and how many canvases the page has (and how many of them are drawn). */
function gridState(page) {
    return page.evaluate(() => {
        const grid = document.querySelector('.fv-grid');
        const gridRect = grid.getBoundingClientRect();
        const cells = [...document.querySelectorAll('.fv-cells canvas.glyph-cell')];
        const firstTop = cells[0] ? Math.round(cells[0].getBoundingClientRect().top) : 0;
        const firstRow = cells.filter(cell => Math.round(cell.getBoundingClientRect().top) === firstTop);
        // A canvas the viewer drew has its own size (an untouched canvas is 300x150).
        const drawn = cells.filter(cell => !(cell.width === 300 && cell.height === 150));
        const visible = cells.filter((cell) => {
            const rect = cell.getBoundingClientRect();
            return rect.bottom > gridRect.top && rect.top < gridRect.bottom;
        });
        const search = document.querySelector('.fv-search input').getBoundingClientRect();
        return {
            grid: { top: gridRect.top, bottom: gridRect.bottom, left: gridRect.left, width: gridRect.width },
            scrollTop: grid.scrollTop,
            scrollHeight: grid.scrollHeight,
            clientHeight: grid.clientHeight,
            canvases: document.querySelectorAll('canvas').length,
            cells: cells.length,
            drawn: drawn.length,
            visible: visible.length,
            visibleDrawn: visible.filter(cell => drawn.includes(cell)).length,
            canvasBytes: cells.reduce((sum, cell) => sum + cell.width * cell.height * 4, 0),
            columns: firstRow.length,
            cellWidth: cells[0]?.getBoundingClientRect().width ?? 0,
            search: { top: search.top, bottom: search.bottom, width: search.width },
            count: document.querySelector('.fv-count').textContent,
            pageWidth: document.documentElement.scrollWidth,
        };
    });
}

/** The average color of a canvas's opaque pixels (the glyph and its label), and how many there are. */
function inkColor(page, selector) {
    return page.$eval(selector, (canvas) => {
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 200) {
                r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
            }
        }
        return { n, brightness: n ? (r + g + b) / (3 * n) : 0 };
    });
}

function backgroundBrightness(page, selector) {
    return page.$eval(selector, (node) => {
        const [r, g, b] = getComputedStyle(node).backgroundColor.match(/[\d.]+/g).map(Number);
        return (r + g + b) / 3;
    });
}

async function tapElement(page, selector) {
    await page.$eval(selector, node => node.scrollIntoView({ block: 'nearest' }));
    const box = await (await page.$(selector)).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** Waits for a sheet to open and finish sliding in (taps during the animation miss its buttons). */
async function waitForSheet(page) {
    await page.waitForSelector('.fv-sheet');
    await page.waitForFunction(() => document.querySelector('.fv-sheet').getAnimations().every(a => a.playState === 'finished'));
}

/** Scrolls the grid to `top` and waits until the cells in view are drawn. */
async function scrollGrid(page, top) {
    await page.$eval('.fv-grid', (grid, value) => { grid.scrollTop = value; }, top);
    await waitUntil(async () => {
        const state = await gridState(page);
        return state.visible > 0 && state.visibleDrawn === state.visible;
    });
}

test('FT1. a TrueType font: full-width grid sized to the screen, search on top, glyph and font sheets', async () => {
    const app = await openFont('Liberation.ttf', await makeTtf());
    const { page } = app;
    try {
        const state = await gridState(page);
        assert.equal(await page.$eval('#anyfileBarTitle', node => node.textContent), 'Liberation.ttf');
        assert.equal(state.grid.left, 0);
        assert.equal(Math.round(state.grid.width), 390, 'the grid uses the full width');
        assert.ok(state.columns >= 4, `several columns (${state.columns})`);
        assert.ok(state.cellWidth >= 88, `cells big enough to tap (${state.cellWidth}px)`);
        assert.ok(state.grid.bottom <= 844 + 0.5, `the grid ends at the bottom of the screen (${state.grid.bottom})`);
        assert.ok(state.scrollHeight > state.clientHeight * 3, 'the grid scrolls');
        assert.equal(state.pageWidth, 390, 'no horizontal scrolling');
        assert.ok(state.search.top < 120 && state.search.width > 250, 'search is at the top and wide');
        assert.equal(state.count, '681 / 681 glyphs');
        // Only the rows near the viewport are in the page, and the visible ones are drawn
        assert.ok(state.cells < 120, `few canvases (${state.cells} of 681)`);
        assert.equal(state.visibleDrawn, state.visible);
        await waitUntil(async () => (await inkColor(page, '.glyph-cell[data-glyph="36"]')).brightness < 120);
        assert.ok((await inkColor(page, '.glyph-cell[data-glyph="36"]')).n > 50, 'dark glyphs are drawn');
        assert.ok(await backgroundBrightness(page, '.font-viewer-mobile') > 200, 'on a light background');
        await page.screenshot({ path: join(OUTPUT, 'font-grid-light.png') });

        // Scroll down, tap a glyph: its sheet opens over the grid, which keeps its place
        await scrollGrid(page, 1500);
        const before = await gridState(page);
        const target = await page.evaluate(() => {
            const gridRect = document.querySelector('.fv-grid').getBoundingClientRect();
            const cell = [...document.querySelectorAll('.glyph-cell')]
                .find(node => node.getBoundingClientRect().top > gridRect.top + 10);
            const rect = cell.getBoundingClientRect();
            return { key: cell.dataset.glyph, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        await page.touchscreen.tap(target.x, target.y);
        await waitForSheet(page);
        const sheet = await page.$eval('.fv-sheet', node => ({
            title: node.querySelector('.fv-sheet-title').textContent,
            info: Object.fromEntries([...node.querySelectorAll('.fv-info > div')]
                .map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])),
            bottom: node.getBoundingClientRect().bottom,
        }));
        assert.equal(sheet.title, 'Character');
        assert.match(sheet.info.Unicode, /^[0-9A-F]{4,6}/);
        assert.ok(sheet.info.Name.length > 0 && sheet.info.Name !== '-');
        assert.equal(sheet.info.Class, `Liberation Sans-${sheet.info.Name}`);
        assert.ok(Math.abs(sheet.bottom - 844) < 1, 'the sheet sits at the bottom');
        assert.equal(await page.$eval(`.glyph-cell[data-glyph="${target.key}"]`, node => node.classList.contains('selected')), true);
        assert.ok((await inkColor(page, '.fv-preview canvas')).n > 200, 'the preview is drawn');
        await page.screenshot({ path: join(OUTPUT, 'font-glyph-light.png') });

        await tapElement(page, '.fv-sheet-close');
        await waitUntil(async () => !(await page.$('.fv-sheet')));
        assert.equal((await gridState(page)).scrollTop, before.scrollTop, 'the grid kept its position');

        // Search narrows the grid; an invalid pattern searches the text instead of failing
        await tapElement(page, '.fv-search input');
        await page.keyboard.type('dollar');
        await waitUntil(async () => (await gridState(page)).count !== '681 / 681 glyphs');
        const found = await gridState(page);
        assert.match(found.count, /^\d+ \/ 681 glyphs$/);
        assert.equal(found.scrollTop, 0);
        const names = await page.evaluate(async () => {
            const keys = [...document.querySelectorAll('.glyph-cell')].map(cell => cell.dataset.glyph);
            return keys.length;
        });
        assert.equal(names, Number(found.count.split(' ')[0]));
        await tapElement(page, '.glyph-cell');
        await waitForSheet(page);
        assert.match(await page.$eval('.fv-info > div:nth-child(2) dd', node => node.textContent), /dollar/i);
        await page.screenshot({ path: join(OUTPUT, 'font-search-light.png') });
        // Tapping above the sheet closes it too
        const backdrop = await (await page.$('.fv-sheet-backdrop')).boundingBox();
        await page.touchscreen.tap(backdrop.x + backdrop.width / 2, backdrop.y + 40);
        await waitUntil(async () => !(await page.$('.fv-sheet')));

        await tapElement(page, '.fv-search-clear');
        await waitUntil(async () => (await gridState(page)).count === '681 / 681 glyphs');
        await tapElement(page, '.fv-search input');
        await page.keyboard.type('(');
        await waitUntil(async () => (await gridState(page)).count === '1 / 681 glyphs'); // a character finds its glyph
        await page.keyboard.type('x');
        await page.waitForFunction(() => document.querySelector('.fv-message')?.textContent === 'No glyphs match the search');
        await tapElement(page, '.fv-search-clear');
        await waitUntil(async () => (await gridState(page)).count === '681 / 681 glyphs');

        // The font's details
        await tapElement(page, '.fv-info-button');
        await waitForSheet(page);
        const details = await page.$eval('.fv-sheet', node => ({
            title: node.querySelector('.fv-sheet-title').textContent,
            info: Object.fromEntries([...node.querySelectorAll('.fv-info > div')]
                .map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])),
        }));
        assert.equal(details.title, 'Font');
        assert.equal(details.info.Family, 'Liberation Sans');
        assert.equal(details.info.Style, 'Regular');
        assert.equal(details.info.Format, 'truetype');
        assert.match(details.info.Version, /^Version /);
        await page.screenshot({ path: join(OUTPUT, 'font-details-light.png') });
        await tapElement(page, '.fv-sheet-close');
        await waitUntil(async () => !(await page.$('.fv-sheet')));
        assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('FT2. dark mode: light glyphs on a dark grid, dark sheets', async () => {
    const app = await openFont('Liberation.ttf', await makeTtf(), { dark: true });
    const { page } = app;
    try {
        assert.ok(await backgroundBrightness(page, '.font-viewer-mobile') < 80, 'dark grid');
        assert.ok(await backgroundBrightness(page, '.fv-toolbar') < 80, 'dark toolbar');
        const ink = await inkColor(page, '.glyph-cell[data-glyph="36"]');
        assert.ok(ink.n > 50 && ink.brightness > 150, `light glyphs (${ink.brightness})`);
        await page.screenshot({ path: join(OUTPUT, 'font-grid-dark.png') });

        await tapElement(page, '.glyph-cell[data-glyph="36"]');
        await waitForSheet(page);
        assert.ok(await backgroundBrightness(page, '.fv-sheet') < 80, 'dark sheet');
        assert.ok((await inkColor(page, '.fv-preview canvas')).brightness > 150, 'light preview glyph');
        await page.screenshot({ path: join(OUTPUT, 'font-glyph-dark.png') });
        await tapElement(page, '.fv-sheet-close');

        await tapElement(page, '.fv-info-button');
        await waitForSheet(page);
        await page.screenshot({ path: join(OUTPUT, 'font-details-dark.png') });

        // Switching the system appearance redraws the glyphs in the new colors
        await tapElement(page, '.fv-sheet-close');
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
        await waitUntil(async () => (await inkColor(page, '.glyph-cell[data-glyph="36"]')).brightness < 120);
        assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('FT3. WOFF2 fonts open and draw', async () => {
    const app = await openFont('KaTeX.woff2', await makeWoff2());
    const { page } = app;
    try {
        const state = await gridState(page);
        assert.match(state.count, /^(\d+) \/ \1 glyphs$/);
        assert.equal(state.visibleDrawn, state.visible);
        await page.screenshot({ path: join(OUTPUT, 'font-woff2.png') });
        await tapElement(page, '.fv-info-button');
        await waitForSheet(page);
        assert.match(await page.$eval('.fv-info > div:first-child dd', node => node.textContent), /KaTeX/);
        assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('FT4. iPad width: more columns, still full width', async () => {
    const app = await openFont('Liberation.ttf', await makeTtf());
    const { page } = app;
    try {
        await page.setViewport({ width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await waitUntil(async () => (await gridState(page)).columns >= 8);
        const state = await gridState(page);
        assert.equal(Math.round(state.grid.width), 820);
        assert.equal(state.visibleDrawn, state.visible);
        await tapElement(page, '.fv-info-button');
        await waitForSheet(page);
        const sheet = await page.$eval('.fv-sheet', node => node.getBoundingClientRect().width);
        assert.ok(sheet <= 560, 'the sheet does not stretch across the iPad');
        await page.screenshot({ path: join(OUTPUT, 'font-ipad.png') });
        assertNoErrors(app);
    } finally {
        await app.close();
    }
});

const bigFont = BIG_FONTS.find(path => existsSync(path));

test('FT5. a font with tens of thousands of glyphs only draws the glyphs near the viewport', { skip: !bigFont && 'no big font on this Mac' }, async () => {
    const started = Date.now();
    const app = await openFont(bigFont.split('/').pop(), await readFile(bigFont));
    const { page } = app;
    try {
        const opened = Date.now() - started;
        const state = await gridState(page);
        const total = Number(state.count.split(' / ')[1].split(' ')[0]);
        assert.ok(total > 15000, `a big font (${total} glyphs)`);
        assert.ok(state.canvases < 150, `few canvases at the top (${state.canvases})`);
        assert.equal(state.visibleDrawn, state.visible);

        // Scrolling far down: still few canvases, and the ones in view are drawn
        const max = state.scrollHeight - state.clientHeight;
        for (const top of [max / 2, max * 0.8, max]) {
            await scrollGrid(page, Math.round(top));
            const now = await gridState(page);
            assert.ok(now.canvases < 150, `few canvases at ${Math.round(top)}px (${now.canvases})`);
            assert.ok(now.canvasBytes < 16 * 1024 * 1024, `little canvas memory (${now.canvasBytes} bytes)`);
        }

        // A touch drag scrolls the grid
        await scrollGrid(page, Math.round(max / 2));
        const touchBefore = (await gridState(page)).scrollTop;
        const touch = await page.touchscreen.touchStart(200, 600);
        for (let y = 580; y >= 300; y -= 20) {
            await touch.move(200, y);
        }
        await touch.end();
        await new Promise(resolve => setTimeout(resolve, 500));
        const touchAfter = await gridState(page);
        assert.ok(touchAfter.scrollTop > touchBefore, `a drag scrolls (${touchBefore} -> ${touchAfter.scrollTop})`);
        await waitUntil(async () => {
            const now = await gridState(page);
            return now.visibleDrawn === now.visible;
        });
        await page.screenshot({ path: join(OUTPUT, 'font-big.png') });

        // Tapping a glyph far down opens its sheet
        await tapElement(page, '.glyph-cell:nth-child(20)');
        await waitForSheet(page);
        assert.ok((await inkColor(page, '.fv-preview canvas')).n > 0, 'the preview is drawn');
        await tapElement(page, '.fv-sheet-close');
        await waitUntil(async () => !(await page.$('.fv-sheet')));

        // Typing a character finds its glyph (these fonts often have no glyph names)
        await tapElement(page, '.fv-search input');
        await page.keyboard.type('迷');
        await waitUntil(async () => (await gridState(page)).count === `1 / ${total} glyphs`, 20000);
        await tapElement(page, '.glyph-cell');
        await waitForSheet(page);
        assert.equal(await page.$eval('.fv-info > div:first-child dd', node => node.textContent), '8FF7');
        await page.screenshot({ path: join(OUTPUT, 'font-big-glyph.png') });
        assertNoErrors(app);
        console.log(`# ${bigFont}: ${total} glyphs, opened in ${opened} ms, ${state.canvases} canvases at the top`);
    } finally {
        await app.close();
    }
});
