import { CloseCircleFilled, CloseOutlined, InfoCircleOutlined, SearchOutlined } from '@ant-design/icons'
import { memo, ReactNode, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { handler } from '../../util/vscode'
import { getVscodeThemeColor } from '../../util/vscodeTheme'
import './FontViewerMobile.less'
import { FontInfo, formatUnicode, GlyphColors, loadFont, releaseCanvas, renderGlyphScaled } from './fontViewerMain'

/**
 * The font viewer in the app (iPhone/iPad): search on top, the glyphs in a full-width grid below, and a
 * sheet for the tapped glyph or the font's details. Only the rows near the viewport are in the page
 * (and drawn), so fonts with tens of thousands of glyphs stay within iOS's canvas memory.
 */

/** Cells are at least this wide (4 columns on a 390px iPhone) and keep the desktop list's 100:84 ratio. */
const MIN_CELL_WIDTH = 88
const CELL_RATIO = 84 / 100
/** Rows kept above and below the visible ones, so scrolling shows drawn glyphs. */
const OVERSCAN_ROWS = 4
const PREVIEW_WIDTH = 240, PREVIEW_HEIGHT = 160

function readGlyphColors(): GlyphColors {
    return {
        label: getVscodeThemeColor('--vscode-descriptionForeground', '#6e6e73'),
        glyph: getVscodeThemeColor('--vscode-foreground', '#1c1c1e'),
    }
}

/** The theme's colors for the canvases, updated when the system appearance changes. */
function useGlyphColors() {
    const [colors, setColors] = useState(readGlyphColors)
    useEffect(() => {
        const query = window.matchMedia('(prefers-color-scheme: dark)')
        const update = () => setColors(readGlyphColors())
        query.addEventListener('change', update)
        return () => query.removeEventListener('change', update)
    }, [])
    return colors
}

/**
 * Like the desktop search (a case-insensitive pattern on the glyph name, plain text when the pattern is
 * invalid); a single character also finds its own glyph (CJK fonts often have no glyph names).
 */
function glyphMatcher(search: string): (glyph: any) => boolean {
    let matchesName: (name: string) => boolean
    try {
        const pattern = new RegExp(search, 'i')
        matchesName = name => pattern.test(name)
    } catch {
        const needle = search.toLowerCase()
        matchesName = name => name.toLowerCase().includes(needle)
    }
    const codePoint = [...search].length === 1 ? search.codePointAt(0) : undefined
    return glyph => !!glyph && (matchesName(String(glyph.name ?? ''))
        || (codePoint !== undefined && !!glyph.unicodes?.includes(codePoint)))
}

function fontName(font: any, key: string): string {
    const names = font?.names?.[key]
    if (!names) return '-'
    return names.en ?? Object.values(names)[0] ?? '-'
}

interface GlyphCellProps {
    fontInfo: FontInfo
    glyphKey: string
    width: number
    height: number
    colors: GlyphColors
    selected: boolean
    onSelect: (key: string) => void
}

const GlyphCell = memo(function GlyphCell({ fontInfo, glyphKey, width, height, colors, selected, onSelect }: GlyphCellProps) {
    const ref = useRef<HTMLCanvasElement>(null)

    useLayoutEffect(() => {
        renderGlyphScaled(fontInfo, ref.current, glyphKey, width, height, 12, colors)
    }, [fontInfo, glyphKey, width, height, colors])

    useEffect(() => {
        const canvas = ref.current
        return () => releaseCanvas(canvas)
    }, [])

    return (
        <canvas
            ref={ref}
            className={`glyph-cell${selected ? ' selected' : ''}`}
            style={{ height }}
            data-glyph={glyphKey}
            onClick={() => onSelect(glyphKey)}
        />
    )
})

function Sheet({ title, onClose, children }: { title: string, onClose: () => void, children: ReactNode }) {
    return (
        <div className="fv-sheet-layer">
            <div className="fv-sheet-backdrop" onClick={onClose} />
            <div className="fv-sheet" role="dialog" aria-label={title}>
                <div className="fv-sheet-header">
                    <span className="fv-sheet-title">{title}</span>
                    <button type="button" className="fv-sheet-close" aria-label="Close" onClick={onClose}>
                        <CloseOutlined />
                    </button>
                </div>
                {children}
            </div>
        </div>
    )
}

export default function FontViewerMobile() {
    const [fontInfo, setFontInfo] = useState<FontInfo>(null)
    const [error, setError] = useState('')
    const [search, setSearch] = useState('')
    const deferredSearch = useDeferredValue(search)
    const [selectedKey, setSelectedKey] = useState<string | null>(null)
    const [showFontInfo, setShowFontInfo] = useState(false)
    const [size, setSize] = useState({ width: 0, height: 0 })
    const [scrollTop, setScrollTop] = useState(0)
    const gridRef = useRef<HTMLDivElement>(null)
    const previewRef = useRef<HTMLCanvasElement>(null)
    const colors = useGlyphColors()
    const font = fontInfo?.font

    useEffect(() => {
        handler.on('open', async (content) => {
            try {
                const info = await loadFont(content)
                setFontInfo(info)
                setSelectedKey(null)
                setError('')
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
            }
        }).emit('init')
    }, [])

    // The grid's size (it fills the viewer below the search bar); also on rotation.
    useEffect(() => {
        const grid = gridRef.current
        const observer = new ResizeObserver(() => {
            setSize(prev => (prev.width === grid.clientWidth && prev.height === grid.clientHeight)
                ? prev : { width: grid.clientWidth, height: grid.clientHeight })
            setScrollTop(grid.scrollTop)
        })
        observer.observe(grid)
        return () => observer.disconnect()
    }, [])

    const allKeys = useMemo(() => font ? Object.keys(font.glyphs.glyphs) : [], [font])
    const glyphKeys = useMemo(() => {
        if (!deferredSearch) return allKeys
        const matches = glyphMatcher(deferredSearch)
        return allKeys.filter(key => matches(font.glyphs.get(Number(key))))
    }, [font, allKeys, deferredSearch])

    const columns = Math.max(3, Math.floor(size.width / MIN_CELL_WIDTH))
    const cellWidth = size.width / columns
    const cellHeight = Math.round(cellWidth * CELL_RATIO)
    const rows = Math.ceil(glyphKeys.length / columns)
    const topRow = cellHeight ? Math.floor(scrollTop / cellHeight) : 0
    const firstRow = Math.max(0, topRow - OVERSCAN_ROWS)
    const lastRow = cellHeight ? Math.min(rows, topRow + Math.ceil(size.height / cellHeight) + 1 + OVERSCAN_ROWS) : 0
    const visibleKeys = glyphKeys.slice(firstRow * columns, lastRow * columns)

    const onScroll = () => {
        const top = gridRef.current.scrollTop
        // Re-render only when another row reaches the top.
        setScrollTop(prev => (cellHeight && Math.floor(prev / cellHeight) === Math.floor(top / cellHeight)) ? prev : top)
    }

    const changeSearch = (value: string) => {
        gridRef.current.scrollTop = 0
        setScrollTop(0)
        setSearch(value)
    }

    const selectedGlyph = font && selectedKey !== null ? font.glyphs.get(Number(selectedKey)) : null

    useLayoutEffect(() => {
        const canvas = previewRef.current
        if (!canvas || !fontInfo || selectedKey === null) return
        renderGlyphScaled(fontInfo, canvas, selectedKey, PREVIEW_WIDTH, PREVIEW_HEIGHT, 14, colors)
        return () => releaseCanvas(canvas)
    }, [fontInfo, selectedKey, colors])

    let message = ''
    if (error) message = `This font could not be read: ${error}`
    else if (!font) message = 'Loading font…'
    else if (!glyphKeys.length) message = 'No glyphs match the search'

    return (
        <div className="font-viewer-mobile">
            <div className="fv-toolbar">
                <div className="fv-search-row">
                    <label className="fv-search">
                        <SearchOutlined className="fv-search-icon" />
                        <input
                            type="text"
                            placeholder="Search by name or character"
                            value={search}
                            enterKeyHint="search"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={e => changeSearch(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                        />
                        {search && (
                            <button type="button" className="fv-search-clear" aria-label="Clear search" onClick={() => changeSearch('')}>
                                <CloseCircleFilled />
                            </button>
                        )}
                    </label>
                    <button type="button" className="fv-info-button" aria-label="Font details" onClick={() => setShowFontInfo(true)}>
                        <InfoCircleOutlined />
                    </button>
                </div>
                <div className="fv-count">
                    {font ? `${glyphKeys.length} / ${allKeys.length} glyphs` : ' '}
                </div>
            </div>

            <div
                className="fv-grid"
                ref={gridRef}
                onScroll={onScroll}
                // Scrolling the glyphs closes the keyboard.
                onTouchStart={() => (document.activeElement as HTMLElement)?.blur?.()}
            >
                {message ? <div className="fv-message">{message}</div> : (
                    <div className="fv-spacer" style={{ height: rows * cellHeight }}>
                        <div
                            className="fv-cells"
                            style={{ top: firstRow * cellHeight, gridTemplateColumns: `repeat(${columns}, 1fr)` }}
                        >
                            {visibleKeys.map(key => (
                                <GlyphCell
                                    key={key}
                                    fontInfo={fontInfo}
                                    glyphKey={key}
                                    width={cellWidth}
                                    height={cellHeight}
                                    colors={colors}
                                    selected={selectedKey === key}
                                    onSelect={setSelectedKey}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {selectedGlyph && (
                <Sheet title="Character" onClose={() => setSelectedKey(null)}>
                    <div className="fv-preview">
                        <canvas ref={previewRef} style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }} />
                    </div>
                    <dl className="fv-info">
                        <div><dt>Unicode</dt><dd>{selectedGlyph.unicodes?.map(formatUnicode).join(', ') || '-'}</dd></div>
                        <div><dt>Name</dt><dd>{selectedGlyph.name || '-'}</dd></div>
                        <div><dt>Class</dt><dd>{selectedGlyph.name ? `${fontName(font, 'fontFamily')}-${selectedGlyph.name}` : '-'}</dd></div>
                    </dl>
                </Sheet>
            )}

            {showFontInfo && (
                <Sheet title="Font" onClose={() => setShowFontInfo(false)}>
                    <dl className="fv-info">
                        {!font ? (
                            <div><dt>Status</dt><dd>{error || 'Waiting for font file…'}</dd></div>
                        ) : (
                            <>
                                <div><dt>Family</dt><dd>{fontName(font, 'fontFamily')}</dd></div>
                                <div><dt>Style</dt><dd>{fontName(font, 'fontSubfamily')}</dd></div>
                                <div><dt>Format</dt><dd>{font.outlinesFormat}</dd></div>
                                <div><dt>Version</dt><dd>{fontName(font, 'version')}</dd></div>
                                <div><dt>Glyphs</dt><dd>{allKeys.length}</dd></div>
                            </>
                        )}
                    </dl>
                </Sheet>
            )}
        </div>
    )
}
