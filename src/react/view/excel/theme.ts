import { getConfigs } from '../../util/vscodeConfig.ts';

export function getExcelThemeColor(name: string, fallback: string): string {
    const root = document.querySelector('.excel-viewer') ?? document.documentElement;
    const value = getComputedStyle(root).getPropertyValue(name).trim();
    return value || fallback;
}

export function resolveExcelCellBg(bgcolor?: string): string {
    if (!bgcolor || bgcolor === '#ffffff' || bgcolor === '#fff') {
        return getExcelThemeColor('--excel-cell-bg', '#ffffff');
    }
    return bgcolor;
}

export function resolveExcelCellColor(color?: string, bgcolor?: string): string {
    let resolved = color;
    if (!color || color === '#0a0a0a' || color === '#000000' || color === '#000') {
        resolved = getExcelThemeColor('--excel-fg', '#0a0a0a');
    }
    if (isAppDarkGrid()) {
        return readableOn(resolved, resolveExcelCellBg(bgcolor));
    }
    return resolved;
}

/* The ANYfile app's dark grid: text the workbook colors for a white sheet (dark text, or the default
   text on its own light fills) would be unreadable, so such text gets the readable color. */

function isAppDarkGrid(): boolean {
    return document.body.classList.contains('office-dark') && getConfigs()?.mobile === true;
}

function luminance(color: string): number | null {
    const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
    let rgb: number[];
    if (hex) {
        const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
        rgb = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
    } else {
        const match = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
        if (!match) return null;
        rgb = match.slice(1, 4).map(Number);
    }
    const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readableOn(color: string, bgcolor: string): string {
    const text = luminance(color);
    const bg = luminance(bgcolor);
    if (text === null || bg === null) return color;
    const contrast = (Math.max(text, bg) + 0.05) / (Math.min(text, bg) + 0.05);
    if (contrast >= 3) return color;
    return bg > 0.18 ? '#1c1c1e' : getExcelThemeColor('--excel-fg', '#f2f2f7');
}
