// The PowerPoint viewer (route "ppt") on the phone: the slide fits the screen and stays sharp, thumbnails
// open in a drawer, swipes and the bottom bar change slides, in portrait and landscape, light and dark.
// Run (from mobile/): node --test test/format-ppt.test.mjs. Screenshots go to test/output/.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FakeNative, OUTPUT, openApp, startHarness, stopHarness, waitUntil } from './harness.mjs';

const mobileRequire = createRequire(import.meta.url);

before(startHarness);
after(stopHarness);

// One background color per slide: the pixel in the slide's corner tells which slide is drawn.
const COLORS = ['DBEAFE', 'FDE68A', 'BBF7D0', 'FBCFE8', 'C7D2FE', 'FED7AA', 'A5F3FC', 'E9D5FF', 'FECACA', 'D9F99D', 'FEF08A', 'BAE6FD'];
const PORTRAIT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function makeDeck(count = 12, layout = 'LAYOUT_16x9') {
    const PptxGenJS = mobileRequire('pptxgenjs');
    const deck = new PptxGenJS();
    deck.layout = layout;
    for (let i = 0; i < count; i++) {
        const slide = deck.addSlide();
        slide.background = { color: COLORS[i % COLORS.length] };
        slide.addText(`Slide ${i + 1}`, { x: 0.5, y: 0.4, w: 9, h: 1.2, fontSize: 40, bold: true, color: '1F2937' });
        slide.addText('Small print stays readable when the slide is zoomed in on the phone.', {
            x: 0.5, y: 2, w: 8, h: 0.6, fontSize: 14, color: '374151',
        });
    }
    return new Uint8Array(await deck.write({ outputType: 'nodebuffer' }));
}

async function openDeck(bytes, { dark = false, count = 12 } = {}) {
    const fake = new FakeNative();
    const id = fake.add('Deck.pptx', bytes);
    const app = await openApp(fake, { path: `react/index.html?id=${id}&route=ppt`, dark });
    await waitForSlide(app.page, 1, count);
    // The loading spinner has faded out (screenshots)
    await app.page.waitForFunction(() => [...document.querySelectorAll('.ant-spin-fullscreen')]
        .every(node => getComputedStyle(node).visibility === 'hidden'), { timeout: 5000 });
    return { ...app, fake, count };
}

async function assertNoErrors(app) {
    assert.equal(await app.page.$eval('#anyfileError', node => node.hidden), true, 'no error overlay');
    assert.deepEqual(app.errors, [], 'no page errors');
}

/** The color drawn near the slide's bottom-left corner (where no text is), as RRGGBB. */
function cornerColor(page) {
    return page.evaluate(() => {
        const canvas = document.getElementById('ppt-canvas');
        const [r, g, b] = canvas.getContext('2d')
            .getImageData(Math.round(canvas.width * 0.03), Math.round(canvas.height * 0.95), 1, 1).data;
        return [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    });
}

function sameColor(a, b) {
    return [0, 2, 4].every(i => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 3);
}

function counter(page) {
    return page.$eval('.ppt-bar-counter', node => node.textContent);
}

/** Waits until the counter says `n / count` and slide n is the one drawn. */
async function waitForSlide(page, n, count = 12) {
    await page.waitForFunction((text) => document.querySelector('.ppt-bar-counter')?.textContent === text,
        { timeout: 20000 }, `${n} / ${count}`);
    await waitUntil(async () => sameColor(await cornerColor(page), COLORS[(n - 1) % COLORS.length]), 10000);
}

function layout(page) {
    return page.evaluate(() => {
        const rect = (node) => {
            if (!node) {
                return null;
            }
            const r = node.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const canvas = document.getElementById('ppt-canvas');
        const wrap = document.querySelector('.ppt-main-canvas');
        const drawer = document.querySelector('.ppt-drawer');
        return {
            dpr: window.devicePixelRatio,
            root: rect(document.getElementById('root')),
            viewer: rect(document.querySelector('.ppt-viewer')),
            wrap: rect(wrap),
            wrapSize: { width: wrap.clientWidth, height: wrap.clientHeight },
            canvas: rect(canvas),
            canvasStyle: { width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) },
            backing: { width: canvas.width, height: canvas.height },
            bar: rect(document.querySelector('.ppt-mobile-bar')),
            controls: ['.ppt-bar-slides', '.ppt-bar-prev', '.ppt-bar-counter', '.ppt-bar-next', '.color-mode-toggle']
                .map(selector => ({ selector, ...rect(document.querySelector(selector)) })),
            drawer: rect(drawer),
            drawerVisible: getComputedStyle(drawer).visibility === 'visible',
            siders: document.querySelectorAll('.ant-layout-sider').length,
            statusbars: document.querySelectorAll('.ppt-statusbar').length,
        };
    });
}

function inside(inner, outer, name) {
    assert.ok(inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
        && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5,
    `${name} ${JSON.stringify(inner)} is inside ${JSON.stringify(outer)}`);
}

function overlaps(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The slide fits (fills the width or the height), is centered and drawn at the screen's resolution. */
function assertFitted(state, viewport) {
    assert.equal(state.root.bottom, viewport.height, '#root reaches the bottom of the screen, no further');
    inside(state.viewer, state.root, 'viewer');
    inside(state.canvas, state.wrap, 'slide');
    const freeWidth = state.wrapSize.width - 16;
    const freeHeight = state.wrapSize.height - 16;
    // Whole pixels the renderer covers exactly: at most a couple of pixels under the free space
    assert.ok(Math.abs(state.canvasStyle.width - freeWidth) <= 3 || Math.abs(state.canvasStyle.height - freeHeight) <= 3,
        `slide fills the width or height: ${JSON.stringify(state.canvasStyle)} in ${JSON.stringify(state.wrapSize)}`);
    assert.ok(state.canvasStyle.width <= freeWidth && state.canvasStyle.height <= freeHeight, 'slide fits');
    const left = state.canvas.left - state.wrap.left;
    const right = state.wrap.right - state.canvas.right;
    const top = state.canvas.top - state.wrap.top;
    const bottom = state.wrap.bottom - state.canvas.bottom;
    assert.ok(Math.abs(left - right) <= 1 && Math.abs(top - bottom) <= 1, `slide centered: ${left} ${right} ${top} ${bottom}`);
    assert.equal(state.backing.width, Math.round(state.canvasStyle.width * state.dpr), 'drawn at device resolution (width)');
    assert.equal(state.backing.height, Math.round(state.canvasStyle.height * state.dpr), 'drawn at device resolution (height)');
}

/** The slide's background reaches every edge of the canvas (no blank line where the canvas shows through). */
async function assertNoBlankEdge(page) {
    const edges = await page.evaluate(() => {
        const canvas = document.getElementById('ppt-canvas');
        const ctx = canvas.getContext('2d');
        const alphas = (x, y, w, h) => [...ctx.getImageData(x, y, w, h).data].filter((_, i) => i % 4 === 3);
        const lowest = values => Math.min(...values);
        return {
            left: lowest(alphas(0, 0, 1, canvas.height)),
            right: lowest(alphas(canvas.width - 1, 0, 1, canvas.height)),
            top: lowest(alphas(0, 0, canvas.width, 1)),
            bottom: lowest(alphas(0, canvas.height - 1, canvas.width, 1)),
        };
    });
    assert.deepEqual(edges, { left: 255, right: 255, top: 255, bottom: 255 }, 'slide drawn up to every edge');
}

/** The bar's controls are inside #root, at least 44px tall, and none overlaps another. */
function assertControls(state) {
    inside(state.bar, state.root, 'bottom bar');
    for (const control of state.controls) {
        inside(control, state.bar, control.selector);
        if (control.selector !== '.ppt-bar-counter') {
            assert.ok(control.width >= 44 && control.height >= 44, `${control.selector} is tap-friendly`);
        }
    }
    for (let i = 0; i < state.controls.length; i++) {
        for (let j = i + 1; j < state.controls.length; j++) {
            assert.ok(!overlaps(state.controls[i], state.controls[j]), `${state.controls[i].selector} and ${state.controls[j].selector} do not overlap`);
        }
    }
    assert.ok(!overlaps(state.bar, state.canvas), 'the bar does not cover the slide');
}

async function swipe(page, fromX, toX, y, { steps = 6, dy = 0 } = {}) {
    await page.touchscreen.touchStart(fromX, y);
    for (let i = 1; i <= steps; i++) {
        await page.touchscreen.touchMove(fromX + (toX - fromX) * i / steps, y + dy * i / steps);
    }
    await page.touchscreen.touchEnd();
}

async function tap(page, selector) {
    const box = await (await page.$(selector)).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function slideCenter(page) {
    const box = await (await page.$('#ppt-canvas')).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function drawerOpen(page) {
    return page.evaluate(() => {
        const drawer = document.querySelector('.ppt-drawer');
        return getComputedStyle(drawer).visibility === 'visible' && drawer.getBoundingClientRect().left >= -0.5;
    });
}

async function waitForDrawer(page, open) {
    await waitUntil(async () => (await drawerOpen(page)) === open, 3000);
    await new Promise(resolve => setTimeout(resolve, 300)); // let the slide-in finish for screenshots
}

test('P1. the slide fills the phone\'s width, sharp and centered; no thumbnail sidebar', async () => {
    const app = await openDeck(await makeDeck());
    try {
        const state = await layout(app.page);
        assertFitted(state, PORTRAIT);
        assert.ok(state.wrapSize.width - 16 - state.canvasStyle.width <= 2, 'fills the width (8px margins)');
        await assertNoBlankEdge(app.page);
        assert.equal(state.siders, 0, 'no thumbnail sidebar');
        assert.equal(state.statusbars, 0, 'the bar replaces the status line');
        assert.equal(state.drawerVisible, false, 'thumbnails hidden by default');
        assert.ok(state.drawer.right <= 0.5, 'drawer off screen');
        assertControls(state);
        assert.equal(await counter(app.page), '1 / 12');
        assert.equal(await app.page.$eval('.ppt-bar-prev', node => node.disabled), true, 'no previous slide');
        await app.page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 12, { timeout: 20000 });
        await assertNoErrors(app);
        await app.page.screenshot({ path: join(OUTPUT, 'ppt-portrait-light.png') });
    } finally {
        await app.close();
    }
});

test('P2. swipes and the previous/next buttons change slides', async () => {
    const app = await openDeck(await makeDeck());
    const { page } = app;
    try {
        const { x, y, box } = await slideCenter(page);
        await swipe(page, x + 120, x - 120, y);
        await waitForSlide(page, 2);
        await swipe(page, x + 120, x - 120, y);
        await waitForSlide(page, 3);
        await swipe(page, x - 120, x + 120, y);
        await waitForSlide(page, 2);

        // A quick flick is enough; a vertical drag or a short slow drag is not a swipe
        await swipe(page, x + 20, x - 20, y, { steps: 2 });
        await waitForSlide(page, 3);
        await swipe(page, x, x + 10, box.y + 10, { dy: box.height - 20 });
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(await counter(page), '3 / 12');
        assert.equal(await page.$eval('#ppt-canvas', node => node.style.transform), '', 'the slide snapped back');

        await tap(page, '.ppt-bar-next');
        await waitForSlide(page, 4);
        await tap(page, '.ppt-bar-prev');
        await waitForSlide(page, 3);
        await tap(page, '.ppt-bar-prev');
        await tap(page, '.ppt-bar-prev');
        await waitForSlide(page, 1);

        // Nothing before the first slide
        await swipe(page, x - 120, x + 120, y);
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(await counter(page), '1 / 12');
        assert.equal(await page.$eval('#ppt-canvas', node => node.style.transform), '');

        // Arrow keys still work (iPad keyboards)
        await page.keyboard.press('ArrowRight');
        await waitForSlide(page, 2);

        // Changing slides while the thumbnails are still being made keeps the slide chosen
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 12, { timeout: 20000 });
        await waitForSlide(page, 2);
        assertFitted(await layout(page), PORTRAIT);
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('P3. the thumbnails drawer: open, tap a slide to go there, tap outside to close', async () => {
    const app = await openDeck(await makeDeck());
    const { page } = app;
    try {
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 12, { timeout: 20000 });
        await tap(page, '.ppt-bar-slides');
        await waitForDrawer(page, true);
        const state = await layout(page);
        inside(state.drawer, state.root, 'drawer');
        await page.screenshot({ path: join(OUTPUT, 'ppt-drawer-light.png') });

        // Thumbnails are sharp and in the slide's shape
        const thumb = await page.$eval('.ppt-thumb img', img => ({ width: img.naturalWidth, height: img.naturalHeight, shown: img.getBoundingClientRect().width }));
        assert.ok(thumb.width >= thumb.shown * 1.5, `thumbnail drawn for the retina screen: ${JSON.stringify(thumb)}`);
        assert.ok(Math.abs(thumb.width / thumb.height - 16 / 9) < 0.02);

        await page.$eval('.ppt-thumb:nth-child(7)', node => node.scrollIntoView({ block: 'center' }));
        await tap(page, '.ppt-thumb:nth-child(7)');
        await waitForSlide(page, 7);
        await waitForDrawer(page, false);

        // Reopened, the current slide is highlighted and in view; tapping outside closes it
        await tap(page, '.ppt-bar-slides');
        await waitForDrawer(page, true);
        const active = await page.evaluate(() => {
            const node = document.querySelector('.ppt-thumb.is-active');
            const list = document.querySelector('.ppt-drawer .ppt-thumbnails-list').getBoundingClientRect();
            const r = node.getBoundingClientRect();
            return { number: node.querySelector('.ppt-thumb-num').textContent, visible: r.top >= list.top && r.bottom <= list.bottom };
        });
        assert.deepEqual(active, { number: '7', visible: true });
        await page.touchscreen.tap(370, 400);
        await waitForDrawer(page, false);
        assert.equal(await counter(page), '7 / 12', 'closing does not change the slide');

        // The close button closes it too
        await tap(page, '.ppt-bar-slides');
        await waitForDrawer(page, true);
        await tap(page, '.ppt-drawer .ppt-bar-button');
        await waitForDrawer(page, false);
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('P4. landscape: the slide fits the height, controls stay usable', async () => {
    const app = await openDeck(await makeDeck());
    const { page } = app;
    try {
        await page.setViewport(LANDSCAPE);
        await waitUntil(async () => {
            const state = await layout(page);
            return Math.abs(state.canvasStyle.height - (state.wrapSize.height - 16)) <= 3
                && state.backing.width === Math.round(state.canvasStyle.width * state.dpr);
        });
        const state = await layout(page);
        assertFitted(state, LANDSCAPE);
        assertControls(state);
        await waitForSlide(page, 1);
        await assertNoBlankEdge(page);

        const { x, y } = await slideCenter(page);
        await swipe(page, x + 150, x - 150, y);
        await waitForSlide(page, 2);
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 12, { timeout: 20000 });
        await page.screenshot({ path: join(OUTPUT, 'ppt-landscape-light.png') });

        await tap(page, '.ppt-bar-slides');
        await waitForDrawer(page, true);
        inside((await layout(page)).drawer, state.root, 'drawer');
        await page.screenshot({ path: join(OUTPUT, 'ppt-landscape-drawer-light.png') });
        await page.touchscreen.tap(700, 200);
        await waitForDrawer(page, false);

        // Back to portrait: drawn again at the new size
        await page.setViewport(PORTRAIT);
        await waitUntil(async () => {
            const s = await layout(page);
            const gap = s.wrapSize.width - 16 - s.canvasStyle.width;
            return gap >= 0 && gap <= 2 && s.backing.width === Math.round(s.canvasStyle.width * s.dpr);
        });
        assertFitted(await layout(page), PORTRAIT);
        await waitForSlide(page, 2);
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('P5. dark mode: the viewer opens dark with the system, the toggle sits in the bar, portrait and landscape', async () => {
    const app = await openDeck(await makeDeck(), { dark: true });
    const { page } = app;
    try {
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 12, { timeout: 20000 });
        // No choice saved yet: it follows the system's dark mode (react-bridge's getState)
        await page.waitForFunction(() => document.body.classList.contains('office-dark'));
        await page.screenshot({ path: join(OUTPUT, 'ppt-portrait-system-dark.png') });
        await new Promise(resolve => setTimeout(resolve, 600)); // the tap highlight fades
        const background = await page.$eval('.ppt-viewer', node => getComputedStyle(node).backgroundColor);
        assert.equal(background, 'rgb(0, 0, 0)');
        assertControls(await layout(page));
        await page.screenshot({ path: join(OUTPUT, 'ppt-portrait-dark.png') });

        await tap(page, '.ppt-bar-slides');
        await waitForDrawer(page, true);
        await page.screenshot({ path: join(OUTPUT, 'ppt-drawer-dark.png') });
        await tap(page, '.ppt-drawer .ppt-bar-button');
        await waitForDrawer(page, false);

        await page.setViewport(LANDSCAPE);
        await waitUntil(async () => {
            const s = await layout(page);
            return Math.abs(s.canvasStyle.height - (s.wrapSize.height - 16)) <= 3;
        });
        await waitForSlide(page, 1);
        const state = await layout(page);
        assertFitted(state, LANDSCAPE);
        assertControls(state);
        await page.screenshot({ path: join(OUTPUT, 'ppt-landscape-dark.png') });

        // The toggle still switches to light, and that choice wins over the system from then on
        await tap(page, '.color-mode-toggle');
        await page.waitForFunction(() => !document.body.classList.contains('office-dark'));
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 12, { timeout: 20000 });
        assert.equal(await page.evaluate(() => document.body.classList.contains('office-dark')), false, 'the light choice is kept');
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('P6. double-tap zooms in and the zoomed slide is drawn again with more pixels; double-tap zooms out', async () => {
    const app = await openDeck(await makeDeck());
    const { page } = app;
    try {
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 12, { timeout: 20000 });
        const { x, y } = await slideCenter(page);
        await page.touchscreen.tap(x - 100, y - 40);
        await page.touchscreen.tap(x - 100, y - 40);
        await page.waitForFunction(() => document.querySelector('.ppt-canvas-stage').style.transform.includes('scale(2.5)'), { timeout: 3000 });
        await waitUntil(async () => {
            const s = await layout(page);
            return s.backing.width === Math.round(s.canvasStyle.width * s.dpr * 2.5);
        });
        await waitForSlide(page, 1);
        await page.screenshot({ path: join(OUTPUT, 'ppt-zoomed.png') });

        // While zoomed, one finger pans instead of changing slides
        await swipe(page, x + 100, x - 100, y);
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(await counter(page), '1 / 12');
        assert.match(await page.$eval('.ppt-canvas-stage', node => node.style.transform), /translate\(-?[\d.]+px/);

        await page.touchscreen.tap(x, y);
        await page.touchscreen.tap(x, y);
        await page.waitForFunction(() => !document.querySelector('.ppt-canvas-stage').style.transform, { timeout: 3000 });
        await waitUntil(async () => {
            const s = await layout(page);
            return s.backing.width === Math.round(s.canvasStyle.width * s.dpr);
        });

        // A new slide always starts unzoomed
        await page.touchscreen.tap(x, y);
        await page.touchscreen.tap(x, y);
        await page.waitForFunction(() => document.querySelector('.ppt-canvas-stage').style.transform.includes('scale'), { timeout: 3000 });
        await tap(page, '.ppt-bar-next');
        await waitForSlide(page, 2);
        await page.waitForFunction(() => !document.querySelector('.ppt-canvas-stage').style.transform, { timeout: 3000 });
        await new Promise(resolve => setTimeout(resolve, 400));
        assertFitted(await layout(page), PORTRAIT);
        await assertNoErrors(app);
    } finally {
        await app.close();
    }
});

test('P7. a 4:3 deck keeps its shape (slide and thumbnails)', async () => {
    const app = await openDeck(await makeDeck(3, 'LAYOUT_4x3'), { count: 3 });
    const { page } = app;
    try {
        const state = await layout(page);
        assertFitted(state, PORTRAIT);
        assert.ok(Math.abs(state.canvasStyle.width / state.canvasStyle.height - 4 / 3) < 0.02, JSON.stringify(state.canvasStyle));
        await assertNoBlankEdge(page);
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 3, { timeout: 20000 });
        const thumb = await page.$eval('.ppt-thumb img', img => img.naturalWidth / img.naturalHeight);
        assert.ok(Math.abs(thumb - 4 / 3) < 0.02);
        assert.equal(await page.$eval('.ppt-bar-next', node => node.disabled), false);
        await tap(page, '.ppt-bar-next');
        await tap(page, '.ppt-bar-next');
        await waitForSlide(page, 3, 3);
        assert.equal(await page.$eval('.ppt-bar-next', node => node.disabled), true, 'no next slide');
        await assertNoErrors(app);
        await page.screenshot({ path: join(OUTPUT, 'ppt-4x3.png') });
    } finally {
        await app.close();
    }
});

test('P8. outside the app (VS Code) the viewer keeps its desktop layout', async () => {
    const fake = new FakeNative();
    const id = fake.add('Deck.pptx', await makeDeck(3));
    // Before the app's scripts run: no `mobile` in the config, no anyfile-* body classes (as in VS Code).
    const app = await openApp(fake, { path: 'index.html' });
    const { page } = app;
    try {
        await page.evaluateOnNewDocument(() => {
            const setAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function (name, value) {
                if (this.id === 'office-configs' && name === 'data-config') {
                    const config = JSON.parse(value);
                    delete config.mobile;
                    value = JSON.stringify(config);
                }
                return setAttribute.call(this, name, value);
            };
            const add = DOMTokenList.prototype.add;
            DOMTokenList.prototype.add = function (...tokens) {
                return add.apply(this, tokens.filter(token => !String(token).startsWith('anyfile-')));
            };
        });
        await page.setViewport({ width: 1200, height: 800 });
        await page.goto(page.url().replace(/index\.html.*$/, `react/index.html?id=${id}&route=ppt`), { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelector('.ppt-statusbar')?.textContent === 'Slide 1 / 3', { timeout: 20000 });
        await page.evaluate(() => document.getElementById('anyfileBar')?.remove());
        await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 3, { timeout: 20000 });
        const state = await page.evaluate(() => {
            const canvas = document.getElementById('ppt-canvas');
            const wrap = document.querySelector('.ppt-main-canvas');
            const toggle = getComputedStyle(document.querySelector('.color-mode-toggle'));
            return {
                classes: document.body.className,
                sider: document.querySelector('.ant-layout-sider')?.getBoundingClientRect().width,
                mobileBar: !!document.querySelector('.ppt-mobile-bar'),
                drawer: !!document.querySelector('.ppt-drawer'),
                toggle: { position: toggle.position, right: toggle.right, bottom: toggle.bottom },
                canvas: { width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) },
                wrap: { width: wrap.clientWidth, height: wrap.clientHeight },
            };
        });
        assert.doesNotMatch(state.classes, /anyfile/);
        assert.equal(state.sider, 220, 'thumbnail sidebar');
        assert.equal(state.mobileBar, false);
        assert.equal(state.drawer, false);
        assert.deepEqual(state.toggle, { position: 'fixed', right: '18px', bottom: '36px' });
        assert.deepEqual(state.canvas, state.wrap, 'the canvas fills the slide area');
        // (pptxviewjs re-renders the first slide 200ms after loading; a key pressed before that is overdrawn)
        await new Promise(resolve => setTimeout(resolve, 400));
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('.ppt-statusbar')?.textContent === 'Slide 2 / 3', { timeout: 5000 });
        assert.deepEqual(app.errors, []);
        await new Promise(resolve => setTimeout(resolve, 400)); // spinner and highlight transitions
        await page.screenshot({ path: join(OUTPUT, 'ppt-desktop.png') });
    } finally {
        await app.close();
    }
});
