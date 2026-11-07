// Shared by the app tests: a fake native plugin whose files live in this Node process, and helpers
// that open the app's pages in headless Chrome as an iPhone (touch, 390x844).
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_PATH, REPO_ROOT, pdfLib, startStaticServer } from '../../test/pdf-highlight/harness.mjs';

const puppeteer = createRequire(join(REPO_ROOT, 'package.json'))('puppeteer-core');
const HERE = fileURLToPath(new URL('.', import.meta.url));
// Same folder as build.mjs (ANYFILE_WWW lets parallel runs use their own build).
const WWW = process.env.ANYFILE_WWW || join(HERE, '../www');
export const OUTPUT = process.env.ANYFILE_TEST_OUTPUT || join(HERE, 'output');
const KEY = 'ANYfileLastView';

/* ------------------------------------------------------------ fake native */

export class FakeNative {
    constructor() {
        this.files = new Map();
        this.writes = new Map();
        this.clock = 1000;
        this.opened = null;
        this.endedBackgroundTasks = 0;
        this.commits = 0;
        this.conflicts = 0;
        this.onCommit = null;
        this.nextId = 1;
        this.previews = [];
    }

    add(name, bytes, extra = {}) {
        const id = `file-${this.nextId++}`;
        this.files.set(id, { id, name, bytes: Buffer.from(bytes), modified: ++this.clock, writable: true, added: this.clock, folder: 'iCloud Drive', ...extra });
        return id;
    }

    bytes(id) {
        return this.files.get(id).bytes;
    }

    /** Another app or device changes the file. */
    replace(id, bytes) {
        const file = this.files.get(id);
        file.bytes = Buffer.from(bytes);
        file.modified = ++this.clock;
    }

    entry(file) {
        const { bytes, writable, modified, ...entry } = file;
        return entry;
    }

    async handle(method, options) {
        const file = options.id ? this.files.get(options.id) : null;
        const notFound = () => { throw Object.assign(new Error('This PDF is no longer in your library.'), { code: 'not-found' }); };
        switch (method) {
            case 'listFiles':
                return { files: [...this.files.values()].map(f => this.entry(f)) };
            case 'pickFiles':
                return { files: [], failed: [] };
            case 'previewFile':
                if (!file) notFound();
                this.previews.push(options.id);
                return undefined;
            case 'updateFile':
                if (file) {
                    for (const key of ['lastOpened', 'lastPage', 'pageCount']) {
                        if (options[key] !== undefined) {
                            file[key] = options[key];
                        }
                    }
                }
                return undefined;
            case 'removeFile':
                this.files.delete(options.id);
                return undefined;
            case 'readFile':
                if (!file) notFound();
                return { base64: file.bytes.toString('base64'), name: file.name, modified: file.modified, size: file.bytes.length, writable: file.writable };
            case 'writeBegin': {
                const token = `w${this.clock++}`;
                this.writes.set(token, []);
                return { token };
            }
            case 'writeChunk':
                this.writes.get(options.token).push(Buffer.from(options.data, 'base64'));
                return undefined;
            case 'writeCommit': {
                const parts = this.writes.get(options.token);
                this.writes.delete(options.token);
                if (!file) notFound();
                this.commits++;
                await this.onCommit?.(options.id);
                if (options.expectedModified !== undefined && options.expectedModified !== file.modified) {
                    this.conflicts++;
                    throw Object.assign(new Error('The PDF was changed by another app or device.'), { code: 'conflict' });
                }
                file.bytes = Buffer.concat(parts);
                file.modified = ++this.clock;
                return { modified: file.modified };
            }
            case 'writeAbort':
                this.writes.delete(options.token);
                return undefined;
            case 'takeOpenedFile': {
                const id = this.opened;
                this.opened = null;
                return { id };
            }
            case 'endBackgroundTask':
                this.endedBackgroundTasks++;
                return undefined;
            case 'getTestScript':
                return { script: null };
            default:
                throw new Error(`unknown method ${method}`);
        }
    }
}

export const FAKE_SCRIPT = `(() => {
    const listeners = {};
    const call = async (method, options) => {
        const reply = JSON.parse(await window.__anyfileCall(method, JSON.stringify(options ?? {})));
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply.value;
    };
    const methods = ['pickFiles', 'previewFile', 'listFiles', 'updateFile', 'removeFile', 'writeBegin', 'writeChunk', 'writeCommit',
        'writeAbort', 'takeOpenedFile', 'endBackgroundTask', 'getTestScript'];
    const fake = Object.fromEntries(methods.map(name => [name, options => call(name, options)]));
    fake.readFile = async (options) => {
        const result = await call('readFile', options);
        const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
        const { base64, ...rest } = result;
        // Like the app's private copies, the URL ends with the file's extension (viewers check it).
        return { ...rest, path: URL.createObjectURL(new Blob([bytes])) + '#' + encodeURIComponent(rest.name) };
    };
    fake.addListener = async (event, listener) => {
        (listeners[event] ||= []).push(listener);
        return { remove: async () => { listeners[event] = listeners[event].filter(l => l !== listener); } };
    };
    window.__anyfileEmit = (event) => (listeners[event] || []).forEach(listener => listener({}));
    window.__ANYFILE_FAKE__ = fake;
})();`;

/* ---------------------------------------------------------------- harness */

let server;
let browser;

/** Serves www/ and launches Chrome; call from before(). */
export async function startHarness() {
    await mkdir(OUTPUT, { recursive: true });
    server = await startStaticServer(WWW);
    browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: process.env.PDF_HL_HEADFUL ? false : true,
        args: ['--no-sandbox', '--disable-gpu'],
    });
}
/** Call from after(). */
export async function stopHarness() {
    await browser?.close();
    await server?.close();
}

export async function openApp(fake, { path = 'index.html', storage = {}, dark = false } = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    if (dark) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    }
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__anyfileCall', async (method, json) => {
        try {
            return JSON.stringify({ value: await fake.handle(method, JSON.parse(json)) ?? null });
        } catch (error) {
            return JSON.stringify({ error: { message: error.message, code: error.code } });
        }
    });
    await page.evaluateOnNewDocument(FAKE_SCRIPT);
    await page.evaluateOnNewDocument((entries) => {
        if (!sessionStorage.getItem('seeded')) {
            sessionStorage.setItem('seeded', '1');
            for (const [key, value] of Object.entries(entries)) {
                localStorage.setItem(key, value);
            }
        }
    }, storage);
    await page.goto(`${server.origin}/${path}`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
}

export async function waitForViewer(page, pages) {
    await page.waitForFunction((count) => {
        const app = window.PDFViewerApplication;
        return app?.pdfDocument && app.pagesCount === count && !document.body.classList.contains('anyfile-loading')
            && document.querySelector('.textLayer span');
    }, { timeout: 20000 }, pages);
    // viewstate.js reports the settled position after the initial view (and its re-jump) is final
    await page.waitForFunction(() => window.anyfileHost?.currentPage != null, { timeout: 20000 });
}

export async function storedView(bytes) {
    const doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    const value = info?.lookup(pdfLib.PDFName.of(KEY));
    return value ? JSON.parse(value.decodeText()) : null;
}

export async function highlightAnnotations(bytes) {
    const doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPages().flatMap((page, pageIndex) => {
        const annots = page.node.lookup(pdfLib.PDFName.of('Annots'));
        if (!annots) {
            return [];
        }
        return annots.asArray().map(ref => doc.context.lookup(ref))
            .filter(annot => annot.lookup(pdfLib.PDFName.of('Subtype'))?.asString() === '/Highlight')
            .map(annot => ({ pageIndex, nm: annot.lookup(pdfLib.PDFName.of('NM'))?.decodeText() }));
    });
}

export async function goToPage(page, number) {
    await page.evaluate((n) => { window.PDFViewerApplication.page = n; }, number);
    await page.waitForFunction((n) => window.anyfileHost?.currentPage === n, { timeout: 5000 }, number);
}

export async function waitUntil(check, timeoutMs = 10000) {
    const start = Date.now();
    while (!(await check())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

/** Taps the Library button and waits for the library page (PDF.js's own URL hash updates are not it). */
export async function tapBack(page) {
    const box = await (await page.$('#anyfileBack')).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await waitUntil(() => page.url().endsWith('/index.html'));
    await page.waitForSelector('#open');
}

/** Waits until the host received and saved what the viewer sent (messages and saves are asynchronous). */
export async function waitForCommits(page, fake, count) {
    await waitUntil(() => fake.commits >= count);
    await page.evaluate(() => window.anyfileHost.idle());
}

/** Selects text in the text layer as a long press would (a touch, then a selection). */
export async function touchSelect(page, pageNumber, text) {
    const point = await page.evaluate((number, needle) => {
        const span = [...document.querySelectorAll(`.page[data-page-number="${number}"] .textLayer span`)]
            .find(node => node.textContent.includes(needle));
        const rect = span.getBoundingClientRect();
        return { x: rect.left + 2, y: rect.top + rect.height / 2 };
    }, pageNumber, text);
    // A long press: the page sees a touch begin, then the system takes over and selects (the touch is
    // cancelled, so no tap or click follows that would clear the selection).
    await page.evaluate((number, needle, x, y) => {
        const span = [...document.querySelectorAll(`.page[data-page-number="${number}"] .textLayer span`)]
            .find(node => node.textContent.includes(needle));
        const touch = { bubbles: true, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y };
        span.dispatchEvent(new PointerEvent('pointerdown', touch));
        span.dispatchEvent(new PointerEvent('pointercancel', touch));
        const node = span.firstChild;
        const start = node.textContent.indexOf(needle);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + needle.length);
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
    }, pageNumber, text, point.x, point.y);
}

export async function tapHighlightButton(page) {
    await page.waitForSelector('.office-hl-select-button:not([hidden])', { timeout: 5000 });
    const box = await (await page.$('.office-hl-select-button')).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}
