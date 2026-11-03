import * as vscode from 'vscode';
import { Uri, workspace } from 'vscode';
import { Handler } from '@/common/handler';
import { Output } from '@/common/Output';
import { isUriReadOnly } from '@/common/fileReadOnly';
import { writeFileAsInternalSave } from '@/provider/compress/commonHandler';
import { isVirtualUri } from '@/provider/handlers/officeContent';
import {
    isPdfLibAvailable,
    pickFingerprint,
    PdfHighlightDocument,
    type PdfHighlightAddOp,
    type PdfHighlightOp,
    type PdfHighlightOpResult,
    type PdfHighlightRemoveOp,
    type PdfViewState,
} from './pdfHighlightWriter';

interface PdfHighlightConfig {
    writable: boolean;
    reason?: string;
}

interface HighlightSession {
    handler: Handler;
    /** Answer to the "PDF is signed, save anyway?" prompt; undefined until asked. Asked once per editor session. */
    allowSigned?: boolean;
    /** Page of the reading position stored in the file (null: none), as reported by the viewer on load. */
    storedPage?: number | null;
    /** Latest reading position reported by the viewer. */
    viewState?: PdfViewState;
    fingerprint?: string | null;
    /** Reading-position saves of this session that are queued or running. */
    pendingViewOps: number;
}

interface QueuedOp {
    session: HighlightSession;
    op: PdfHighlightOp;
}

interface SaveQueue {
    pending: QueuedOp[];
    running: boolean;
}

/** Highlight saves are serialized per URI, shared by every editor of that file. */
const saveQueues = new Map<string, SaveQueue>();
/** Short delay before each save so a burst of ops (e.g. a multi-page selection) lands in one save. */
const COALESCE_DELAY_MS = 30;

const REASON_VIRTUAL = 'Highlights cannot be saved because this PDF is not a file on disk (for example, a Git revision).';
const REASON_READ_ONLY = 'Highlights cannot be saved because this PDF is read-only.';
const REASON_UNAVAILABLE = 'Saving highlights into PDF files is not supported in this environment.';
const REASON_SIGNED = 'Highlights are not saved because saving would invalidate the digital signature of this PDF.';
const SAVE_ANYWAY = 'Save Anyway';

export async function resolvePdfHighlightConfig(uri: Uri): Promise<PdfHighlightConfig> {
    if (isVirtualUri(uri)) {
        return { writable: false, reason: REASON_VIRTUAL };
    }
    if (await isUriReadOnly(uri) || !await isLocalFileWritable(uri)) {
        return { writable: false, reason: REASON_READ_ONLY };
    }
    if (!isPdfLibAvailable()) {
        return { writable: false, reason: REASON_UNAVAILABLE };
    }
    return { writable: true };
}

/** isUriReadOnly never reports write-protected local files (chmod a-w, owned by another user): ask the file system. */
async function isLocalFileWritable(uri: Uri): Promise<boolean> {
    if (uri.scheme !== 'file') {
        return true;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        await fs.promises.access(uri.fsPath, fs.constants.W_OK);
        return true;
    } catch (error) {
        // Only a denied access blocks (not e.g. a missing 'fs' module in the web extension host).
        return !['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException)?.code ?? '');
    }
}

function isPositionInFileEnabled(uri: Uri): boolean {
    return vscode.workspace.getConfiguration('vscode-office', uri).get<boolean>('pdf.rememberPositionInFile', true);
}

/**
 * Saves highlights made in the PDF viewer into the PDF file as /Highlight annotations,
 * and the reading position as a document info entry when the editor is hidden or closed.
 */
export function handlePdfHighlight(handler: Handler, uri: Uri): void {
    const session: HighlightSession = { handler, pendingViewOps: 0 };
    handler
        // Handler keeps every 'init' listener, so this runs alongside the common 'open' handling.
        .on('init', async () => {
            handler.emit('pdfViewConfig', { rememberPosition: isPositionInFileEnabled(uri) });
            const config = await resolvePdfHighlightConfig(uri);
            handler.emit('pdfHighlightConfig', config.writable && session.allowSigned === false
                ? { writable: false, reason: REASON_SIGNED }
                : config);
        })
        .on('pdfViewStored', (payload: { page?: number | null, fingerprint?: string | null }) => {
            // A reload while our own position save is queued reports the file as it was before that save.
            if (session.pendingViewOps > 0) {
                return;
            }
            session.storedPage = isPageNumber(payload?.page) ? payload.page : null;
            session.fingerprint = typeof payload?.fingerprint === 'string' ? payload.fingerprint : null;
        })
        .on('pdfViewChanged', (payload: PdfViewState) => {
            if (isPageNumber(payload?.page)) {
                session.viewState = { page: payload.page, left: payload.left, top: payload.top };
            }
        })
        .on('pdfHighlightAdd', (payload: Omit<PdfHighlightAddOp, 'type'>) => {
            if (payload && typeof payload === 'object') {
                enqueue(uri, { session, op: { ...payload, type: 'add' } });
            }
        })
        .on('pdfHighlightRemove', (payload: Omit<PdfHighlightRemoveOp, 'type'>) => {
            if (payload && typeof payload === 'object') {
                enqueue(uri, { session, op: { ...payload, type: 'remove' } });
            }
        });
    // Not via handler.on('dispose'): Handler keeps a single listener per event and commonHandler owns that one.
    const panel = handler.panel;
    panel.onDidChangeViewState(() => {
        if (!panel.visible) {
            saveViewState(uri, session);
        }
    });
    panel.onDidDispose(() => saveViewState(uri, session));
}

function isPageNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Stores the reading position in the file, unless it is already there (a missing position counts as page 1). */
function saveViewState(uri: Uri, session: HighlightSession) {
    const state = session.viewState;
    if (!state || session.storedPage === undefined || state.page === (session.storedPage ?? 1) || !isPositionInFileEnabled(uri)) {
        return;
    }
    session.storedPage = state.page;
    session.pendingViewOps++;
    // The save time lets the viewer tell a newer position in the file (another device) from an older
    // one (e.g. VS Code quit without closing the editor) than its local history.
    enqueue(uri, { session, op: { type: 'view', state: { ...state, t: Date.now() }, fingerprint: session.fingerprint } });
}

function isHighlightOp(item: QueuedOp): boolean {
    return item.op.type !== 'view';
}

function enqueue(uri: Uri, item: QueuedOp) {
    const key = uri.toString();
    let queue = saveQueues.get(key);
    if (!queue) {
        queue = { pending: [], running: false };
        saveQueues.set(key, queue);
    }
    queue.pending.push(item);
    if (!queue.running) {
        queue.running = true;
        void drainQueue(uri, key, queue);
    }
}

async function drainQueue(uri: Uri, key: string, queue: SaveQueue) {
    try {
        // Ops arriving while a save runs are applied together in the next save.
        while (queue.pending.length > 0) {
            await new Promise(resolve => setTimeout(resolve, COALESCE_DELAY_MS));
            const batch = queue.pending.splice(0);
            try {
                await saveBatch(uri, batch);
            } finally {
                for (const item of batch) {
                    if (!isHighlightOp(item)) {
                        item.session.pendingViewOps--;
                    }
                }
            }
        }
    } finally {
        queue.running = false;
        if (queue.pending.length === 0 && saveQueues.get(key) === queue) {
            saveQueues.delete(key);
        }
    }
}

async function saveBatch(uri: Uri, batch: QueuedOp[]) {
    let items = batch;
    try {
        const config = await resolvePdfHighlightConfig(uri);
        if (!config.writable) {
            failItems(items, config.reason);
            return;
        }
        const original = await workspace.fs.readFile(uri);
        const document = await PdfHighlightDocument.load(original);
        if (document.signed) {
            // Never invalidate a signature just to remember the page: only highlights may ask for consent.
            items = await keepConsentedItems(items.filter(isHighlightOp));
            if (items.length === 0) {
                return;
            }
        }
        const results = document.apply(items.map(item => item.op));
        if (!results.some(result => result.changed)) {
            reportResults(items, results);
            return;
        }
        const saved = await document.save({ fingerprint: pickFingerprint(items.map(item => item.op)) });
        await writeFileAsInternalSave(uri, saved);
        reportResults(items, results);
        // A highlight removed by ref is baked into the canvas of the loaded document: reload it.
        // The /ID (fingerprint) is preserved, so PDF.js restores the view position.
        const reloadSessions = new Set(items.filter((_, index) => results[index].removedRef).map(item => item.session));
        for (const session of reloadSessions) {
            session.handler.emit('open', { buffer: saved });
        }
    } catch (error) {
        Output.debug(error);
        failItems(items, error instanceof Error ? error.message : String(error));
    }
}

/** For a signed PDF, asks once per editor session whether to save anyway; returns the ops of sessions that agreed. */
async function keepConsentedItems(items: QueuedOp[]): Promise<QueuedOp[]> {
    const undecided = [...new Set(items.map(item => item.session))].filter(session => session.allowSigned === undefined);
    if (undecided.length > 0) {
        const answer = await vscode.window.showWarningMessage(
            'This PDF is digitally signed. Saving highlights into it will invalidate the signature.',
            { modal: true, detail: 'Do you want to save the highlights anyway?' },
            SAVE_ANYWAY,
        );
        const allow = answer === SAVE_ANYWAY;
        for (const session of undecided) {
            session.allowSigned = allow;
            if (!allow) {
                session.handler.emit('pdfHighlightConfig', { writable: false, reason: REASON_SIGNED });
            }
        }
    }
    failItems(items.filter(item => !item.session.allowSigned), REASON_SIGNED);
    return items.filter(item => item.session.allowSigned);
}

function addId(op: PdfHighlightOp): string | undefined {
    return op.type === 'add' && typeof op.id === 'string' ? op.id : undefined;
}

function groupBySession(items: QueuedOp[]): Map<HighlightSession, QueuedOp[]> {
    const groups = new Map<HighlightSession, QueuedOp[]>();
    for (const item of items) {
        const group = groups.get(item.session) ?? [];
        group.push(item);
        groups.set(item.session, group);
    }
    return groups;
}

// Reading-position ops are best effort: their failures are not shown in the viewer.
function failItems(items: QueuedOp[], error: string | undefined) {
    if (items.some(item => !isHighlightOp(item))) {
        Output.debug(`Reading position not saved: ${error}`);
    }
    for (const [session, group] of groupBySession(items.filter(isHighlightOp))) {
        const ids = group.map(item => addId(item.op)).filter((id): id is string => !!id);
        session.handler.emit('pdfHighlightResult', { ok: false, ids, error: error || 'Failed to save highlights.' });
    }
}

function reportResults(items: QueuedOp[], results: PdfHighlightOpResult[]) {
    const indexOf = new Map(items.map((item, index) => [item, index]));
    for (const [session, group] of groupBySession(items.filter(isHighlightOp))) {
        const okIds: string[] = [];
        const failures = new Map<string, string[]>();
        for (const item of group) {
            const result = results[indexOf.get(item)!];
            const id = addId(item.op);
            if (result.ok) {
                if (id) {
                    okIds.push(id);
                }
                continue;
            }
            const error = result.error || 'Failed to save highlight.';
            const failedIds = failures.get(error) ?? [];
            if (id) {
                failedIds.push(id);
            }
            failures.set(error, failedIds);
        }
        if (okIds.length > 0 || failures.size === 0) {
            session.handler.emit('pdfHighlightResult', { ok: true, ids: okIds });
        }
        for (const [error, ids] of failures) {
            session.handler.emit('pdfHighlightResult', { ok: false, ids, error });
        }
    }
}
