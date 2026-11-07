// Loaded by react/index.html (the extension's React viewer app) before the app's module script.
// The React app talks to VS Code through acquireVsCodeApi().postMessage and window 'message' events
// (src/react/util/vscode.ts) and reads its route from #office-configs (src/react/util/vscodeConfig.ts).
// Here both are answered in the page: the "extension" is OfficeHost, reading files through the native plugin.
import { OfficeHost, type OfficeHostHooks } from './officeHost';
import type { HostHandler } from './host';
import { native } from './native';
import { openRequestedFile } from './navigation';

type Listener = (data: any) => void;

declare global {
    interface Window {
        acquireVsCodeApi?: () => unknown;
        anyfileOfficeHost?: OfficeHost;
    }
}

const params = new URLSearchParams(location.search);
const fileId = params.get('id') ?? '';
const route = params.get('route') ?? '';

/* ---------------------------------------------------------------- config */

// What ReactApp.view (src/common/reactApp.ts) injects in VS Code; `mobile` lets views adapt to the phone.
document.getElementById('office-configs')?.setAttribute('data-config', JSON.stringify({
    route,
    language: navigator.language,
    mobile: true,
    config: {},
}));

/* ------------------------------------------------------------- the bridge */

const hostListeners = new Map<string, Listener[]>();

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}
const stateKey = `anyfile.viewState.${route}`;

const vscodeApi = {
    // View -> host, asynchronous like VS Code's postMessage.
    postMessage(message: { type?: string, content?: unknown }) {
        setTimeout(() => hostListeners.get(message?.type ?? '')?.forEach(listener => listener(message.content)), 0);
    },
    getState() {
        let state: Record<string, unknown> | undefined;
        try {
            state = JSON.parse(localStorage.getItem(stateKey) ?? 'null') ?? undefined;
        } catch {
            state = undefined;
        }
        // Viewers' own dark toggle (loadDarkMode in src/react/util/vscode.ts): until the reader picks
        // light or dark, follow the system appearance.
        if (state?.darkMode === undefined && readStorage('office-dark-mode') === null) {
            state = { ...state, darkMode: window.matchMedia('(prefers-color-scheme: dark)').matches };
        }
        return state;
    },
    setState(state: unknown) {
        try {
            localStorage.setItem(stateKey, JSON.stringify(state));
        } catch {
            // ignore storage errors
        }
        return state;
    },
};
window.acquireVsCodeApi = () => vscodeApi;

const hostHandler: HostHandler = {
    on(type, listener) {
        hostListeners.set(type, [...hostListeners.get(type) ?? [], listener]);
        return hostHandler;
    },
    // Host -> view: a 'message' event, as the webview receives in VS Code (no structured-clone copy).
    emit(type, data) {
        setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type, content: data } })), 0);
    },
};

/* -------------------------------------------------------------- the host */

const hooks: OfficeHostHooks = {
    onOpened(name) {
        document.title = name;
        const title = document.getElementById('anyfileBarTitle');
        if (title) {
            title.textContent = name;
        }
    },
    onLoadError(message) {
        showError(message);
    },
};
window.anyfileOfficeHost = new OfficeHost(hostHandler, fileId, hooks);

// Nothing to save in a read-only view: let the app be suspended right away.
void native().addListener('willResignActive', () => { void native().endBackgroundTask(); });
void native().addListener('fileOpened', () => { void openRequestedFile(fileId); });

/* -------------------------------------------------------------------- UI */

function showError(message: string) {
    const overlay = document.getElementById('anyfileError');
    const text = document.getElementById('anyfileErrorText');
    if (overlay && text) {
        text.textContent = message;
        overlay.hidden = false;
    }
}

function setupChrome() {
    document.body.classList.add('anyfile-app', `anyfile-route-${route || 'none'}`);

    const bar = document.createElement('header');
    bar.id = 'anyfileBar';
    bar.innerHTML = '<button type="button" id="anyfileBack" aria-label="Back to library">'
        + '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>'
        + '<span>Library</span></button><div id="anyfileBarTitle"></div>';
    bar.querySelector('button')?.addEventListener('click', () => { location.href = '/index.html'; });
    document.body.prepend(bar);

    const overlay = document.createElement('div');
    overlay.id = 'anyfileError';
    overlay.hidden = true;
    overlay.innerHTML = '<div class="anyfile-error-box"><p class="anyfile-error-title">This file could not be opened</p>'
        + '<p id="anyfileErrorText"></p><button type="button">Back to library</button></div>';
    overlay.querySelector('button')?.addEventListener('click', () => { location.href = '/index.html'; });
    document.body.append(overlay);

    if (!fileId || !route) {
        showError('No file was selected.');
    }
}

// The views re-check the theme when the page's classes change (src/react/util/vscodeTheme.ts): flip a
// class when the system appearance changes so they pick up the new theme variables.
function followSystemAppearance() {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('anyfile-system-dark', query.matches);
    apply();
    query.addEventListener('change', apply);
}

document.addEventListener('DOMContentLoaded', () => {
    setupChrome();
    followSystemAppearance();
}, { once: true });
