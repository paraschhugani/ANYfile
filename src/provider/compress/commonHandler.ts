import * as vscode from 'vscode';
import { basename, join, parse } from 'path';
import { Handler } from "@/common/handler";
import { isUriReadOnly } from '@/common/fileReadOnly';
import { Uri, workspace } from 'vscode';
import { emitFileOfficeOpen, emitVirtualOfficeOpen, isVirtualUri } from '@/provider/handlers/officeContent';

const fileSaveTimes: Record<string, number> = {};
const INTERNAL_SAVE_CHANGE_WINDOW_MS = 1500;

function buildDefaultXlsxUri(uri: Uri): Uri {
    const { dir, name } = parse(uri.fsPath);
    const fileName = `${name}.xlsx`;
    if (uri.scheme === 'file') {
        return Uri.file(join(dir, fileName));
    }
    return Uri.joinPath(uri, '..', fileName);
}

export function shouldSkipFileChange(uri: Uri): boolean {
    const lastSaveTime = fileSaveTimes[uri.toString()];
    return !!(lastSaveTime && Date.now() - lastSaveTime < INTERNAL_SAVE_CHANGE_WINDOW_MS);
}

/**
 * Writes the file as an internal save, so the file watcher's resulting change event is skipped.
 * Writes in place (no temp file + rename) so the file keeps its permissions, owner, hard links and
 * extended attributes (Finder tags, Skim notes), and write-protected files fail instead of being replaced.
 */
export async function writeFileAsInternalSave(uri: Uri, content: Uint8Array): Promise<void> {
    fileSaveTimes[uri.toString()] = Date.now();
    try {
        await workspace.fs.writeFile(uri, content);
    } finally {
        fileSaveTimes[uri.toString()] = Date.now();
    }
}

function setDirty(handler: Handler, uri: Uri, dirty: boolean) {
    const panel = handler.panel;
    const fileName = basename(uri.fsPath);
    panel.title = dirty ? `${fileName}*` : fileName;
    if (dirty) {
        void vscode.commands.executeCommand('workbench.action.keepEditor');
    }
}

export function handleCommonEvent(uri: Uri, handler: Handler, options?: { skipOpen?: boolean }) {
    let readOnly = false;
    // Only watcher events of our own writes are skipped: an editor's initial load must always get
    // the document (e.g. reopening a PDF right after closing it, which saved its reading position).
    const send = async (fromWatcher: boolean) => {
        if (fromWatcher && shouldSkipFileChange(uri)) {
            return;
        }
        readOnly = await isUriReadOnly(uri);
        if (isVirtualUri(uri)) {
            void emitVirtualOfficeOpen(handler, uri);
            return;
        }
        await emitFileOfficeOpen(handler, uri, handler.panel.webview);
    }
    const events = handler
        .on("editInVSCode", (full: boolean) => {
            const side = full ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
            vscode.commands.executeCommand('vscode.openWith', uri, "default", side);
        })
    if (!options?.skipOpen) {
        events.on("init", () => { void send(false); }).on("fileChange", () => { void send(true); })
    }
    events
        .on("change", () => {
            setDirty(handler, uri, true);
        })
        .on("save", async (content) => {
            const res = Array.isArray(content) ? new Uint8Array(content) : new TextEncoder().encode(content)
            if (readOnly) {
                handler.emit('saveAs', { content: [...res] });
                return;
            }
            fileSaveTimes[uri.toString()] = Date.now();
            await workspace.fs.writeFile(uri, res)
            fileSaveTimes[uri.toString()] = Date.now();
            setDirty(handler, uri, false);
            handler.emit("saveDone")
        })
        .on("saveAs", async (payload: { content: number[], ext?: string }) => {
            const res = new Uint8Array(payload.content);
            const ext = (payload.ext ?? 'xlsx').toLowerCase();
            const { dir, name } = parse(uri.fsPath);
            const defaultFileName = `${name}.${ext}`;
            const defaultUri = uri.scheme === 'file'
                ? Uri.file(join(dir, defaultFileName))
                : Uri.joinPath(uri, '..', defaultFileName);
            const filterMap: Record<string, { label: string; exts: string[] }> = {
                xlsx: { label: 'Excel Workbook', exts: ['xlsx'] },
                xlsm: { label: 'Excel Macro-Enabled Workbook', exts: ['xlsm'] },
                xls: { label: 'Excel 97-2003 Workbook', exts: ['xls'] },
                ods: { label: 'OpenDocument Spreadsheet', exts: ['ods'] },
                csv: { label: 'CSV (Comma delimited)', exts: ['csv'] },
                parquet: { label: 'Apache Parquet', exts: ['parquet'] },
                docx: { label: 'Word Document', exts: ['docx'] },
                dotx: { label: 'Word Template', exts: ['dotx'] },
            };
            const info = filterMap[ext] ?? { label: ext.toUpperCase(), exts: [ext] };
            const target = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { [info.label]: info.exts },
            });
            if (!target) return;
            fileSaveTimes[target.toString()] = Date.now();
            await workspace.fs.writeFile(target, res);
            fileSaveTimes[target.toString()] = Date.now();
            setDirty(handler, uri, false);
            handler.emit("saveDone");
            await vscode.commands.executeCommand('vscode.openWith', target, 'cweijan.officeViewer');
        })
        .on('developerTool', () => vscode.commands.executeCommand('workbench.action.toggleDevTools'))
        .on('openExternal', (url: string) => {
            if (url) {
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        })
        .on('dispose', () => {
            delete fileSaveTimes[uri.toString()];
        })
}
