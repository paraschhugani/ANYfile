import opentype from 'opentype.js';
import { arrayBufferFromPayload, type OfficeOpenPayload } from '../../util/loadOfficeContent';

export interface FontInfo {
    font: any;
    fontScale: number;
    fontSize: number;
    fontBaseline: number;
}

async function loadFontAsBuffer(source: string | OfficeOpenPayload): Promise<ArrayBuffer> {
    const path = typeof source === 'string' ? source : source.path ?? '';
    let fontBuffer: Promise<ArrayBuffer>;
    if (typeof source !== 'string' && source.buffer) {
        fontBuffer = Promise.resolve(arrayBufferFromPayload(source));
    } else if (typeof source === 'string') {
        fontBuffer = fetch(source).then(f => f.arrayBuffer());
    } else {
        fontBuffer = fetch(path).then(f => f.arrayBuffer());
    }
    if (path.includes('woff2')) {
        const loadScript = (src) => new Promise((onload) => document.documentElement.append(
            Object.assign(document.createElement('script'), { src, onload })
        ));
        return loadScript('woff2_decompress_binding.js')
            .then(() => new Promise((done) => window['Module'] = { onRuntimeInitialized: done }))
            .then(async () => window['Module'].decompress(await fontBuffer))
            .then(buffer => Uint8Array.from(buffer).buffer)
    }
    return fontBuffer;
}

const cellWidth = 100, cellHeight = 84;

export async function loadFont(source: string | OfficeOpenPayload): Promise<FontInfo> {
    const font = opentype.parse(await loadFontAsBuffer(source))

    const cellMarginTop = 20, cellMarginBottom = 20, cellMarginLeftRight = 1;
    const w = cellWidth - cellMarginLeftRight * 2,
        h = cellHeight - cellMarginTop - cellMarginBottom,
        head = font.tables.head,
        maxHeight = head.yMax - head.yMin;

    return {
        font,
        fontBaseline: cellMarginTop + h * head.yMax / maxHeight,
        fontSize: Math.min(w / (head.xMax - head.xMin), h / maxHeight) * font.unitsPerEm,
        fontScale: Math.min(w / (head.xMax - head.xMin), h / maxHeight)
    }
}

function limitLength(text: string = '', length: number = 11) {
    if (text.length > length) return text.slice(0, length) + '...';
    return text;
}

function renderGlyph(
    fontInfo: FontInfo,
    canvas: HTMLCanvasElement,
    glyphIndex: string | number,
    width: number,
    height: number,
    labelSize = 14,
) {
    const { font } = fontInfo;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    if (glyphIndex >= font.numGlyphs) return;
    const glyph = font.glyphs.glyphs[glyphIndex];
    drawGlyph(fontInfo, ctx, glyph, limitLength(glyph.name, width > cellWidth ? 24 : 11), width, height,
        `${labelSize}px Arial`, '#242424', '#333');
}

/** Draws the glyph centered in a width x height cell (100x84 is the list's cell) with its label below. */
function drawGlyph(
    fontInfo: FontInfo,
    ctx: CanvasRenderingContext2D,
    glyph: any,
    label: string,
    width: number,
    height: number,
    labelFont: string,
    labelColor: string,
    glyphColor: string,
) {
    const { fontScale, fontSize, fontBaseline } = fontInfo;
    const scale = width / cellWidth;
    const glyphWidth = glyph.advanceWidth * fontScale * scale;
    const xCenter = (width - glyphWidth) / 2;
    const baseline = fontBaseline * scale;
    const scaledFontSize = fontSize * scale;
    ctx.font = labelFont;
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.fillText(label, width / 2, height - 10 * scale);
    ctx.fillStyle = '#FFFFFF';
    const path = glyph.getPath(xCenter, baseline - 10 * scale, scaledFontSize);
    path.fill = glyphColor;
    path.draw(ctx);
}

export interface GlyphColors {
    label: string;
    glyph: string;
}

/** Shortens `text` with an ellipsis until it fits in `maxWidth` (in the context's current font). */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let length = text.length;
    while (length > 1 && ctx.measureText(text.slice(0, length) + '…').width > maxWidth) {
        length--;
    }
    return text.slice(0, length) + '…';
}

/**
 * The app (iPhone/iPad): draws a glyph sharply at the screen's pixel ratio in a cell of `width` x `height`
 * CSS pixels, in the theme's colors. Call it again to redraw (e.g. after a theme change); `releaseCanvas`
 * frees the canvas memory (iOS limits the total memory of all canvases).
 */
export function renderGlyphScaled(
    fontInfo: FontInfo,
    canvas: HTMLCanvasElement,
    glyphIndex: string | number,
    width: number,
    height: number,
    labelSize: number,
    colors: GlyphColors,
) {
    const { font } = fontInfo;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const index = Number(glyphIndex);
    if (!(index < font.numGlyphs)) return;
    const glyph = font.glyphs.get(index);
    if (!glyph) return;
    const labelFont = `${labelSize}px -apple-system, system-ui, sans-serif`;
    ctx.font = labelFont;
    // Glyphs without a name (e.g. in many CJK fonts) show their code point instead.
    const label = glyph.name || (glyph.unicode !== undefined ? `U+${formatUnicode(glyph.unicode)}` : '');
    drawGlyph(fontInfo, ctx, glyph, fitText(ctx, String(label), width - 8), width, height, labelFont, colors.label, colors.glyph);
}

export function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
}

export function renderGlyphItem(fontInfo: FontInfo, canvas: HTMLCanvasElement, glyphIndex) {
    renderGlyph(fontInfo, canvas, glyphIndex, cellWidth, cellHeight);
}

export function renderGlyphPreview(fontInfo: FontInfo, canvas: HTMLCanvasElement, glyphIndex) {
    renderGlyph(fontInfo, canvas, glyphIndex, 180, 120, 12);
}

export function formatUnicode(unicode) {
    unicode = unicode.toString(16);
    if (unicode.length > 4) {
        return ("000000" + unicode.toUpperCase()).substr(-6)
    } else {
        return ("0000" + unicode.toUpperCase()).substr(-4)
    }
}