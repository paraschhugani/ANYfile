// Which viewer shows which file: the extension's PDF viewer, a route of the extension's React viewer app,
// or the system's Quick Look (images, which iOS already shows well).

export type FileKind = 'pdf' | 'react' | 'preview';

export interface FileFormat {
    kind: FileKind;
    /** Route of the React viewer app (src/react/main.tsx) */
    route?: string;
    /** Short label on the file icon */
    label: string;
    color: string;
}

const PDF: FileFormat = { kind: 'pdf', label: 'PDF', color: '#e5484d' };
const SHEET: FileFormat = { kind: 'react', route: 'excel', label: 'XLS', color: '#1f9d55' };
const WORD: FileFormat = { kind: 'react', route: 'word', label: 'DOC', color: '#2b6cd8' };
const SLIDES: FileFormat = { kind: 'react', route: 'ppt', label: 'PPT', color: '#e8672b' };
const FONT: FileFormat = { kind: 'react', route: 'font', label: 'FONT', color: '#6e6e73' };
const IMAGE: FileFormat = { kind: 'preview', label: 'IMG', color: '#0e9f9b' };

const FORMATS: Record<string, FileFormat> = {
    pdf: PDF,
    xlsx: SHEET,
    xlsm: SHEET,
    xls: SHEET,
    ods: SHEET,
    csv: { ...SHEET, label: 'CSV' },
    tsv: { ...SHEET, label: 'TSV' },
    docx: WORD,
    dotx: WORD,
    pptx: SLIDES,
    pptm: SLIDES,
    epub: { kind: 'react', route: 'epub', label: 'EPUB', color: '#8e4ec6' },
    ttf: FONT,
    otf: FONT,
    woff: FONT,
    woff2: FONT,
    parquet: { kind: 'react', route: 'parquet', label: 'PQ', color: '#0f766e' },
    icns: { kind: 'react', route: 'icns', label: 'ICNS', color: '#6e6e73' },
    jpg: IMAGE,
    jpeg: IMAGE,
    png: IMAGE,
    gif: IMAGE,
    webp: IMAGE,
    bmp: IMAGE,
    heic: IMAGE,
    heif: IMAGE,
    tif: IMAGE,
    tiff: IMAGE,
};

export const SUPPORTED_SUMMARY = 'PDF, Excel, CSV, Word, PowerPoint, EPUB, fonts, Parquet and images';

/** Lower-case extension without the dot ('' if none). */
export function extensionOf(name: string): string {
    const match = /\.([^./\\]+)$/.exec(name);
    return match ? match[1].toLowerCase() : '';
}

export function formatOf(name: string): FileFormat | null {
    return FORMATS[extensionOf(name)] ?? null;
}

/** The page that shows the file (absolute, from the app's root), or null for Quick Look / unsupported files. */
export function viewerUrl(file: { id: string, name: string }): string | null {
    const format = formatOf(file.name);
    const id = encodeURIComponent(file.id);
    if (format?.kind === 'pdf') {
        return `/pdf/viewer.html?id=${id}`;
    }
    if (format?.kind === 'react' && format.route) {
        return `/react/index.html?id=${id}&route=${format.route}`;
    }
    return null;
}

/** File name without its extension, for display. */
export function displayName(name: string): string {
    return formatOf(name) ? name.replace(/\.[^./\\]+$/, '') : name;
}
