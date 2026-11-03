// Reusable harness for the PDF viewer webview (resource/pdf) in headless Chrome.
//
// - startStaticServer(): serves resource/ over http; pdf/viewer.html gets {{baseUrl}} filled in
//   on the fly (the real file is never modified).
// - openViewer(): launches Chrome via puppeteer-core with a mock acquireVsCodeApi that records
//   every webview -> extension message. By default it answers 'init' like the extension does
//   (an 'open' with the PDF bytes, then 'pdfHighlightConfig'); pass onMessage to plug in a real
//   extension-side implementation instead.
// - makeTextPdf(): pdf-lib generated PDFs with a real text layer (StandardFonts.Helvetica).
//
// Usage: see webview.test.mjs. Set PDF_HL_HEADFUL=1 to watch, CHROME_PATH to override Chrome.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const pdfLib = require('pdf-lib');

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const RESOURCE_ROOT = join(REPO_ROOT, 'resource');
export const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export { pdfLib };

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.properties': 'text/plain; charset=utf-8',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.pdf': 'application/pdf',
};

export async function startStaticServer(root = RESOURCE_ROOT) {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
            const file = join(root, relative);
            if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
                res.writeHead(403).end();
                return;
            }
            let body = await readFile(file);
            if (relative === join('pdf', 'viewer.html')) {
                const { port } = server.address();
                body = Buffer.from(body.toString('utf8').replaceAll('{{baseUrl}}', `http://127.0.0.1:${port}/pdf`));
            }
            res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            res.end(body);
        } catch {
            res.writeHead(404).end();
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        port,
        origin: `http://127.0.0.1:${port}`,
        viewerUrl: `http://127.0.0.1:${port}/pdf/viewer.html`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

export const DEFAULT_LINES = [
    'The quick brown fox jumps over the lazy dog.',
    'Second line of sample text for highlighting.',
    'Third line closes the first paragraph here.',
];

// pages: array of { lines?: string[], highlights?: [{ quads: [[x1,y1,x2,y2]...], color? }] }.
// Text is drawn at x=72, first baseline y=700, 20pt line spacing, Helvetica 14pt.
// Pre-existing highlights are written as plain /Highlight annotations (no /T, no /Contents).
export async function makeTextPdf({ pages = [{}, {}], fontSize = 14, withId = false } = {}) {
    const { PDFDocument, StandardFonts, PDFName, PDFString, PDFHexString } = pdfLib;
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const layout = [];
    pages.forEach((spec, pageIndex) => {
        const page = doc.addPage([612, 792]);
        const lines = spec.lines || DEFAULT_LINES.map((line) => `${line} [p${pageIndex + 1}]`);
        const placed = lines.map((text, i) => {
            const y = 700 - i * 20;
            page.drawText(text, { x: 72, y, size: fontSize, font });
            return { text, x: 72, baseline: y };
        });
        layout.push(placed);
        for (const highlight of spec.highlights || []) {
            const quads = highlight.quads;
            const xs = quads.flatMap(([x1, , x2]) => [x1, x2]);
            const ys = quads.flatMap(([, y1, , y2]) => [y1, y2]);
            const rect = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
            const annot = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Highlight',
                Rect: rect,
                QuadPoints: quads.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]),
                C: highlight.color || [1, 0.894, 0.361],
                F: 4,
                NM: PDFString.of(highlight.id || `fixture-${pageIndex}`),
            });
            const ref = doc.context.register(annot);
            const existing = page.node.lookup(PDFName.of('Annots'));
            if (existing) {
                existing.push(ref);
            } else {
                page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
            }
        }
    });
    if (withId) {
        const id = PDFHexString.of('00112233445566778899aabbccddeeff');
        doc.context.trailerInfo.ID = doc.context.obj([id, id]);
    }
    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, layout, font, fontSize };
}

// Expected PDF-space box of `substring` within a placed line (Helvetica metrics from pdf-lib).
export function expectedTextBox({ font, fontSize }, line, substring) {
    const start = line.text.indexOf(substring);
    if (start < 0) {
        throw new Error(`"${substring}" not in "${line.text}"`);
    }
    const x1 = line.x + font.widthOfTextAtSize(line.text.slice(0, start), fontSize);
    const x2 = x1 + font.widthOfTextAtSize(substring, fontSize);
    return { x1, x2, baseline: line.baseline, top: line.baseline + font.heightAtSize(fontSize, { descender: false }) };
}

function mockVsCodeApiScript(initialStorage) {
    // Runs in the page before any viewer script.
    return `(() => {
        const initialStorage = ${JSON.stringify(initialStorage || {})};
        try {
            if (!sessionStorage.getItem('__vsoStorageSeeded')) {
                for (const [key, value] of Object.entries(initialStorage)) {
                    if (value === null) localStorage.removeItem(key);
                    else localStorage.setItem(key, value);
                }
                sessionStorage.setItem('__vsoStorageSeeded', '1');
            }
        } catch (e) {}
        window.__vsoMessages = [];
        window.acquireVsCodeApi = () => ({
            postMessage(message) {
                const copy = JSON.parse(JSON.stringify(message));
                window.__vsoMessages.push(copy);
                if (typeof window.__vsoHostReceive === 'function') {
                    window.__vsoHostReceive(copy).catch(() => {});
                }
            },
            getState() { return undefined; },
            setState() {},
        });
        window.__vsoPost = (type, content, bufferBase64) => {
            if (bufferBase64 != null) {
                const binary = atob(bufferBase64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                content = Object.assign({}, content, { buffer: bytes });
            }
            window.postMessage({ type, content }, '*');
        };
    })();`;
}

// Options:
//   pdfBytes       Uint8Array sent with 'open' on 'init' (default handler)
//   config         content of 'pdfHighlightConfig' sent after 'open'; null => never sent
//   onMessage      async (message, viewer) => boolean; return true to suppress the default handling
//   localStorage   { key: value | null } seeded before the first load (null removes the key)
//   viewport       puppeteer viewport (default 1200x900, deviceScaleFactor 1)
export async function openViewer({
    pdfBytes,
    config = { writable: true },
    onMessage,
    localStorage: initialStorage = {},
    viewport = { width: 1200, height: 900, deviceScaleFactor: 1 },
    server: existingServer,
} = {}) {
    const server = existingServer || await startStaticServer();
    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: process.env.PDF_HL_HEADFUL ? false : true,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--font-render-hinting=none'],
    });
    const page = await browser.newPage();
    await page.setViewport(viewport);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('console', (message) => {
        if (message.type() === 'error' && process.env.PDF_HL_VERBOSE) {
            console.error('[page]', message.text());
        }
    });

    const viewer = {
        browser,
        page,
        server,
        pageErrors,
        // webview -> extension messages, as received by the host side
        hostMessages: [],
        async post(type, content = {}) {
            let base64 = null;
            if (content && content.buffer instanceof Uint8Array) {
                base64 = Buffer.from(content.buffer).toString('base64');
                const { buffer, ...rest } = content;
                content = rest;
            }
            await page.evaluate((t, c, b) => window.__vsoPost(t, c, b), type, content, base64);
        },
        async messages(type) {
            const all = await page.evaluate(() => window.__vsoMessages.slice());
            return type ? all.filter((message) => message.type === type) : all;
        },
        async clearMessages() {
            await page.evaluate(() => { window.__vsoMessages.length = 0; });
        },
        async waitForMessage(type, predicate = () => true, timeout = 5000) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const found = (await viewer.messages(type)).find((message) => predicate(message.content));
                if (found) {
                    return found;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`Timed out waiting for message "${type}"`);
        },
        async waitForInitialized() {
            await page.waitForFunction(() => window.PDFViewerApplication && PDFViewerApplication.initialized === true, { timeout: 15000 });
        },
        async waitForTextLayer(pageNumber = 1, timeout = 15000) {
            await page.waitForSelector(`.page[data-page-number="${pageNumber}"] .textLayer .endOfContent`, { timeout });
        },
        // Resolves after the next 'textlayerrendered' for pageNumber (call before triggering a redraw).
        async armTextLayerRendered(pageNumber = 1) {
            await page.evaluate((n) => {
                window.__vsoTextLayerRendered = window.__vsoTextLayerRendered || {};
                window.__vsoTextLayerRendered[n] = new Promise((resolve) => {
                    const listener = (event) => {
                        if (event.pageNumber === n) {
                            PDFViewerApplication.eventBus.off('textlayerrendered', listener);
                            resolve();
                        }
                    };
                    PDFViewerApplication.eventBus.on('textlayerrendered', listener);
                });
            }, pageNumber);
            return () => page.evaluate((n) => window.__vsoTextLayerRendered[n], pageNumber);
        },
        async close() {
            await browser.close();
            if (!existingServer) {
                await server.close();
            }
        },
    };

    await page.exposeFunction('__vsoHostReceive', async (message) => {
        viewer.hostMessages.push(message);
        if (onMessage && await onMessage(message, viewer)) {
            return;
        }
        if (message.type === 'init') {
            // main.js opens the document as soon as 'open' arrives; the real extension host
            // round trip is slow enough for PDF.js to finish initializing, this one is not.
            await viewer.waitForInitialized();
            if (pdfBytes) {
                await viewer.post('open', { buffer: pdfBytes });
            }
            if (config) {
                await viewer.post('pdfHighlightConfig', config);
            }
        }
    });
    await page.evaluateOnNewDocument(mockVsCodeApiScript(initialStorage));
    await page.goto(server.viewerUrl, { waitUntil: 'load' });
    return viewer;
}

// In-page helpers (pass to page.evaluate). Selects `startText`..`endText` within the text layer
// of the given pages and replays the pointer gesture highlight.js listens to.
export async function selectText(page, { pageNumber = 1, startText, endText = startText, endPageNumber = pageNumber, pointer = true }) {
    return page.evaluate(async ({ pageNumber, startText, endText, endPageNumber, pointer }) => {
        const findNode = (number, text, fromEnd) => {
            const spans = [...document.querySelectorAll(`.page[data-page-number="${number}"] .textLayer span`)];
            for (const span of spans) {
                const node = [...span.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.data.includes(text));
                if (node) {
                    const index = node.data.indexOf(text);
                    return { node, span, offset: fromEnd ? index + text.length : index };
                }
            }
            throw new Error(`text "${text}" not found on page ${number}`);
        };
        const start = findNode(pageNumber, startText, false);
        const end = findNode(endPageNumber, endText, true);
        const startRect = start.span.getBoundingClientRect();
        const endRect = end.span.getBoundingClientRect();
        const init = (x, y) => ({ bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y });
        if (pointer) {
            start.span.dispatchEvent(new PointerEvent('pointerdown', init(startRect.left + 1, startRect.top + 1)));
        }
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (pointer) {
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            end.span.dispatchEvent(new PointerEvent('pointerup', { ...init(endRect.right - 1, endRect.bottom - 1), buttons: 0 }));
            await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return selection.toString();
    }, { pageNumber, startText, endText, endPageNumber, pointer });
}

// Client rect (CSS px) of a substring of a text-layer span.
export async function textClientRect(page, pageNumber, text) {
    return page.evaluate((n, t) => {
        for (const span of document.querySelectorAll(`.page[data-page-number="${n}"] .textLayer span`)) {
            const node = [...span.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.data.includes(t));
            if (node) {
                const range = document.createRange();
                const index = node.data.indexOf(t);
                range.setStart(node, index);
                range.setEnd(node, index + t.length);
                const r = range.getBoundingClientRect();
                return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
            }
        }
        return null;
    }, pageNumber, text);
}

export async function overlayRects(page, pageNumber = 1) {
    return page.evaluate((n) => [...document.querySelectorAll(`.page[data-page-number="${n}"] .office-hl-layer .office-hl-quad`)].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, color: el.style.backgroundColor };
    }), pageNumber);
}

// PDF user-space point on a page -> client CSS px.
export async function pdfToClient(page, pageNumber, x, y) {
    return page.evaluate((n, px, py) => {
        const pageView = PDFViewerApplication.pdfViewer.getPageView(n - 1);
        const [vx, vy] = pageView.viewport.convertToViewportPoint(px, py);
        const div = pageView.div;
        const rect = div.getBoundingClientRect();
        return [rect.left + div.clientLeft + vx, rect.top + div.clientTop + vy];
    }, pageNumber, x, y);
}

// RGB of the screen pixel at client CSS px (x, y) (deviceScaleFactor 1 viewports).
export async function pixelAt(page, x, y) {
    const data = await page.screenshot({ clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 3, height: 3 }, encoding: 'base64' });
    return page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const pixel = context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
        return [pixel[0], pixel[1], pixel[2]];
    }, data);
}

export async function scrollPageIntoView(page, pageNumber, offsetTop = 0) {
    await page.evaluate((n, top) => {
        PDFViewerApplication.pdfViewer.scrollPageIntoView({ pageNumber: n, destArray: [null, { name: 'XYZ' }, 0, top, null] });
    }, pageNumber, offsetTop);
}
