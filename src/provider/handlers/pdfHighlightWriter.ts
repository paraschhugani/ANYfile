/**
 * Pure pdf-lib logic that writes text highlights into a PDF as standard /Highlight annotations.
 *
 * This module must not import 'vscode': it is bundled into Node tests and called directly.
 * pdf-lib is external in both extension builds and missing from the web build, so it is only
 * loaded lazily (a top-level import would crash the web extension host).
 */
import type * as PdfLibTypes from 'pdf-lib';

type PdfLib = typeof PdfLibTypes;
type PDFDocument = PdfLibTypes.PDFDocument;
type PDFPage = PdfLibTypes.PDFPage;
type PDFArray = PdfLibTypes.PDFArray;
type PDFDict = PdfLibTypes.PDFDict;
type PDFObject = PdfLibTypes.PDFObject;
type PDFRef = PdfLibTypes.PDFRef;

export interface PdfHighlightAddOp {
    type: 'add';
    /** Unique id, written as the annotation /NM */
    id: string;
    /** 0-based page index */
    pageIndex: number;
    /** PDF user space, 8 numbers per quad: xLeft,yTop, xRight,yTop, xLeft,yBottom, xRight,yBottom */
    quadPoints: number[];
    rect?: number[];
    /** r,g,b in 0..1 */
    color?: number[];
    text?: string;
    fingerprint?: string | null;
}

export interface PdfHighlightRemoveOp {
    type: 'remove';
    /** /NM of a highlight created in this editor session */
    id?: string;
    /** PDF.js annotation id (e.g. '12R') of a highlight that already exists in the loaded file */
    ref?: string;
    pageIndex: number;
    fingerprint?: string | null;
}

export type PdfHighlightOp = PdfHighlightAddOp | PdfHighlightRemoveOp;

export interface PdfHighlightOpResult {
    ok: boolean;
    /** whether the document was modified by this op */
    changed: boolean;
    /** true when a highlight identified by its PDF.js ref (baked into the loaded document) was removed */
    removedRef?: boolean;
    error?: string;
}

export type PdfHighlightErrorCode = 'unavailable' | 'encrypted' | 'invalid-pdf' | 'signed';

export class PdfHighlightError extends Error {
    constructor(public readonly code: PdfHighlightErrorCode, message: string) {
        super(message);
        this.name = 'PdfHighlightError';
    }
}

export const PDF_HIGHLIGHT_ID_PREFIX = 'vso-hl-';
const DEFAULT_COLOR = [1, 1, 0];
const RECT_PADDING = 1;
const MAX_QUAD_POINTS = 8 * 10000;
const MAX_COORDINATE = 1e6;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/i;
/** PDF.js hashes the first 1024 bytes when the trailer has no usable /ID (see `get fingerprints()` in pdf.worker.js) */
const FINGERPRINT_FIRST_BYTES = 1024;

let cachedPdfLib: PdfLib | null = null;

/** Loads pdf-lib lazily; throws PdfHighlightError('unavailable') when it cannot be loaded (e.g. web extension host). */
export function loadPdfLib(): PdfLib {
    if (cachedPdfLib) {
        return cachedPdfLib;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const lib = require('pdf-lib') as PdfLib;
        if (!lib?.PDFDocument) {
            throw new Error('pdf-lib has no PDFDocument export');
        }
        cachedPdfLib = lib;
        return lib;
    } catch {
        throw new PdfHighlightError('unavailable', 'Saving highlights into PDF files is not supported in this environment.');
    }
}

export function isPdfLibAvailable(): boolean {
    try {
        loadPdfLib();
        return true;
    } catch {
        return false;
    }
}

/** Returns the lower-cased fingerprint when it is a 32-hex string (what PDF.js produces from an MD5 or a 16-byte /ID), else null. */
export function normalizeFingerprint(fingerprint: unknown): string | null {
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
        return null;
    }
    const lower = fingerprint.toLowerCase();
    return /^0+$/.test(lower) ? null : lower;
}

/**
 * The fingerprint PDF.js computes for a file without /ID: MD5 of the first 1024 bytes,
 * zero-padded to 1024 bytes for shorter files (PDF.js calculateMD5 reads past the end as 0).
 * Uses Node's crypto lazily; returns null when it is unavailable.
 */
export function computeFallbackFingerprint(bytes: Uint8Array): string | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crypto = require('crypto') as typeof import('crypto');
        const head = new Uint8Array(FINGERPRINT_FIRST_BYTES);
        head.set(bytes.subarray(0, FINGERPRINT_FIRST_BYTES));
        return crypto.createHash('md5').update(head).digest('hex');
    } catch {
        return null;
    }
}

/** Parses a PDF.js annotation id built by Ref.toString(): `${num}R` for gen 0, `${num}R${gen}` otherwise. */
export function parseAnnotationRef(ref: unknown): { objectNumber: number, generationNumber: number } | null {
    if (typeof ref !== 'string') {
        return null;
    }
    const match = /^(\d+)R(\d*)$/.exec(ref);
    if (!match) {
        return null;
    }
    return {
        objectNumber: Number(match[1]),
        generationNumber: match[2] ? Number(match[2]) : 0,
    };
}

function round3(value: number): number {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? 0 : rounded;
}

function formatNumber(value: number): string {
    return String(round3(value));
}

function isValidId(id: unknown): id is string {
    return typeof id === 'string' && ID_PATTERN.test(id);
}

function sanitizeQuadPoints(quadPoints: unknown): number[] | null {
    if (!Array.isArray(quadPoints) || quadPoints.length === 0 || quadPoints.length % 8 !== 0 || quadPoints.length > MAX_QUAD_POINTS) {
        return null;
    }
    const result: number[] = [];
    for (const value of quadPoints) {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
            return null;
        }
        result.push(round3(value));
    }
    return result;
}

function sanitizeColor(color: unknown): number[] {
    if (!Array.isArray(color) || color.length !== 3 || !color.every(c => typeof c === 'number' && Number.isFinite(c))) {
        return [...DEFAULT_COLOR];
    }
    return color.map((c: number) => Math.round(Math.min(1, Math.max(0, c)) * 10000) / 10000);
}

interface Box { minX: number, minY: number, maxX: number, maxY: number }

function quadBox(quadPoints: number[], quadIndex: number): Box {
    const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = quadIndex * 8; i < quadIndex * 8 + 8; i += 2) {
        box.minX = Math.min(box.minX, quadPoints[i]);
        box.maxX = Math.max(box.maxX, quadPoints[i]);
        box.minY = Math.min(box.minY, quadPoints[i + 1]);
        box.maxY = Math.max(box.maxY, quadPoints[i + 1]);
    }
    return box;
}

/** Bounding box of all quads, padded and rounded outwards so every quad point lies inside (PDF.js drops quads outside /Rect). */
export function computeHighlightRect(quadPoints: number[]): [number, number, number, number] {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < quadPoints.length; i += 2) {
        minX = Math.min(minX, quadPoints[i]);
        maxX = Math.max(maxX, quadPoints[i]);
        minY = Math.min(minY, quadPoints[i + 1]);
        maxY = Math.max(maxY, quadPoints[i + 1]);
    }
    return [
        Math.floor((minX - RECT_PADDING) * 1000) / 1000,
        Math.floor((minY - RECT_PADDING) * 1000) / 1000,
        Math.ceil((maxX + RECT_PADDING) * 1000) / 1000,
        Math.ceil((maxY + RECT_PADDING) * 1000) / 1000,
    ];
}

/** Appearance content: multiply blend, fill color, one rectangle per quad. */
export function buildHighlightAppearanceContent(quadPoints: number[], color: number[]): string {
    const lines = ['/GS0 gs', `${color.map(formatNumber).join(' ')} rg`];
    for (let quad = 0; quad < quadPoints.length / 8; quad++) {
        const box = quadBox(quadPoints, quad);
        lines.push(`${formatNumber(box.minX)} ${formatNumber(box.minY)} ${formatNumber(box.maxX - box.minX)} ${formatNumber(box.maxY - box.minY)} re`);
    }
    lines.push('f');
    return lines.join('\n') + '\n';
}

function parsePdfVersion(text: string | undefined): number {
    const match = /(\d+)\.(\d+)/.exec(text ?? '');
    return match ? Number(match[1]) + Number(match[2]) / 10 : 0;
}

export interface PdfHighlightSaveOptions {
    /** PDF.js fingerprints[0] of the loaded document; written as /ID when the file has none */
    fingerprint?: string | null;
}

export interface ApplyPdfHighlightOptions extends PdfHighlightSaveOptions {
    /** Save even though the PDF is digitally signed (the signature becomes invalid). Default false. */
    allowSigned?: boolean;
    /** Date written as /M and /CreationDate (for tests). */
    now?: Date;
    /** Receives one result per op, index-aligned with `ops`. */
    onResults?: (results: PdfHighlightOpResult[]) => void;
}

/**
 * A loaded PDF that highlight ops can be applied to, then saved.
 * Split into load / apply / save so callers can confirm a signed-PDF save between load and apply.
 */
export class PdfHighlightDocument {

    private constructor(
        private readonly lib: PdfLib,
        private readonly doc: PDFDocument,
        private readonly originalBytes: Uint8Array,
        public readonly signed: boolean,
    ) { }

    /** Throws PdfHighlightError with code 'unavailable', 'encrypted' or 'invalid-pdf'. */
    static async load(bytes: Uint8Array): Promise<PdfHighlightDocument> {
        const lib = loadPdfLib();
        let doc: PDFDocument;
        try {
            // pdf-lib's EncryptedPDFError fails instanceof checks (ES5 Error subclass), so check isEncrypted instead.
            doc = await lib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new PdfHighlightError('invalid-pdf', `Failed to read the PDF: ${message}`);
        }
        if (doc.isEncrypted) {
            throw new PdfHighlightError('encrypted', 'This PDF is encrypted, so highlights cannot be saved into it.');
        }
        return new PdfHighlightDocument(lib, doc, bytes, detectSignature(lib, doc));
    }

    get pageCount(): number {
        return this.doc.getPageCount();
    }

    /** Applies ops in order; returns one result per op. Invalid ops fail individually without aborting the others. */
    apply(ops: PdfHighlightOp[], now: Date = new Date()): PdfHighlightOpResult[] {
        return ops.map(op => {
            try {
                if (op?.type === 'add') {
                    return this.add(op, now);
                }
                if (op?.type === 'remove') {
                    return this.remove(op);
                }
                return { ok: false, changed: false, error: 'Unknown highlight operation.' };
            } catch (error) {
                return { ok: false, changed: false, error: error instanceof Error ? error.message : String(error) };
            }
        });
    }

    /** Serializes the document. Writes /ID [<fp> <fp>] when the file has no /ID so PDF.js keeps the same fingerprint. */
    async save(options: PdfHighlightSaveOptions = {}): Promise<Uint8Array> {
        const { lib, doc } = this;
        const context = doc.context;
        if (!context.trailerInfo.ID) {
            const fingerprint = normalizeFingerprint(options.fingerprint) ?? computeFallbackFingerprint(this.originalBytes);
            if (fingerprint) {
                context.trailerInfo.ID = context.obj([lib.PDFHexString.of(fingerprint), lib.PDFHexString.of(fingerprint)]);
            }
        }
        return doc.save({
            // Cross-reference streams need PDF 1.5; keep classic xref tables for older files.
            useObjectStreams: this.pdfVersion() >= 1.5,
            addDefaultPage: false,
            updateFieldAppearances: false,
        });
    }

    private pdfVersion(): number {
        const { lib, doc } = this;
        const headerVersion = parsePdfVersion(doc.context.header.toString());
        let catalogVersion = 0;
        try {
            const version = doc.catalog.lookup(lib.PDFName.of('Version'));
            if (version instanceof lib.PDFName) {
                catalogVersion = parsePdfVersion(version.decodeText());
            }
        } catch {
            // ignore malformed /Version
        }
        return Math.max(headerVersion, catalogVersion);
    }

    private getPage(pageIndex: number): PDFPage | undefined {
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.doc.getPageCount()) {
            return undefined;
        }
        return this.doc.getPage(pageIndex);
    }

    private getAnnots(page: PDFPage, create: boolean): PDFArray | undefined {
        const { lib } = this;
        const annots = page.node.lookup(lib.PDFName.of('Annots'));
        if (annots instanceof lib.PDFArray) {
            return annots;
        }
        if (!create) {
            return undefined;
        }
        const created = this.doc.context.obj([]);
        page.node.set(lib.PDFName.of('Annots'), created);
        return created;
    }

    private add(op: PdfHighlightAddOp, now: Date): PdfHighlightOpResult {
        const { lib, doc } = this;
        const context = doc.context;
        if (!isValidId(op.id)) {
            return { ok: false, changed: false, error: 'Invalid highlight id.' };
        }
        const page = this.getPage(op.pageIndex);
        if (!page) {
            return { ok: false, changed: false, error: `Page ${op.pageIndex + 1} does not exist in the PDF.` };
        }
        const quadPoints = sanitizeQuadPoints(op.quadPoints);
        if (!quadPoints) {
            return { ok: false, changed: false, error: 'Invalid highlight area.' };
        }
        if (this.findById(op.id)) {
            // Already written (e.g. a re-sent op): nothing to do.
            return { ok: true, changed: false };
        }
        const color = sanitizeColor(op.color);
        const rect = computeHighlightRect(quadPoints);
        const appearance = context.stream(buildHighlightAppearanceContent(quadPoints, color), {
            Type: 'XObject',
            Subtype: 'Form',
            FormType: 1,
            BBox: rect,
            Resources: {
                ExtGState: {
                    GS0: { Type: 'ExtGState', BM: 'Multiply' },
                },
            },
        });
        const appearanceRef = context.register(appearance);
        // No /T or /Contents: in PDF.js 3.1.81 those make HighlightAnnotationElement render a DOM
        // element above the text layer, which blocks text selection.
        const annot = context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: rect,
            QuadPoints: quadPoints,
            C: color,
            F: 4,
            P: page.ref,
            AP: { N: appearanceRef },
        });
        annot.set(lib.PDFName.of('NM'), lib.PDFString.of(op.id));
        annot.set(lib.PDFName.of('M'), lib.PDFString.fromDate(now));
        annot.set(lib.PDFName.of('CreationDate'), lib.PDFString.fromDate(now));
        const annotRef = context.register(annot);
        this.getAnnots(page, true)!.push(annotRef);
        return { ok: true, changed: true };
    }

    private remove(op: PdfHighlightRemoveOp): PdfHighlightOpResult {
        const hasId = op.id !== undefined && op.id !== null && op.id !== '';
        const hasRef = op.ref !== undefined && op.ref !== null && op.ref !== '';
        if (!hasId && !hasRef) {
            return { ok: false, changed: false, error: 'No highlight specified to remove.' };
        }
        if (hasId) {
            if (!isValidId(op.id)) {
                return { ok: false, changed: false, error: 'Invalid highlight id.' };
            }
            const found = this.findById(op.id, op.pageIndex);
            if (found) {
                return this.removeFound(found, false);
            }
            if (!hasRef) {
                // Its add never reached the file (e.g. it failed): nothing left to remove.
                return { ok: true, changed: false };
            }
        }
        const parsed = parseAnnotationRef(op.ref);
        if (!parsed) {
            return { ok: false, changed: false, error: 'This highlight cannot be removed because it has no object reference in the PDF.' };
        }
        const ref = this.lib.PDFRef.of(parsed.objectNumber, parsed.generationNumber);
        const found = this.findByRef(ref, op.pageIndex);
        if (!found) {
            return { ok: false, changed: false, error: 'The highlight was not found in the PDF; it may have been changed by another program.' };
        }
        return this.removeFound(found, true);
    }

    private removeFound(found: FoundAnnot, byRef: boolean): PdfHighlightOpResult {
        const { lib, doc } = this;
        const context = doc.context;
        const { annots, index, dict } = found;
        const subtype = dict.lookup(lib.PDFName.of('Subtype'));
        if (subtype !== lib.PDFName.of('Highlight')) {
            return { ok: false, changed: false, error: 'Only highlight annotations can be removed.' };
        }
        const entry = annots.get(index);
        annots.remove(index);
        const popup = dict.get(lib.PDFName.of('Popup'));
        if (popup instanceof lib.PDFRef) {
            for (let i = annots.size() - 1; i >= 0; i--) {
                if (annots.get(i) === popup) {
                    annots.remove(i);
                }
            }
            context.delete(popup);
        }
        if (entry instanceof lib.PDFRef) {
            if (readName(lib, dict.get(lib.PDFName.of('NM')))?.startsWith(PDF_HIGHLIGHT_ID_PREFIX)) {
                // Our own appearance stream is referenced only by this annotation.
                const ap = dict.lookup(lib.PDFName.of('AP'));
                const normal = ap instanceof lib.PDFDict ? ap.get(lib.PDFName.of('N')) : undefined;
                if (normal instanceof lib.PDFRef) {
                    context.delete(normal);
                }
            }
            context.delete(entry);
        }
        return { ok: true, changed: true, removedRef: byRef };
    }

    /** Pages to search: the given page first, then all others (in case the page index is stale). */
    private *candidatePages(pageIndex?: number): Generator<PDFPage> {
        const pages = this.doc.getPages();
        const first = typeof pageIndex === 'number' && Number.isInteger(pageIndex) ? pages[pageIndex] : undefined;
        if (first) {
            yield first;
        }
        for (const page of pages) {
            if (page !== first) {
                yield page;
            }
        }
    }

    private findById(id: string, pageIndex?: number): FoundAnnot | undefined {
        const { lib } = this;
        const nmName = lib.PDFName.of('NM');
        return this.findAnnot(pageIndex, (entry, dict) => readName(lib, dict?.get(nmName)) === id);
    }

    private findByRef(ref: PDFRef, pageIndex?: number): FoundAnnot | undefined {
        return this.findAnnot(pageIndex, entry => entry === ref);
    }

    private findAnnot(pageIndex: number | undefined, predicate: (entry: PDFObject, dict: PDFDict | undefined) => boolean): FoundAnnot | undefined {
        const { lib, doc } = this;
        for (const page of this.candidatePages(pageIndex)) {
            const annots = this.getAnnots(page, false);
            if (!annots) {
                continue;
            }
            for (let index = 0; index < annots.size(); index++) {
                const entry = annots.get(index);
                const resolved = doc.context.lookup(entry);
                const dict = resolved instanceof lib.PDFDict ? resolved : undefined;
                if (dict && predicate(entry, dict)) {
                    return { annots, index, dict };
                }
            }
        }
        return undefined;
    }
}

interface FoundAnnot {
    annots: PDFArray;
    index: number;
    dict: PDFDict;
}

function readName(lib: PdfLib, value: PDFObject | undefined): string | undefined {
    if (value instanceof lib.PDFString || value instanceof lib.PDFHexString) {
        return value.decodeText();
    }
    return undefined;
}

/** True when the AcroForm has a signature field (/FT /Sig, possibly inherited) with a value (/V). */
function detectSignature(lib: PdfLib, doc: PDFDocument): boolean {
    try {
        const acroForm = doc.catalog.lookup(lib.PDFName.of('AcroForm'));
        if (!(acroForm instanceof lib.PDFDict)) {
            return false;
        }
        const FT = lib.PDFName.of('FT');
        const V = lib.PDFName.of('V');
        const Kids = lib.PDFName.of('Kids');
        const Sig = lib.PDFName.of('Sig');
        const visited = new Set<PDFObject>();
        const walk = (fields: PDFObject | undefined, inheritedType: PDFObject | undefined, depth: number): boolean => {
            const array = doc.context.lookup(fields);
            if (!(array instanceof lib.PDFArray) || depth > 32) {
                return false;
            }
            for (let i = 0; i < array.size(); i++) {
                const field = doc.context.lookup(array.get(i));
                if (!(field instanceof lib.PDFDict) || visited.has(field)) {
                    continue;
                }
                visited.add(field);
                const fieldType = field.lookup(FT) ?? inheritedType;
                if (fieldType === Sig) {
                    const value = field.lookup(V);
                    if (value && value !== lib.PDFNull) {
                        return true;
                    }
                }
                if (walk(field.get(Kids), fieldType, depth + 1)) {
                    return true;
                }
            }
            return false;
        };
        return walk(acroForm.get(lib.PDFName.of('Fields')), undefined, 0);
    } catch {
        return false;
    }
}

/**
 * Loads `bytes`, applies all ops in order and returns the saved PDF.
 * Throws PdfHighlightError for unusable input ('unavailable', 'encrypted', 'invalid-pdf', 'signed' unless allowSigned).
 * Per-op failures (e.g. invalid page) do not throw; inspect them with `onResults`.
 */
export async function applyPdfHighlightOps(bytes: Uint8Array, ops: PdfHighlightOp[], options: ApplyPdfHighlightOptions = {}): Promise<Uint8Array> {
    const document = await PdfHighlightDocument.load(bytes);
    if (document.signed && !options.allowSigned) {
        throw new PdfHighlightError('signed', 'This PDF is digitally signed; saving highlights would invalidate the signature.');
    }
    const results = document.apply(ops, options.now);
    options.onResults?.(results);
    const fingerprint = options.fingerprint !== undefined ? options.fingerprint : pickFingerprint(ops);
    return document.save({ fingerprint });
}

/** First valid fingerprint carried by the ops. */
export function pickFingerprint(ops: Array<{ fingerprint?: string | null }>): string | null {
    for (const op of ops) {
        const fingerprint = normalizeFingerprint(op?.fingerprint);
        if (fingerprint) {
            return fingerprint;
        }
    }
    return null;
}
