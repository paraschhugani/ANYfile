// The Word viewer (.docx, route "word") on the phone: view only, the page fits the screen width (on open and
// when the screen turns), two fingers zoom, nothing edits. Run: node --test test/format-word.test.mjs (from mobile/,
// after node build.mjs). Screenshots go to test/output/ (ANYFILE_TEST_OUTPUT).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REPO_ROOT } from '../../test/pdf-highlight/harness.mjs';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness, waitUntil } from './harness.mjs';

const JSZip = createRequire(join(REPO_ROOT, 'package.json'))('jszip');

/** Space the viewer leaves between the page and the screen edges at fit width (mobileZoom.ts). */
const GUTTER = 10;
const IPHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

before(startHarness);
after(stopHarness);

/** An A4 report of a few pages: a title, headings, wrapped paragraphs and a table. */
async function makeReportDocx() {
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
    const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
    const paragraph = (content, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
    const cell = (text) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${paragraph(run(text))}</w:tc>`;
    const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
    const table = `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders></w:tblPr>
<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
${[['Name', 'City', 'Score'], ['Ada', 'London', '91'], ['Grace', 'New York', '87'], ['Linus', 'Helsinki', '78']]
        .map(row => `<w:tr>${row.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;
    const body = [paragraph(run('ANYfile Word report', '<w:b/><w:sz w:val="44"/>'), '<w:jc w:val="center"/>')];
    for (let section = 1; section <= 3; section++) {
        body.push(paragraph(run(`Section ${section}`, '<w:b/><w:sz w:val="32"/><w:color w:val="1F4E79"/>')));
        for (let i = 1; i <= 10; i++) {
            body.push(paragraph(run(`Paragraph ${section}.${i}. `, '<w:b/>')
                + run('The quick brown fox jumps over the lazy dog. A view-only copy of this report fits the width of the phone, '
                    + 'and two fingers zoom in to read the small print.')));
        }
        if (section === 1) {
            body.push(table);
        }
    }
    body.push(paragraph(run('The end of the document.', '<w:i/>')));
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`);
    return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** Where things are on screen (CSS px); `pageWidth` is the page's own width at zoom 1. */
async function layout(page) {
    return page.evaluate(() => {
        const box = (node) => {
            const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
            return { left, top, right, bottom, width, height };
        };
        const scroller = document.querySelector('.docx-editor__scroll-container');
        const pages = [...document.querySelectorAll('.paged-editor__pages .layout-page')];
        return {
            root: box(document.getElementById('root')),
            viewer: box(document.querySelector('.word-viewer')),
            scroller: {
                ...box(scroller),
                clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth,
                clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
                scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop,
            },
            page: box(pages[0]),
            lastPage: box(pages.at(-1)),
            pageCount: pages.length,
            pageWidth: pages[0].offsetWidth,
            toggle: box(document.querySelector('.dark-mode-toggle')),
            minWidthSet: document.querySelector('.word-viewer').style.getPropertyValue('--word-mobile-min-width') !== '',
        };
    });
}

/** Waits until the first page is as wide as the viewer minus the gutters. */
async function waitForFit(page) {
    await page.waitForFunction((gutter) => {
        const scroller = document.querySelector('.docx-editor__scroll-container');
        const first = document.querySelector('.paged-editor__pages .layout-page');
        return scroller && first && document.querySelector('.word-viewer').style.getPropertyValue('--word-mobile-min-width')
            && Math.abs(first.getBoundingClientRect().width - (scroller.clientWidth - 2 * gutter)) < 1;
    }, { timeout: 10000 }, GUTTER);
}

async function openReport({ dark = false } = {}) {
    const fake = new FakeNative();
    const id = fake.add('Report.docx', await makeReportDocx());
    const app = await openApp(fake, { path: `react/index.html?id=${id}&route=word`, dark });
    if (!dark) {
        // (headless Chrome otherwise follows the Mac's appearance)
        await app.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    }
    await app.page.waitForFunction(() => document.body.innerText.includes('The end of the document'), { timeout: 20000 });
    await waitForFit(app.page);
    await layoutSettled(app.page);
    return app;
}

/** Waits until the pages' height stops changing (the editor lays them out again as fonts load). */
async function layoutSettled(page) {
    let last = -1;
    let stableSince = Date.now();
    await waitUntil(async () => {
        const height = await page.$eval('.docx-editor__scroll-container', node => node.scrollHeight);
        if (height !== last) {
            last = height;
            stableSince = Date.now();
        }
        return Date.now() - stableSince > 400;
    });
}

function assertFitsRoot(view, label) {
    const near = (a, b) => Math.abs(a - b) < 1;
    assert.ok(near(view.root.top, 44), `${label}: #root starts below the app bar (${view.root.top})`);
    assert.ok(near(view.root.bottom, view.viewport ?? 844), `${label}: #root ends at the bottom of the screen (${view.root.bottom})`);
    for (const key of ['viewer', 'scroller']) {
        assert.ok(view[key].top >= view.root.top - 0.5 && view[key].bottom <= view.root.bottom + 0.5,
            `${label}: ${key} inside #root (${view[key].top}..${view[key].bottom})`);
    }
    assert.ok(view.toggle.top >= view.root.top && view.toggle.right <= view.root.right, `${label}: the theme button is inside #root`);
}

function assertFitsWidth(view, label) {
    const expected = view.scroller.clientWidth - 2 * GUTTER;
    assert.ok(Math.abs(view.page.width - expected) < 1, `${label}: page ${view.page.width}px wide, expected ${expected}`);
    assert.ok(Math.abs(view.page.left - (view.scroller.left + GUTTER)) < 1.5, `${label}: page centered (left ${view.page.left})`);
    assert.ok(view.scroller.scrollWidth <= view.scroller.clientWidth, `${label}: no sideways scrolling (${view.scroller.scrollWidth})`);
}

async function assertNoErrors(app) {
    assert.equal(await app.page.$eval('#anyfileError', node => node.hidden), true, 'no error overlay');
    assert.deepEqual(app.errors, [], 'no page errors');
}

/** Two fingers move from `from` px apart to `to` px apart, horizontally around (x, y). */
async function pinch(page, x, y, from, to, steps = 8) {
    const a = await page.touchscreen.touchStart(x - from / 2, y);
    const b = await page.touchscreen.touchStart(x + from / 2, y);
    for (let i = 1; i <= steps; i++) {
        const half = (from + (to - from) * i / steps) / 2;
        await a.move(x - half, y);
        await b.move(x + half, y);
    }
    await a.end();
    await b.end();
}

/** Waits until a pinch's zoom is applied (no CSS transform left) and the page width passes `check`. */
async function waitForZoom(page, check) {
    await waitUntil(async () => !(await page.$('.word-viewer--pinching')) && check((await layout(page)).page.width));
    // the editor lays the pages out again after a zoom change and may restore its scroll position
    await new Promise(resolve => setTimeout(resolve, 300));
}

test('W1. a Word document opens view only, its page fitting the phone width and inside #root', async () => {
    const app = await openReport();
    try {
        const { page } = app;
        const view = await layout(page);
        assert.ok(view.pageCount >= 2, `several pages (${view.pageCount})`);
        assert.ok(view.minWidthSet, 'fitted to the document\'s own (A4) page, not just the initial Letter guess');
        assertFitsWidth(view, 'open');
        assertFitsRoot(view, 'open');

        // No editing UI, no desktop banner or outline button, no page indicator (it ignores the zoom)
        const chrome = await page.evaluate(() => ({
            toolbar: !!document.querySelector('[data-testid="editor-toolbar"], [data-testid="formatting-bar"], [data-testid="title-bar"]'),
            outline: !!document.querySelector('.docx-outline-toggle'),
            banner: !!document.querySelector('.word-readonly-banner'),
            editable: document.querySelectorAll('[contenteditable="true"]').length,
            pageIndicator: [...document.querySelectorAll('.docx-editor [role="status"]')].some(node => getComputedStyle(node).display !== 'none'),
        }));
        assert.deepEqual(chrome, { toolbar: false, outline: false, banner: false, editable: 0, pageIndicator: false });
        assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /Read-only|saved to a new file/);
        await page.screenshot({ path: join(OUTPUT, 'format-word.png') });

        // The end of the last page can be scrolled into view above the bottom of the screen, with no long blank
        // space after it (the editor's own bottom space at zoom 1 is not kept)
        await page.evaluate(() => {
            const scroller = document.querySelector('.docx-editor__scroll-container');
            scroller.scrollTop = scroller.scrollHeight;
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        const end = await layout(page);
        assert.ok(end.lastPage.bottom <= end.scroller.bottom + 0.5 && end.lastPage.bottom > end.scroller.bottom - 80,
            `last page ends inside the view (${end.lastPage.bottom} vs ${end.scroller.bottom})`);
        await page.screenshot({ path: join(OUTPUT, 'format-word-end.png') });
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('W2. dark mode: the same layout, and the theme button switches the page to the app\'s colors', async () => {
    const app = await openReport({ dark: true });
    try {
        const { page } = app;
        const view = await layout(page);
        assertFitsWidth(view, 'dark');
        assertFitsRoot(view, 'dark');
        await page.screenshot({ path: join(OUTPUT, 'format-word-dark.png') });

        const toggle = view.toggle;
        await page.touchscreen.tap(toggle.left + toggle.width / 2, toggle.top + toggle.height / 2);
        await page.waitForSelector('.word-viewer--vscode-theme');
        await new Promise(resolve => setTimeout(resolve, 200));
        const adaptive = await layout(page);
        assertFitsWidth(adaptive, 'dark adaptive');
        assertFitsRoot(adaptive, 'dark adaptive');
        await page.screenshot({ path: join(OUTPUT, 'format-word-dark-adaptive.png') });
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('W3. tapping the text does not start editing (no keyboard)', async () => {
    const app = await openReport();
    try {
        const { page } = app;
        const point = await page.evaluate(() => {
            const span = [...document.querySelectorAll('.layout-page span')].find(node => node.textContent.includes('quick brown fox'));
            const rect = span.getBoundingClientRect();
            return { x: rect.left + Math.min(40, rect.width / 2), y: rect.top + rect.height / 2 };
        });
        await page.touchscreen.tap(point.x, point.y);
        await new Promise(resolve => setTimeout(resolve, 300));
        const focus = await page.evaluate(() => {
            const active = document.activeElement;
            return {
                editable: active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName),
                editableNodes: document.querySelectorAll('[contenteditable="true"]').length,
                toolbar: !!document.querySelector('[data-testid="editor-toolbar"]'),
            };
        });
        assert.deepEqual(focus, { editable: false, editableNodes: 0, toolbar: false });
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('W4. two fingers zoom in around the fingers, then back out to the fit', async () => {
    const app = await openReport();
    try {
        const { page } = app;
        const fit = await layout(page);
        const x = 195;
        const y = fit.root.top + 260;
        // The document point between the fingers, as a fraction of the page
        const anchor = { x: (x - fit.page.left) / fit.page.width, y: (y - fit.page.top) / fit.page.width };

        await pinch(page, x, y, 80, 160);
        await waitForZoom(page, (width) => width > fit.page.width * 1.9);
        const zoomed = await layout(page);
        assert.ok(Math.abs(zoomed.page.width / fit.page.width - 2) < 0.05, `twice as large (${zoomed.page.width / fit.page.width})`);
        const after = { x: (x - zoomed.page.left) / zoomed.page.width, y: (y - zoomed.page.top) / zoomed.page.width };
        assert.ok(Math.abs(after.x - anchor.x) < 0.02 && Math.abs(after.y - anchor.y) < 0.02,
            `the same point stays between the fingers (${JSON.stringify(anchor)} -> ${JSON.stringify(after)})`);
        assertFitsRoot(zoomed, 'zoomed');
        assert.equal(await page.evaluate(() => document.querySelector('.word-viewer').classList.contains('word-viewer--pinching')), false);
        await page.screenshot({ path: join(OUTPUT, 'format-word-zoomed.png') });

        // Both sides of the zoomed page can be scrolled to, with the same gutter
        const edges = await page.evaluate(() => {
            const scroller = document.querySelector('.docx-editor__scroll-container');
            const first = document.querySelector('.paged-editor__pages .layout-page');
            scroller.scrollLeft = 0;
            const left = first.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
            scroller.scrollLeft = scroller.scrollWidth;
            const right = scroller.getBoundingClientRect().right - first.getBoundingClientRect().right;
            return { left, right };
        });
        assert.ok(Math.abs(edges.left - GUTTER) < 1.5 && Math.abs(edges.right - GUTTER) < 1.5, `gutters when panned: ${JSON.stringify(edges)}`);

        // One finger still scrolls (no pinch transform left behind)
        const top = (await layout(page)).scroller.scrollTop;
        const finger = await page.touchscreen.touchStart(200, 600);
        for (let i = 1; i <= 6; i++) {
            await finger.move(200, 600 - i * 40);
        }
        await finger.end();
        await waitUntil(async () => (await layout(page)).scroller.scrollTop > top + 50, 3000);

        // Pinching far out springs back to the fit width
        await pinch(page, x, y, 240, 40);
        await waitForZoom(page, (width) => Math.abs(width - fit.page.width) < 1);
        assertFitsWidth(await layout(page), 'zoomed out');
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('W5. turning the phone, or an iPad, fits the page to the new width', async () => {
    const app = await openReport();
    try {
        const { page } = app;
        for (const [label, size] of [['landscape', { width: 844, height: 390 }], ['iPad', { width: 820, height: 1180 }], ['portrait', { width: 390, height: 844 }]]) {
            await page.setViewport({ ...IPHONE, ...size });
            await waitForFit(page);
            const view = { ...(await layout(page)), viewport: size.height };
            assertFitsWidth(view, label);
            assertFitsRoot(view, label);
            if (label === 'landscape') {
                await page.screenshot({ path: join(OUTPUT, 'format-word-landscape.png') });
            }
        }
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});
