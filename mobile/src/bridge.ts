// Loaded by pdf/viewer.html in place of resource/lib/vscode.js: provides the same `vscodeEvent` bridge,
// but the "extension" on the other end is ViewerHost, running in this page and saving through the
// native plugin. Also adds what a phone needs: a way back to the library, saving when the app leaves
// the screen, pinch to zoom, and the touch "Highlight" button (in highlight.js).
import { ViewerHost, type HostHandler } from './host';
import { native, errorMessage } from './native';
import { openRequestedFile } from './navigation';
import { runTestScript } from './testScript';

type Listener = (data: any) => void;

declare global {
    interface Window {
        vscodeEvent: { on(type: string, listener: Listener): unknown, emit(type: string, data?: unknown): void };
        handler: Window['vscodeEvent'];
        PDFViewerApplication: any;
        anyfileHost?: ViewerHost;
    }
}

/* ------------------------------------------------------------ the bridge */

// The viewer side keeps one listener per message type, like resource/lib/vscode.js.
const viewerListeners = new Map<string, Listener>();
const hostListeners = new Map<string, Listener[]>();

window.vscodeEvent = {
    on(type, listener) {
        viewerListeners.set(type, listener);
        return this;
    },
    // Asynchronous both ways, like postMessage in VS Code.
    emit(type, data) {
        setTimeout(() => hostListeners.get(type)?.forEach(listener => listener(data)), 0);
    },
};
window.handler = window.vscodeEvent;

const hostHandler: HostHandler = {
    on(type, listener) {
        hostListeners.set(type, [...hostListeners.get(type) ?? [], listener]);
        return hostHandler;
    },
    emit(type, data) {
        setTimeout(() => viewerListeners.get(type)?.(data), 0);
    },
};

// The app always follows the system appearance (see mobile.css); "dark PDF" stays a separate toggle.
try {
    localStorage.setItem('office-pdf-adaptive-theme', '1');
} catch {
    // ignore storage errors
}

/* -------------------------------------------------------------- the host */

const fileId = new URLSearchParams(location.search).get('id') ?? '';
const host = new ViewerHost(hostHandler, fileId, {
    onOpened(file) {
        document.title = file.name;
    },
    onLoadError(message) {
        showError(message);
    },
});
window.anyfileHost = host;

let leaving = false;

/** Lets viewstate.js send a pending within-page move, then waits until the host has saved it. */
async function savePosition() {
    window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    host.saveViewState();
    await host.idle();
    const app = window.PDFViewerApplication;
    const page = host.currentPage;
    if (page && app?.pagesCount) {
        await native().updateFile({ id: fileId, lastPage: page, pageCount: app.pagesCount }).catch(() => undefined);
    }
}

/** Saves the reading position (showing "Saving…" if that takes a moment) before the page is left. */
async function prepareToLeave() {
    leaving = true;
    const saving = setTimeout(() => document.body.classList.add('anyfile-saving'), 300);
    try {
        await savePosition();
    } catch (error) {
        console.warn('ANYfile: could not save before leaving', errorMessage(error));
    } finally {
        clearTimeout(saving);
        document.body.classList.remove('anyfile-saving');
    }
}

async function backToLibrary() {
    if (leaving) {
        return;
    }
    await prepareToLeave();
    location.href = '/index.html';
}

void native().addListener('willResignActive', () => {
    void savePosition()
        .catch(error => console.warn('ANYfile: could not save in the background', errorMessage(error)))
        .finally(() => { void native().endBackgroundTask(); });
});
// Another app handed over a file ("Open in ANYfile"): save, then show it in its viewer.
void native().addListener('fileOpened', () => {
    if (!leaving) {
        void openRequestedFile(fileId, prepareToLeave);
    }
});

/* ------------------------------------------------------------------- UI */

function showError(message: string) {
    document.body.classList.remove('anyfile-loading');
    const overlay = document.getElementById('anyfileError');
    const text = document.getElementById('anyfileErrorText');
    if (overlay && text) {
        text.textContent = message;
        overlay.hidden = false;
    }
}

function setupChrome() {
    document.body.classList.add('anyfile-app', 'anyfile-loading');

    const back = document.createElement('button');
    back.id = 'anyfileBack';
    back.className = 'toolbarButton';
    back.title = 'Library';
    back.setAttribute('aria-label', 'Back to library');
    back.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>';
    back.addEventListener('click', () => { void backToLibrary(); });
    document.getElementById('toolbarViewerLeft')?.prepend(back);

    const overlay = document.createElement('div');
    overlay.id = 'anyfileError';
    overlay.hidden = true;
    overlay.innerHTML = '<div class="anyfile-error-box"><p class="anyfile-error-title">This PDF could not be opened</p>'
        + '<p id="anyfileErrorText"></p><button type="button">Back to library</button></div>';
    overlay.querySelector('button')?.addEventListener('click', () => { location.href = '/index.html'; });
    document.body.append(overlay);

    const spinner = document.createElement('div');
    spinner.id = 'anyfileSpinner';
    spinner.innerHTML = '<div class="anyfile-spinner-ring"></div><p>Opening…</p>';
    document.body.append(spinner);

    if (!fileId) {
        showError('No PDF was selected.');
    }
}

/* ----------------------------------------------------------- pinch zoom */

// PDF.js 3.1 has no touch zoom: scale the pages with CSS while pinching, then re-render at the new
// scale, keeping the point between the fingers in place.
function setupPinchZoom() {
    const container = document.getElementById('viewerContainer');
    const viewer = document.getElementById('viewer');
    if (!container || !viewer) {
        return;
    }
    let pinch: { distance: number, scale: number, x: number, y: number, ratio: number } | null = null;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const clampScale = (scale: number) => Math.min(10, Math.max(0.25, scale));

    container.addEventListener('touchstart', (event) => {
        const app = window.PDFViewerApplication;
        if (event.touches.length !== 2 || !app?.pdfViewer) {
            return;
        }
        const rect = container.getBoundingClientRect();
        const x = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left;
        const y = (event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top;
        pinch = { distance: distance(event.touches), scale: app.pdfViewer.currentScale, x, y, ratio: 1 };
        viewer.style.transformOrigin = `${container.scrollLeft + x - viewer.offsetLeft}px ${container.scrollTop + y - viewer.offsetTop}px`;
    }, { passive: true });

    container.addEventListener('touchmove', (event) => {
        if (!pinch || event.touches.length !== 2) {
            return;
        }
        event.preventDefault();
        pinch.ratio = clampScale(pinch.scale * distance(event.touches) / pinch.distance) / pinch.scale;
        viewer.style.transform = `scale(${pinch.ratio})`;
    }, { passive: false });

    const finish = () => {
        if (!pinch) {
            return;
        }
        const { scale, ratio, x, y } = pinch;
        pinch = null;
        viewer.style.transform = '';
        const app = window.PDFViewerApplication;
        if (!app?.pdfViewer || Math.abs(ratio - 1) < 0.02) {
            return;
        }
        const contentX = container.scrollLeft + x;
        const contentY = container.scrollTop + y;
        app.pdfViewer.currentScale = scale * ratio;
        const applied = app.pdfViewer.currentScale / scale;
        container.scrollLeft = contentX * applied - x;
        container.scrollTop = contentY * applied - y;
    };
    container.addEventListener('touchend', (event) => { if (event.touches.length < 2) { finish(); } });
    container.addEventListener('touchcancel', finish);
}

/* ---------------------------------------------------------------- start */

document.addEventListener('DOMContentLoaded', () => {
    setupChrome();
    setupPinchZoom();
}, { once: true });

window.addEventListener('load', () => {
    const app = window.PDFViewerApplication;
    void app?.initializedPromise?.then(() => {
        app.eventBus.on('documentloaded', () => document.body.classList.remove('anyfile-loading'));
        // Debug builds launched with -anyfileTest only (see AnyFilePlugin.readTestArguments).
        void native().getTestScript().then(({ script }) => {
            if (script) {
                void runTestScript(script, host);
            }
        }).catch(() => undefined);
    });
}, { once: true });
