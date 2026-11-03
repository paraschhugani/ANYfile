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
} from './pdfHighlightWriter';

interface PdfHighlightConfig {
    writable: boolean;
    reason?: string;
}

interface HighlightSession {
    handler: Handler;
    /** Answer to the "PDF is signed, save anyway?" prompt; undefined until asked. Asked once per editor session. */
    allowSigned?: boolean;
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
    if (await isUriReadOnly(uri)) {
        return { writable: false, reason: REASON_READ_ONLY };
    }
    if (!isPdfLibAvailable()) {
        return { writable: false, reason: REASON_UNAVAILABLE };
    }
    return { writable: true };
}

/** Saves highlights made in the PDF viewer into the PDF file as /Highlight annotations. */
export function handlePdfHighlight(handler: Handler, uri: Uri): void {
    const session: HighlightSession = { handler };
    handler
        // Handler keeps every 'init' listener, so this runs alongside the common 'open' handling.
        .on('init', async () => {
            const config = await resolvePdfHighlightConfig(uri);
            handler.emit('pdfHighlightConfig', config.writable && session.allowSigned === false
                ? { writable: false, reason: REASON_SIGNED }
                : config);
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
            await saveBatch(uri, queue.pending.splice(0));
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
            items = await keepConsentedItems(items);
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

function failItems(items: QueuedOp[], error: string | undefined) {
    for (const [session, group] of groupBySession(items)) {
        const ids = group.map(item => addId(item.op)).filter((id): id is string => !!id);
        session.handler.emit('pdfHighlightResult', { ok: false, ids, error: error || 'Failed to save highlights.' });
    }
}

function reportResults(items: QueuedOp[], results: PdfHighlightOpResult[]) {
    const indexOf = new Map(items.map((item, index) => [item, index]));
    for (const [session, group] of groupBySession(items)) {
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
