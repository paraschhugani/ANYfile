// Scripted runs for testing the app in the iOS Simulator. Only debug builds return a script (from the
// -anyfileTest launch argument); results are logged as "ANYFILE-TEST ..." lines.
// Commands, separated by ';':  page:N  wait:MS  highlight:TEXT  back  report
import type { ViewerHost } from './host';

function log(message: string) {
    console.log(`ANYFILE-TEST ${message}`);
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 10000) {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out');
        }
        await delay(100);
    }
}

/** Selects TEXT on the current page like a long press would, then taps the touch Highlight button. */
async function highlight(text: string) {
    const app = window.PDFViewerApplication;
    const page = document.querySelector(`.page[data-page-number="${app.page}"] .textLayer`);
    await waitFor(() => !!document.querySelector(`.page[data-page-number="${app.page}"] .textLayer span`));
    const span = [...(page?.querySelectorAll('span') ?? [])].find(node => node.textContent?.includes(text));
    const textNode = span?.firstChild;
    if (!span || !textNode?.textContent) {
        throw new Error(`text not found: ${text}`);
    }
    const start = textNode.textContent.indexOf(text);
    // The page sees a touch first (as with a long press), then the selection.
    span.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true }));
    span.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch', isPrimary: true }));
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + text.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await waitFor(() => !!document.querySelector('.office-hl-select-button:not([hidden])'), 3000);
    (document.querySelector('.office-hl-select-button') as HTMLButtonElement).click();
}

export async function runTestScript(script: string, host: ViewerHost) {
    const app = window.PDFViewerApplication;
    try {
        await waitFor(() => !!app.pdfDocument && app.pagesCount > 0 && document.querySelector('.textLayer span') !== null, 20000);
        log(`opened pages=${app.pagesCount} page=${app.page}`);
        for (const command of script.split(';').map(part => part.trim()).filter(Boolean)) {
            const [name, ...rest] = command.split(':');
            const argument = rest.join(':');
            if (name === 'page') {
                app.page = Number(argument);
                await delay(300);
            } else if (name === 'wait') {
                await delay(Number(argument));
            } else if (name === 'highlight') {
                await highlight(argument);
            } else if (name === 'back') {
                (document.getElementById('anyfileBack') as HTMLButtonElement).click();
            } else if (name === 'report') {
                log(`page=${app.page} hostPage=${host.currentPage}`);
            }
            log(`done ${command}`);
        }
    } catch (error) {
        log(`error ${error instanceof Error ? error.message : String(error)}`);
    }
}
