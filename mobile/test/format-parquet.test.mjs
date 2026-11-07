// The Parquet viewer (src/react/view/parquet) on the phone, in headless Chrome as an iPhone (390x844, touch):
// a wide file (10 columns, 230 rows) gets a full-width table that scrolls both ways by touch and pages,
// the schema collapses into the toolbar, and a view-only file shows no Save button or banner.
// Run from mobile/: node --test test/format-parquet.test.mjs (screenshots go to test/output/).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REPO_ROOT } from '../../test/pdf-highlight/harness.mjs';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness, waitUntil } from './harness.mjs';
import { makeParquet } from './fixtures.mjs';

before(startHarness);
after(stopHarness);

const ROWS = 230;
const LAST = 'a_much_longer_column_name_at_the_end';
const COLUMNS = ['id', 'name', 'email', 'score', 'active', 'city', 'visits', 'ratio', 'created_at', LAST];
const CITIES = ['London', 'New York', 'Helsinki', 'Zürich', 'São Paulo', 'Tokyo'];

async function makeWideParquet() {
    const { parquetWriteBuffer } = await import(join(REPO_ROOT, 'node_modules/hyparquet-writer/src/index.js'));
    const range = Array.from({ length: ROWS }, (_, i) => i);
    const buffer = parquetWriteBuffer({
        columnData: [
            { name: 'id', data: range.map(i => i + 1), type: 'INT32' },
            { name: 'name', data: range.map(i => `Person ${i + 1}`), type: 'STRING' },
            { name: 'email', data: range.map(i => `person.number.${i + 1}@example.com`), type: 'STRING' },
            { name: 'score', data: range.map(i => (i * 7) % 100 + 0.5), type: 'DOUBLE' },
            { name: 'active', data: range.map(i => i % 3 === 0), type: 'BOOLEAN' },
            { name: 'city', data: range.map(i => CITIES[i % CITIES.length]), type: 'STRING' },
            { name: 'visits', data: range.map(i => BigInt(i * 1000)), type: 'INT64' },
            { name: 'ratio', data: range.map(i => i / ROWS), type: 'FLOAT' },
            { name: 'created_at', data: range.map(i => new Date(Date.UTC(2026, 0, 1 + (i % 28)))), type: 'TIMESTAMP' },
            { name: LAST, data: range.map(i => `end-${i + 1}`), type: 'STRING' },
        ],
    });
    return new Uint8Array(buffer);
}

/** Opens a parquet file in the viewer with the system appearance set to light or dark. */
async function openParquet(bytes, { dark = false, ready = 'Person 2', name = 'Wide.parquet' } = {}) {
    const fake = new FakeNative();
    const id = fake.add(name, bytes);
    const app = await openApp(fake, { path: `react/index.html?id=${id}&route=parquet`, dark });
    if (!dark) {
        // openApp leaves the appearance to the machine's; pin light mode explicitly.
        await app.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    }
    await app.page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 20000 }, ready);
    return app;
}

async function assertNoErrors(app) {
    assert.equal(await app.page.$eval('#anyfileError', node => node.hidden), true, 'no error overlay');
    assert.deepEqual(app.errors, [], 'no page errors');
}

function rect(page, selector) {
    return page.$eval(selector, node => {
        const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
        return { left, top, right, bottom, width, height };
    });
}

function tableScroll(page) {
    return page.$eval('.ant-table-body', body => ({
        left: body.scrollLeft, top: body.scrollTop,
        maxLeft: body.scrollWidth - body.clientWidth, maxTop: body.scrollHeight - body.clientHeight,
        headerLeft: document.querySelector('.ant-table-header').scrollLeft,
    }));
}

/** A one-finger swipe from (x, y) by (dx, dy), in small steps like a finger. */
async function swipe(page, x, y, dx, dy) {
    await page.touchscreen.touchStart(x, y);
    for (let step = 1; step <= 10; step++) {
        await page.touchscreen.touchMove(x + dx * step / 10, y + dy * step / 10);
    }
    await page.touchscreen.touchEnd();
}

async function tap(page, selector) {
    const box = await (await page.$(selector)).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

function firstRowIndex(page) {
    return page.$eval('.ant-table-tbody tr.ant-table-row td', td => td.textContent.trim());
}

/** WCAG contrast of an element's text color against the first opaque background behind it. */
function contrast(page, selector) {
    return page.$eval(selector, node => {
        const parse = (value) => {
            const srgb = value.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
            if (srgb) return [srgb[1] * 255, srgb[2] * 255, srgb[3] * 255, srgb[4] === undefined ? 1 : +srgb[4]];
            const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
            return [r, g, b, a];
        };
        const luminance = ([r, g, b]) => {
            const channel = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        let background = null;
        for (let element = node; element && !background; element = element.parentElement) {
            const color = parse(getComputedStyle(element).backgroundColor);
            if (color[3] > 0.9) background = color;
        }
        const [a, b] = [luminance(parse(getComputedStyle(node).color)), luminance(background)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
    });
}

test('Q1. the small sample shows both columns at full width, View only and no Save', async () => {
    const app = await openParquet(await makeParquet(), { ready: 'Grace', name: 'Data.parquet' });
    try {
        const root = await rect(app.page, '#root');
        const headers = await app.page.$$eval('.ant-table-thead th', ths => ths.map(th => {
            const { left, right } = th.getBoundingClientRect();
            return { text: th.textContent.trim(), left, right };
        }));
        for (const name of ['name', 'score']) {
            const header = headers.find(h => h.text === name);
            assert.ok(header && header.left >= root.left && header.right <= root.right, `${name} column visible: ${JSON.stringify(headers)}`);
        }
        assert.equal(await app.page.$('.parquet-viewer__sider'), null, 'no side panel');
        assert.equal(await app.page.$('.parquet-viewer__save-btn'), null, 'no Save button');
        assert.equal(await app.page.$('.parquet-viewer__readonly-banner'), null, 'no read-only banner');
        assert.equal(await app.page.$eval('.parquet-viewer__view-only', node => node.textContent), 'View only');
        await assertNoErrors(app);
        await app.page.screenshot({ path: join(OUTPUT, 'format-parquet-small.png') });
    } finally {
        await app.close();
    }
});

test('Q2. a wide file: full-width table inside #root, readable columns, touch scrolling both ways', async () => {
    const app = await openParquet(await makeWideParquet());
    try {
        const { page } = app;
        const root = await rect(page, '#root');
        const viewer = await rect(page, '.parquet-viewer');
        const body = await rect(page, '.ant-table-body');
        const footer = await rect(page, '.parquet-viewer__footer');
        assert.ok(Math.abs(viewer.top - root.top) < 1 && Math.abs(viewer.bottom - root.bottom) < 1, 'viewer fills #root');
        assert.ok(body.left <= root.left + 1 && body.right >= root.right - 1, 'table gets the full width');
        assert.ok(body.height > 500, `rows fill the height (${body.height}px)`);
        assert.ok(footer.bottom <= root.bottom + 0.5 && footer.top >= body.bottom - 0.5, 'pager below the rows, inside #root');

        const widths = await page.$$eval('.ant-table-thead th:not(.ant-table-cell-scrollbar)', ths => ths.map(th => th.getBoundingClientRect().width));
        assert.equal(widths.length, COLUMNS.length + 1);
        assert.ok(widths.slice(1).every(width => width >= 96), `readable column widths: ${widths}`);
        // The header (a separate table) lines up with the rows, also for the long last title (it wraps).
        const cells = await page.$eval('.ant-table-tbody tr.ant-table-row', tr => [...tr.children].map(td => td.getBoundingClientRect().width));
        assert.deepEqual(widths.map(Math.round), cells.map(Math.round), 'header and rows line up');
        assert.ok(widths.at(-1) <= 222, `a long title wraps (${widths.at(-1)}px)`);
        await page.screenshot({ path: join(OUTPUT, 'format-parquet-light.png') });

        // Sideways: a swipe to the left moves rows and header together; the last column comes into view.
        const start = await tableScroll(page);
        assert.ok(start.maxLeft > 500, 'the table is wider than the screen');
        const y = body.top + 120;
        await swipe(page, 330, y, -260, 0);
        await waitUntil(async () => (await tableScroll(page)).left > 100);
        let scroll = await tableScroll(page);
        assert.ok(Math.abs(scroll.headerLeft - scroll.left) < 2, 'header follows the rows');
        assert.ok(scroll.top < 5, 'a sideways swipe does not scroll down');
        for (let i = 0; i < 12 && (await tableScroll(page)).left < scroll.maxLeft - 1; i++) {
            await swipe(page, 360, y, -300, 0);
        }
        await waitUntil(async () => (await tableScroll(page)).left >= scroll.maxLeft - 1);
        const last = await page.$$eval('.ant-table-thead th', (ths, name) => {
            const th = ths.find(node => node.textContent.trim() === name);
            const { left, right } = th.getBoundingClientRect();
            return { left, right };
        }, LAST);
        assert.ok(last.left >= 0 && last.right <= root.right + 1, `last column reachable: ${JSON.stringify(last)}`);
        // The row number column stays pinned on the left.
        const index = await rect(page, '.ant-table-tbody tr.ant-table-row td');
        assert.ok(index.left >= root.left - 1 && index.left < root.left + 2, 'row numbers stay visible');
        await page.screenshot({ path: join(OUTPUT, 'format-parquet-scrolled.png') });

        // Down: a swipe up scrolls the rows (not the page) to the end of the first page of 50.
        await swipe(page, 200, body.top + 400, 0, -300);
        await waitUntil(async () => (await tableScroll(page)).top > 100);
        for (let i = 0; i < 12 && (await tableScroll(page)).top < (await tableScroll(page)).maxTop - 1; i++) {
            await swipe(page, 200, body.top + 450, 0, -400);
        }
        scroll = await tableScroll(page);
        assert.ok(scroll.top >= scroll.maxTop - 1, 'scrolled to the last row of the page');
        assert.ok(await page.$$eval('.ant-table-tbody tr.ant-table-row', rows => rows.at(-1).textContent.startsWith('50')));
        assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0, 'the page itself does not scroll');
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('Q3. paging by touch starts each page at its first row', async () => {
    const app = await openParquet(await makeWideParquet());
    try {
        const { page } = app;
        assert.equal(await page.$eval('.parquet-viewer__pager-info', node => node.textContent), '1 / 5');
        const next = await rect(page, '.parquet-viewer__pager-btn:last-child');
        assert.ok(next.width >= 36 && next.height >= 36, 'touch-sized pager buttons');

        await page.$eval('.ant-table-body', body => { body.scrollTop = body.scrollHeight; });
        await tap(page, '.parquet-viewer__pager-btn:last-child');
        await waitUntil(async () => (await page.$eval('.parquet-viewer__pager-info', node => node.textContent)) === '2 / 5');
        await waitUntil(async () => (await firstRowIndex(page)) === '51');
        await waitUntil(async () => (await tableScroll(page)).top === 0);

        for (let i = 0; i < 3; i++) {
            await tap(page, '.parquet-viewer__pager-btn:last-child');
        }
        await waitUntil(async () => (await page.$eval('.parquet-viewer__pager-info', node => node.textContent)) === '5 / 5');
        assert.equal(await firstRowIndex(page), '201');
        assert.equal(await page.$$eval('.ant-table-tbody tr.ant-table-row', rows => rows.length), 30);
        assert.equal(await page.$eval('.parquet-viewer__pager-btn:last-child', node => node.disabled), true);

        await tap(page, '.parquet-viewer__pager-btn:first-child');
        await waitUntil(async () => (await firstRowIndex(page)) === '151');
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

for (const dark of [false, true]) {
    const mode = dark ? 'dark' : 'light';
    test(`Q4. the schema opens from the toolbar and closes again (${mode})`, async () => {
        const app = await openParquet(await makeWideParquet(), { dark });
        try {
            const { page } = app;
            assert.equal(await page.$('.parquet-viewer__schema-panel'), null, 'collapsed at first');
            assert.match(await page.$eval('.parquet-viewer__schema-toggle', node => node.textContent), /Schema\s*10 Columns/);
            if (dark) {
                await page.screenshot({ path: join(OUTPUT, 'format-parquet-dark.png') });
            }

            // Readable in this appearance: header, cells, toolbar and pager.
            for (const selector of ['.ant-table-thead th:nth-child(2)', '.parquet-viewer__cell', '.parquet-viewer__schema-toggle-label',
                '.parquet-viewer__view-only', '.parquet-viewer__footer-total', '.parquet-viewer__pager-info']) {
                const ratio = await contrast(page, selector);
                assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} in ${mode} mode`);
            }

            await tap(page, '.parquet-viewer__schema-toggle');
            await page.waitForSelector('.parquet-viewer__schema-panel');
            assert.equal(await page.$eval('.parquet-viewer__schema-toggle', node => node.getAttribute('aria-expanded')), 'true');
            assert.deepEqual(await page.$$eval('.parquet-viewer__schema-panel .parquet-viewer__list-name', nodes => nodes.map(n => n.textContent)), COLUMNS);
            assert.match(await page.$eval('.parquet-viewer__schema-panel .parquet-viewer__meta', node => node.innerText), /230/);
            const root = await rect(page, '#root');
            const panel = await rect(page, '.parquet-viewer__schema-panel');
            const body = await rect(page, '.ant-table-body');
            const footer = await rect(page, '.parquet-viewer__footer');
            assert.ok(panel.width >= root.width - 1, 'the schema spans the width');
            assert.ok(panel.height <= root.height / 2, 'the schema leaves room for the table');
            assert.ok(body.top >= panel.bottom - 0.5 && body.height > 150, 'rows below the schema');
            assert.ok(footer.bottom <= root.bottom + 0.5, 'still inside #root');
            for (const selector of ['.parquet-viewer__list-name', '.parquet-viewer__list-type', '.parquet-viewer__stat-value']) {
                const ratio = await contrast(page, selector);
                assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} in ${mode} mode`);
            }
            await page.screenshot({ path: join(OUTPUT, `format-parquet-schema-${mode}.png`) });

            await tap(page, '.parquet-viewer__schema-toggle');
            await waitUntil(async () => !(await page.$('.parquet-viewer__schema-panel')));
            assert.ok((await rect(page, '.ant-table-body')).height > 500, 'the table takes the space back');

            // The viewer's own theme button switches to its built-in light colors, readable too.
            await tap(page, '.parquet-theme-toggle');
            await page.waitForSelector('.parquet-viewer--light');
            await new Promise(resolve => setTimeout(resolve, 500)); // antd fades the header background
            for (const selector of ['.ant-table-thead th:nth-child(2)', '.parquet-viewer__cell', '.parquet-viewer__view-only', '.parquet-viewer__pager-info']) {
                const ratio = await contrast(page, selector);
                assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} with the viewer's light theme`);
            }
            if (dark) {
                await page.screenshot({ path: join(OUTPUT, 'format-parquet-own-light.png') });
            }
            await assertNoErrors(app);
        } finally {
            await app.close();
        }
    });
}

test('Q5. on an iPad the table fills the screen too', async () => {
    const app = await openParquet(await makeWideParquet());
    try {
        const { page } = app;
        await page.setViewport({ width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await waitUntil(async () => (await rect(page, '.ant-table-body')).width > 800);
        const root = await rect(page, '#root');
        const footer = await rect(page, '.parquet-viewer__footer');
        assert.ok(footer.bottom <= root.bottom + 0.5 && footer.right <= root.right + 0.5, 'inside #root');
        assert.ok((await rect(page, '.ant-table-body')).height > 900, 'rows fill the height');
        await tap(page, '.parquet-viewer__schema-toggle');
        await page.waitForSelector('.parquet-viewer__schema-panel');
        assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth), 820, 'no sideways page scroll');
        await assertNoErrors(app);
        await page.screenshot({ path: join(OUTPUT, 'format-parquet-ipad.png') });
    } finally {
        await app.close();
    }
});
