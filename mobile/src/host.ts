// The app's counterpart of src/provider/handlers/pdfHighlightHandler.ts (the VS Code side of the
// viewer): saves highlights and the reading position into the PDF with the same writer and rules.
// Differences: one viewer per page (no shared queue), files come from the native library, and a save
// that races another device's change (conflict) re-reads the file and applies its ops again.
import {
    PdfHighlightDocument,
    pickFingerprint,
    type PdfHighlightAddOp,
    type PdfHighlightOp,
    type PdfHighlightOpResult,
    type PdfHighlightRemoveOp,
    type PdfViewState,
} from '../../src/provider/handlers/pdfHighlightWriter';
import { errorMessage, isConflict, native, readFileBytes, writeFileBytes, type FileContent } from './native';

export interface HostHandler {
    on(type: string, listener: (data: any) => void): HostHandler;
    emit(type: string, data?: unknown): void;
}

export interface HostHooks {
    onOpened?(file: FileContent): void;
    onLoadError?(message: string): void;
    confirm?(message: string): boolean;
}

const REASON_READ_ONLY = 'Highlights cannot be saved because this PDF is read-only.';
const REASON_SIGNED = 'Highlights are not saved because saving would invalidate the digital signature of this PDF.';
const SIGNED_PROMPT = 'This PDF is digitally signed. Saving highlights into it will invalidate the signature.\n\nSave the highlights anyway?';
/** Short delay before each save so a burst of ops (e.g. a multi-page selection) lands in one save. */
const COALESCE_DELAY_MS = 30;
/** Re-reads after a conflicting change by another app or device before giving up. */
const MAX_CONFLICT_RETRIES = 3;

function isHighlightOp(op: PdfHighlightOp): boolean {
    return op.type !== 'view';
}

function isPageNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ------------------------------------------------ positions not saved yet */

// The app can be closed before it saves the reading position (iOS ends apps without notice): it is
// kept here and written the next time the library opens, unless the file has a newer one by then.
const PENDING_KEY = 'anyfile.pendingView';

interface PendingView {
    state: PdfViewState & { t: number };
    fingerprint: string | null;
}

function loadPending(): Record<string, PendingView> {
    try {
        const value = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

function storePending(update: (pending: Record<string, PendingView>) => void) {
    try {
        const pending = loadPending();
        update(pending);
        localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch {
        // ignore storage errors
    }
}

/** Writes positions that were never saved (best effort; kept for the next time on failure). */
export async function savePendingPositions(): Promise<void> {
    for (const [id, entry] of Object.entries(loadPending())) {
        try {
            await saveWithRetry(id, async (document) => {
                if (document.signed) {
                    return null;
                }
                const op: PdfHighlightOp = { type: 'view', state: entry.state, fingerprint: entry.fingerprint, onlyIfNewer: true };
                return { results: document.apply([op]), fingerprint: entry.fingerprint };
            });
            storePending(pending => {
                if (pending[id]?.state.t === entry.state.t) {
                    delete pending[id];
                }
            });
        } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code === 'not-found' || code === 'read-only') {
                storePending(pending => { delete pending[id]; });
            } else {
                console.warn('ANYfile: reading position not saved yet', errorMessage(error));
            }
        }
    }
}

interface Applied {
    results: PdfHighlightOpResult[];
    fingerprint: string | null;
}

/**
 * Reads the file, applies ops through `apply` and writes it back if anything changed; on a conflicting
 * write (the file changed since it was read) starts over from a fresh read.
 * Returns null when `apply` skipped the file, else the results and the saved bytes (null if unchanged).
 */
async function saveWithRetry(id: string, apply: (document: PdfHighlightDocument, file: FileContent) => Promise<Applied | null>):
    Promise<{ results: PdfHighlightOpResult[], saved: Uint8Array | null } | null> {
    for (let attempt = 0; ; attempt++) {
        const file = await readFileBytes(id);
        if (!file.writable) {
            throw Object.assign(new Error(REASON_READ_ONLY), { code: 'read-only' });
        }
        const document = await PdfHighlightDocument.load(file.bytes);
        const applied = await apply(document, file);
        if (!applied) {
            return null;
        }
        if (!applied.results.some(result => result.changed)) {
            return { results: applied.results, saved: null };
        }
        const saved = await document.save({ fingerprint: applied.fingerprint });
        try {
            await writeFileBytes(id, saved, file.modified);
            return { results: applied.results, saved };
        } catch (error) {
            if (!isConflict(error) || attempt >= MAX_CONFLICT_RETRIES) {
                throw error;
            }
        }
    }
}

/* ------------------------------------------------------------ the viewer */

export class ViewerHost {
    /** Answer to the "PDF is signed, save anyway?" prompt; undefined until asked. */
    private allowSigned?: boolean;
    /** Page of the reading position stored in the file (null: none), as reported by the viewer on load. */
    private storedPage?: number | null;
    private viewState?: PdfViewState;
    private fingerprint: string | null = null;
    /** Reading-position saves that are queued or running. */
    private pendingViewOps = 0;
    private queue: PdfHighlightOp[] = [];
    private running: Promise<void> | null = null;
    private writable = false;

    constructor(private readonly handler: HostHandler, readonly fileId: string, private readonly hooks: HostHooks = {}) {
        handler
            .on('init', () => { void this.open(); })
            .on('pdfViewStored', (payload: { page?: number | null, fingerprint?: string | null }) => {
                // A reload while our own position save is queued reports the file as it was before that save.
                if (this.pendingViewOps > 0) {
                    return;
                }
                this.storedPage = isPageNumber(payload?.page) ? payload.page : null;
                this.fingerprint = typeof payload?.fingerprint === 'string' ? payload.fingerprint : null;
                this.trackPending();
            })
            .on('pdfViewChanged', (payload: PdfViewState) => {
                if (isPageNumber(payload?.page)) {
                    this.viewState = { page: payload.page, left: payload.left, top: payload.top };
                    this.trackPending();
                }
            })
            .on('pdfHighlightAdd', (payload: Omit<PdfHighlightAddOp, 'type'>) => {
                if (payload && typeof payload === 'object') {
                    this.enqueue({ ...payload, type: 'add' });
                }
            })
            .on('pdfHighlightRemove', (payload: Omit<PdfHighlightRemoveOp, 'type'>) => {
                if (payload && typeof payload === 'object') {
                    this.enqueue({ ...payload, type: 'remove' });
                }
            });
    }

    /** The page the reader is on (null until the viewer reported it). */
    get currentPage(): number | null {
        return this.viewState?.page ?? null;
    }

    private async open() {
        this.handler.emit('pdfViewConfig', { rememberPosition: true });
        // This viewer now owns the position: a leftover from an earlier session is superseded.
        storePending(pending => { delete pending[this.fileId]; });
        let file: FileContent;
        try {
            file = await readFileBytes(this.fileId);
        } catch (error) {
            this.hooks.onLoadError?.(errorMessage(error));
            return;
        }
        this.writable = file.writable;
        this.hooks.onOpened?.(file);
        this.handler.emit('open', { buffer: file.bytes });
        this.emitConfig();
        void native().updateFile({ id: this.fileId, lastOpened: Date.now() }).catch(() => undefined);
    }

    private emitConfig() {
        if (!this.writable) {
            this.handler.emit('pdfHighlightConfig', { writable: false, reason: REASON_READ_ONLY });
        } else if (this.allowSigned === false) {
            this.handler.emit('pdfHighlightConfig', { writable: false, reason: REASON_SIGNED });
        } else {
            this.handler.emit('pdfHighlightConfig', { writable: true });
        }
    }

    /** Remembers an unsaved position so it survives the app being closed before {@link saveViewState}. */
    private trackPending() {
        const state = this.viewState;
        if (!state || this.storedPage === undefined || !this.writable) {
            return;
        }
        storePending(pending => {
            if (state.page === (this.storedPage ?? 1)) {
                delete pending[this.fileId];
            } else {
                pending[this.fileId] = { state: { ...state, t: Date.now() }, fingerprint: this.fingerprint };
            }
        });
    }

    /** Stores the reading position in the file, unless it is already there (a missing position counts as page 1). */
    saveViewState() {
        const state = this.viewState;
        if (!state || this.storedPage === undefined || state.page === (this.storedPage ?? 1) || !this.writable) {
            return;
        }
        this.storedPage = state.page;
        this.pendingViewOps++;
        this.enqueue({ type: 'view', state: { ...state, t: Date.now() }, fingerprint: this.fingerprint });
    }

    /** Resolves once every queued save has finished. */
    async idle(): Promise<void> {
        while (this.running) {
            await this.running;
        }
    }

    private enqueue(op: PdfHighlightOp) {
        this.queue.push(op);
        if (!this.running) {
            this.running = this.drain().finally(() => { this.running = null; });
        }
    }

    private async drain() {
        while (this.queue.length > 0) {
            await delay(COALESCE_DELAY_MS);
            const batch = this.queue.splice(0);
            try {
                await this.saveBatch(batch);
            } finally {
                for (const op of batch) {
                    if (!isHighlightOp(op)) {
                        this.pendingViewOps--;
                    }
                }
            }
        }
    }

    private async saveBatch(batch: PdfHighlightOp[]) {
        let ops = batch;
        try {
            const outcome = await saveWithRetry(this.fileId, async (document) => {
                ops = batch;
                if (document.signed) {
                    // Never invalidate a signature just to remember the page: only highlights may ask for consent.
                    ops = this.keepConsented(batch.filter(isHighlightOp));
                    if (ops.length === 0) {
                        return null;
                    }
                }
                return { results: document.apply(ops), fingerprint: pickFingerprint(ops) };
            });
            if (!outcome) {
                return;
            }
            this.reportResults(ops, outcome.results);
            if (outcome.saved) {
                this.afterSave(ops, outcome.results);
                // A highlight removed by ref is baked into the canvas of the loaded document: reload it.
                if (outcome.results.some(result => result.removedRef)) {
                    this.handler.emit('open', { buffer: outcome.saved });
                }
            }
        } catch (error) {
            console.warn('ANYfile: save failed', error);
            this.failOps(ops, errorMessage(error));
        }
    }

    private afterSave(ops: PdfHighlightOp[], results: PdfHighlightOpResult[]) {
        const saved = ops.filter((op, index) => op.type === 'view' && results[index]?.ok).pop();
        if (saved?.type !== 'view') {
            return;
        }
        const page = saved.state.page;
        storePending(pending => {
            if (pending[this.fileId]?.state.page === page) {
                delete pending[this.fileId];
            }
        });
    }

    /** For a signed PDF, asks once whether to save highlights anyway; returns the ops allowed to be saved. */
    private keepConsented(ops: PdfHighlightOp[]): PdfHighlightOp[] {
        if (ops.length === 0) {
            return ops;
        }
        if (this.allowSigned === undefined) {
            this.allowSigned = (this.hooks.confirm ?? window.confirm.bind(window))(SIGNED_PROMPT);
            if (!this.allowSigned) {
                this.emitConfig();
            }
        }
        if (!this.allowSigned) {
            this.failOps(ops, REASON_SIGNED);
            return [];
        }
        return ops;
    }

    // Reading-position ops are best effort: their failures are not shown in the viewer.
    private failOps(ops: PdfHighlightOp[], error: string) {
        if (ops.some(op => !isHighlightOp(op))) {
            console.warn(`ANYfile: reading position not saved: ${error}`);
        }
        const highlightOps = ops.filter(isHighlightOp);
        if (highlightOps.length === 0) {
            return;
        }
        const ids = highlightOps.map(addId).filter((id): id is string => !!id);
        this.handler.emit('pdfHighlightResult', { ok: false, ids, error: error || 'Failed to save highlights.' });
    }

    private reportResults(ops: PdfHighlightOp[], results: PdfHighlightOpResult[]) {
        const okIds: string[] = [];
        const failures = new Map<string, string[]>();
        let highlightCount = 0;
        ops.forEach((op, index) => {
            if (!isHighlightOp(op)) {
                return;
            }
            highlightCount++;
            const result = results[index];
            const id = addId(op);
            if (result?.ok) {
                if (id) {
                    okIds.push(id);
                }
                return;
            }
            const error = result?.error || 'Failed to save highlight.';
            const failedIds = failures.get(error) ?? [];
            if (id) {
                failedIds.push(id);
            }
            failures.set(error, failedIds);
        });
        if (highlightCount === 0) {
            return;
        }
        if (okIds.length > 0 || failures.size === 0) {
            this.handler.emit('pdfHighlightResult', { ok: true, ids: okIds });
        }
        for (const [error, ids] of failures) {
            this.handler.emit('pdfHighlightResult', { ok: false, ids, error });
        }
    }
}

function addId(op: PdfHighlightOp): string | undefined {
    return op.type === 'add' && typeof op.id === 'string' ? op.id : undefined;
}
