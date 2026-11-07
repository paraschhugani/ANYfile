// The app's start page: files opened before (with the page you were on, for PDFs), and "Open File".
import { savePendingPositions } from './host';
import { displayName, formatOf, SUPPORTED_SUMMARY } from './formats';
import { errorMessage, native, type LibraryFile } from './native';
import { openLibraryFile, openRequestedFile } from './navigation';

function fileIcon(name: string): string {
    const format = formatOf(name);
    const label = format?.label ?? 'FILE';
    const color = format?.color ?? '#8e8e93';
    const size = label.length > 3 ? 6.2 : 7.5;
    return '<svg viewBox="0 0 28 34" width="28" height="34" aria-hidden="true"><path d="M3 1h15l9 9v21a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="var(--file-bg)" stroke="var(--file-stroke)" stroke-width="1.2"/><path d="M18 1v7a2 2 0 0 0 2 2h7" fill="none" stroke="var(--file-stroke)" stroke-width="1.2"/>'
        + `<text x="14" y="26" text-anchor="middle" font-size="${size}" font-weight="700" fill="${color}" font-family="-apple-system, system-ui, sans-serif">${label}</text></svg>`;
}
const REMOVE_ICON = '<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="#ff3b30"/><path d="M6.5 11h9" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';

let files: LibraryFile[] = [];
let editing = false;
let opening = false;

function element<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

async function openFile(file: LibraryFile) {
    if (opening) {
        return;
    }
    opening = true;
    try {
        if (!await openLibraryFile(file)) {
            showMessage(`ANYfile can't open ${file.name}. It opens ${SUPPORTED_SUMMARY}.`);
        }
    } catch (error) {
        showMessage(errorMessage(error));
    } finally {
        // A Quick Look preview keeps this page: allow opening the next file.
        opening = false;
    }
}

function showMessage(text: string) {
    const message = element('message');
    message.textContent = text;
    message.hidden = !text;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function describeTime(ms: number | undefined): string {
    if (!ms) {
        return '';
    }
    const minutes = Math.round((ms - Date.now()) / 60000);
    if (Math.abs(minutes) < 1) {
        return 'just now';
    }
    if (Math.abs(minutes) < 60) {
        return relativeTime.format(minutes, 'minute');
    }
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) {
        return relativeTime.format(hours, 'hour');
    }
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) {
        return relativeTime.format(days, 'day');
    }
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function describe(file: LibraryFile): string {
    const parts: string[] = [];
    if (file.folder) {
        parts.push(file.folder);
    }
    if (file.lastPage) {
        parts.push(file.pageCount ? `Page ${file.lastPage} of ${file.pageCount}` : `Page ${file.lastPage}`);
    }
    const time = describeTime(file.lastOpened);
    if (time) {
        parts.push(time);
    }
    return parts.join(' · ');
}

function render() {
    const list = element<HTMLUListElement>('files');
    list.textContent = '';
    const sorted = [...files].sort((a, b) => (b.lastOpened ?? b.added) - (a.lastOpened ?? a.added));
    for (const file of sorted) {
        const item = document.createElement('li');
        item.className = 'file-row';

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.hidden = !editing;
        remove.innerHTML = REMOVE_ICON;
        remove.setAttribute('aria-label', `Remove ${file.name} from the list`);
        remove.addEventListener('click', () => { void removeFile(file); });

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'file';
        open.innerHTML = `<span class="file-icon">${fileIcon(file.name)}</span><span class="file-text"><span class="file-name"></span><span class="file-meta"></span></span>`;
        (open.querySelector('.file-name') as HTMLElement).textContent = displayName(file.name);
        (open.querySelector('.file-meta') as HTMLElement).textContent = describe(file);
        open.addEventListener('click', () => {
            if (!editing) {
                void openFile(file);
            }
        });

        item.append(remove, open);
        list.append(item);
    }
    element('recent').hidden = files.length === 0;
    element('empty').hidden = files.length > 0;
    const edit = element<HTMLButtonElement>('edit');
    edit.hidden = files.length === 0;
    edit.textContent = editing ? 'Done' : 'Edit';
    document.body.classList.toggle('editing', editing);
}

async function refresh() {
    try {
        files = (await native().listFiles()).files;
    } catch (error) {
        showMessage(errorMessage(error));
    }
    if (files.length === 0) {
        editing = false;
    }
    render();
}

async function removeFile(file: LibraryFile) {
    const note = file.inApp ? 'The copy kept in ANYfile is deleted.' : 'The PDF itself stays where it is.';
    if (!window.confirm(`Remove "${file.name}" from the list?\n\n${note}`)) {
        return;
    }
    await native().removeFile({ id: file.id });
    await refresh();
}

async function pick() {
    showMessage('');
    try {
        const { files: picked, failed } = await native().pickFiles();
        // The picker shows every file: keep only the ones ANYfile can show.
        const unsupported = picked.filter(file => !formatOf(file.name));
        for (const file of unsupported) {
            await native().removeFile({ id: file.id });
        }
        const supported = picked.filter(file => formatOf(file.name));
        const problems = [
            ...unsupported.length ? [`ANYfile can't open ${unsupported.map(file => file.name).join(', ')}. It opens ${SUPPORTED_SUMMARY}.`] : [],
            ...failed.length ? [`Could not open ${failed.join(', ')}.`] : [],
        ];
        showMessage(problems.join(' '));
        if (supported.length === 1 && problems.length === 0) {
            await refresh();
            await openFile(supported[0]);
            return;
        }
        await refresh();
    } catch (error) {
        showMessage(errorMessage(error));
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    element('open').addEventListener('click', () => { void pick(); });
    element('edit').addEventListener('click', () => {
        editing = !editing;
        render();
    });
    void native().addListener('fileOpened', () => { void openRequestedFile(null).then(refresh); });
    void native().addListener('previewClosed', () => { void refresh(); });
    void native().addListener('willResignActive', () => { void native().endBackgroundTask(); });
    if (await openRequestedFile(null)) {
        await refresh();
        return;
    }
    await refresh();
    // Positions the app could not save before it was closed (see host.ts).
    void savePendingPositions().then(refresh);
}, { once: true });
