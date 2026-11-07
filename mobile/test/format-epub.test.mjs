// The EPUB viewer on the phone: swipes and taps on the left/right third turn pages (the middle opens the
// contents), a full localStorage does not break opening a book, the reading position is remembered, and the
// book is readable in light and dark mode. Run (from mobile/): node --test test/format-epub.test.mjs
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness, waitUntil } from './harness.mjs';
import { makeEpub } from './fixtures.mjs';

before(startHarness);
after(stopHarness);

const viewerPath = id => `react/index.html?id=${id}&route=epub`;

/** Ready: the first page is shown and the locations are known (the bottom bar shows them). */
async function waitForBook(page) {
    await page.waitForFunction(() => document.querySelector('.epub-viewer .error')
        || ([...document.querySelectorAll('.epub-viewer iframe')].some(frame => frame.contentDocument?.querySelector('h1'))
            && document.querySelector('.epub-viewer .loc-input')
            && !document.querySelector('.epub-viewer .epub-loading')), { timeout: 20000 });
    const error = await page.$eval('.epub-viewer', node => node.querySelector('.error')?.textContent ?? null);
    assert.equal(error, null, 'the viewer shows no error');
}

async function openBook({ dark = false } = {}) {
    const fake = new FakeNative();
    const id = fake.add('Book.epub', await makeEpub());
    const app = await openApp(fake, { path: viewerPath(id), dark });
    await waitForBook(app.page);
    return { ...app, fake, id };
}

/**
 * The chapter on screen and the page within it (the reader scrolls the chapter sideways a page at a time);
 * waits while a chapter is being replaced by the next.
 */
async function position(page) {
    const read = () => page.evaluate(() => {
        const container = document.querySelector('.epub-viewer .epub-container');
        const chapter = container?.querySelector('iframe')?.contentDocument?.querySelector('h1')?.textContent;
        return chapter ? { chapter, page: Math.round(container.scrollLeft / container.clientWidth) } : null;
    });
    let now = await read();
    for (let i = 0; i < 100 && !now; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        now = await read();
    }
    return now;
}

async function waitForPosition(page, expected) {
    await waitUntil(async () => {
        const now = await position(page);
        return now.chapter === expected.chapter && now.page === expected.page;
    }, 5000).catch(async () => {
        assert.deepEqual(await position(page), expected);
    });
}

/** The reader's area on screen. */
async function readerBox(page) {
    return page.$eval('.epub-viewer .epub-container', node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    });
}

async function tapAt(page, fraction) {
    const box = await readerBox(page);
    await page.touchscreen.tap(box.x + box.width * fraction, box.y + box.height / 2);
}

async function swipe(page, fromFraction, toFraction, { dy = 0 } = {}) {
    const box = await readerBox(page);
    const y = box.y + box.height / 2;
    const fromX = box.x + box.width * fromFraction;
    const toX = box.x + box.width * toFraction;
    await page.touchscreen.touchStart(fromX, y);
    for (let step = 1; step <= 6; step++) {
        await page.touchscreen.touchMove(fromX + (toX - fromX) * step / 6, y + dy * step / 6);
    }
    await page.touchscreen.touchEnd();
}

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

test('E1. the book fits below the app bar, and taps on the left/right third turn one page', async () => {
    const app = await openBook();
    const { page } = app;
    try {
        // Inside #root: below the app's bar, within the screen.
        const bar = await page.$eval('#anyfileBar', node => node.getBoundingClientRect().bottom);
        const viewer = await page.$eval('.epub-viewer', node => node.getBoundingClientRect().toJSON());
        assert.ok(viewer.top >= bar - 1, `viewer starts below the bar (${viewer.top} >= ${bar})`);
        assert.ok(viewer.bottom <= 844 && viewer.left >= 0 && viewer.right <= 390, 'viewer within the screen');
        const box = await readerBox(page);
        assert.ok(box.width >= 340, `the text uses the phone's width (${box.width}px)`);
        const overflow = await page.evaluate(() => {
            const doc = document.querySelector('.epub-viewer iframe').contentDocument;
            return doc.querySelector('h1').getBoundingClientRect().left >= 0;
        });
        assert.ok(overflow, 'the first page starts at the left edge');

        assert.deepEqual(await position(page), { chapter: 'Chapter One', page: 0 });
        await tapAt(page, 0.85);
        await waitForPosition(page, { chapter: 'Chapter One', page: 1 });
        // The tap's synthesized click must not turn a second page.
        await settle();
        assert.deepEqual(await position(page), { chapter: 'Chapter One', page: 1 });
        await tapAt(page, 0.85);
        await waitForPosition(page, { chapter: 'Chapter One', page: 2 });
        await tapAt(page, 0.15);
        await waitForPosition(page, { chapter: 'Chapter One', page: 1 });
        await settle();
        assert.deepEqual(await position(page), { chapter: 'Chapter One', page: 1 });

        // The middle opens the contents; tapping beside it closes them; the page stays.
        await tapAt(page, 0.5);
        await page.waitForSelector('.epub-viewer .sidebar-wrapper:not(.out)', { timeout: 3000 });
        await settle();
        assert.deepEqual(await position(page), { chapter: 'Chapter One', page: 1 });
        assert.ok(await page.$eval('.epub-viewer .toc-list', node => node.textContent.includes('Chapter Two')));
        await page.screenshot({ path: join(OUTPUT, 'format-epub-contents.png') });
        await page.touchscreen.tap(370, 600);
        await page.waitForSelector('.epub-viewer .sidebar-wrapper.out', { timeout: 3000 });
        assert.deepEqual(await position(page), { chapter: 'Chapter One', page: 1 });

        assert.deepEqual(app.errors, [], 'no page errors');
    } finally {
        await app.close();
    }
});

test('E2. swiping left and right turns pages, across chapters; small or vertical moves do not', async () => {
    const app = await openBook();
    const { page } = app;
    try {
        await swipe(page, 0.8, 0.2);
        await waitForPosition(page, { chapter: 'Chapter One', page: 1 });
        await settle();
        assert.deepEqual(await position(page), { chapter: 'Chapter One', page: 1 });
        await swipe(page, 0.2, 0.8);
        await waitForPosition(page, { chapter: 'Chapter One', page: 0 });

        // Not a swipe: too short, or mostly vertical.
        await swipe(page, 0.55, 0.5);
        await swipe(page, 0.6, 0.45, { dy: 300 });
        await settle();
        assert.deepEqual(await position(page), { chapter: 'Chapter One', page: 0 });

        // Swipe on into the next chapter, then back to the end of the first.
        let last = await position(page);
        for (let i = 0; i < 15 && last.chapter === 'Chapter One'; i++) {
            await swipe(page, 0.8, 0.2);
            await waitUntil(async () => JSON.stringify(await position(page)) !== JSON.stringify(last), 5000);
            last = await position(page);
        }
        assert.deepEqual(last, { chapter: 'Chapter Two', page: 0 });
        await swipe(page, 0.2, 0.8);
        await waitUntil(async () => (await position(page)).chapter === 'Chapter One', 5000);
        assert.ok((await position(page)).page > 0, 'back on the last page of chapter one');

        assert.deepEqual(app.errors, [], 'no page errors');
    } finally {
        await app.close();
    }
});

test('E3. the reading position is remembered on the device', async () => {
    const app = await openBook();
    const { page } = app;
    try {
        await tapAt(page, 0.85);
        await waitForPosition(page, { chapter: 'Chapter One', page: 1 });
        await tapAt(page, 0.85);
        await waitForPosition(page, { chapter: 'Chapter One', page: 2 });
        await settle(600);
        await page.reload({ waitUntil: 'load' });
        await waitForBook(page);
        await waitForPosition(page, { chapter: 'Chapter One', page: 2 });
        assert.deepEqual(app.errors, [], 'no page errors');
    } finally {
        await app.close();
    }
});

test('E4. a full localStorage does not stop a book from opening', async () => {
    const fake = new FakeNative();
    const id = fake.add('Book.epub', await makeEpub());
    // Fill the storage from the library page, then open the book (its locations cannot be cached now).
    const app = await openApp(fake, { path: 'index.html' });
    const { page } = app;
    try {
        await page.waitForSelector('.file-name');
        const filled = await page.evaluate(() => {
            const chunk = 'x'.repeat(256 * 1024);
            let i = 0;
            for (let size = chunk.length; size >= 1;) {
                try {
                    localStorage.setItem(`filler-${i++}`, chunk.slice(0, size));
                } catch {
                    size = Math.floor(size / 2);
                }
            }
            try {
                localStorage.setItem('probe', 'x'.repeat(64));
                return false;
            } catch {
                return true;
            }
        });
        assert.ok(filled, 'the storage is full');
        await page.goto(new URL(viewerPath(id), page.url()).href, { waitUntil: 'load' });
        await waitForBook(page);
        assert.equal(await page.$eval('#anyfileError', node => node.hidden), true, 'no error overlay');
        assert.ok(await page.$eval('.epub-viewer .loc-total', node => /^\/\d+$/.test(node.textContent)), 'locations generated');
        await tapAt(page, 0.85);
        await waitForPosition(page, { chapter: 'Chapter One', page: 1 });
        assert.deepEqual(app.errors, [], 'no page errors');
    } finally {
        await app.close();
    }
});

/** How light (0..1) the page's text and background, and the viewer around it, are. */
async function brightness(page) {
    return page.evaluate(() => {
        const doc = document.querySelector('.epub-viewer iframe').contentDocument;
        const lum = value => {
            const [r, g, b] = value.match(/[\d.]+/g).map(Number);
            return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        };
        return {
            text: lum(getComputedStyle(doc.querySelector('p')).color),
            page: lum(getComputedStyle(doc.body).backgroundColor),
            viewer: lum(getComputedStyle(document.querySelector('.epub-viewer')).backgroundColor),
        };
    });
}

const isDark = colors => colors.page < 0.2 && colors.viewer < 0.2 && colors.text > 0.8;
const isLight = colors => colors.page > 0.8 && colors.viewer > 0.8 && colors.text < 0.2;

test('E5. the book follows the system appearance (light and dark) unless a theme is picked', async () => {
    const app = await openBook({ dark: true });
    const { page } = app;
    try {
        assert.ok(isDark(await brightness(page)), `dark: ${JSON.stringify(await brightness(page))}`);
        await page.screenshot({ path: join(OUTPUT, 'format-epub-dark.png') });
        await tapAt(page, 0.5);
        await page.waitForSelector('.epub-viewer .sidebar-wrapper:not(.out)', { timeout: 3000 });
        await settle(500);
        await page.screenshot({ path: join(OUTPUT, 'format-epub-contents-dark.png') });
        await page.touchscreen.tap(370, 600);
        await page.waitForSelector('.epub-viewer .sidebar-wrapper.out', { timeout: 3000 });

        // The system turns light while reading, then the book is opened again in light mode.
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
        await waitUntil(async () => isLight(await brightness(page)), 3000).catch(async () => {
            assert.fail(`light: ${JSON.stringify(await brightness(page))}`);
        });
        await page.reload({ waitUntil: 'load' });
        await waitForBook(page);
        assert.ok(isLight(await brightness(page)), `light: ${JSON.stringify(await brightness(page))}`);
        await page.screenshot({ path: join(OUTPUT, 'format-epub-light.png') });

        // A theme picked in the settings stays when the system turns dark.
        await page.click('.epub-viewer .sidebar-button');
        await page.click('.epub-viewer .tab-list .item:nth-child(4)');
        await page.click('.epub-viewer .theme.chip:nth-child(4)');
        await page.screenshot({ path: join(OUTPUT, 'format-epub-settings.png') });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
        await settle(500);
        const sepia = await page.evaluate(() => getComputedStyle(document.querySelector('.epub-viewer iframe').contentDocument.body).backgroundColor);
        assert.equal(sepia, 'rgb(245, 222, 179)');
        // Reset All forgets the choice: the book follows the (now dark) system again.
        await page.click('.epub-viewer .settings .setting-content a');
        await waitUntil(async () => isDark(await brightness(page)), 3000);
        assert.deepEqual(app.errors, [], 'no page errors');
    } finally {
        await app.close();
    }
});

test('E6. iPad: the arrows stay beside the text (nothing cut off), and taps and arrows turn pages', async () => {
    const fake = new FakeNative();
    const id = fake.add('Book.epub', await makeEpub());
    const app = await openApp(fake, { path: viewerPath(id) });
    const { page } = app;
    try {
        await page.setViewport({ width: 820, height: 1180, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
        await page.reload({ waitUntil: 'load' });
        await waitForBook(page);
        assert.equal(await page.$$eval('.epub-viewer .epub-nav', nodes => nodes.filter(node => node.offsetWidth > 0).length), 2, 'arrows shown');
        // The laid-out pages match the reader's width (the arrows did not squeeze it after the layout).
        const fit = await page.evaluate(() => {
            const container = document.querySelector('.epub-viewer .epub-container');
            const doc = container.querySelector('iframe').contentDocument;
            const right = Math.max(...[...doc.querySelectorAll('p')].map(p => p.getBoundingClientRect().right)
                .filter(x => x <= container.clientWidth + 1));
            return { width: container.clientWidth, host: document.querySelector('.epub-viewer .epub-reader-host').clientWidth, right };
        });
        assert.equal(fit.width, fit.host);
        assert.ok(fit.right < fit.width, `text ends inside the reader: ${JSON.stringify(fit)}`);
        await page.screenshot({ path: join(OUTPUT, 'format-epub-ipad.png') });
        await tapAt(page, 0.85);
        await waitForPosition(page, { chapter: 'Chapter One', page: 1 });
        const next = await (await page.$('.epub-viewer .epub-nav.next')).boundingBox();
        await page.touchscreen.tap(next.x + next.width / 2, next.y + next.height / 2);
        await waitUntil(async () => JSON.stringify(await position(page)) !== JSON.stringify({ chapter: 'Chapter One', page: 1 }), 5000);
        await tapAt(page, 0.15);
        await waitForPosition(page, { chapter: 'Chapter One', page: 1 });
        assert.deepEqual(app.errors, [], 'no page errors');
    } finally {
        await app.close();
    }
});
