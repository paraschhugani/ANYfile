// The ANYfile iPhone/iPad app (getConfigs().mobile): the page fits the screen width when the document opens
// and when the screen size or orientation changes, and two fingers zoom it. The editor's own zoom is applied
// when the pinch ends; while the fingers move, the pages are scaled with a CSS transform (Word.css).
import { useEffect, type RefObject } from "react";
import type { DocxEditorRef } from "@eigenpal/docx-editor-react";

/** Space between the page and the screen edges at fit width (px). */
const GUTTER = 10;
const MAX_ZOOM = 4;
/** Letter width (px at zoom 1): the usual page, until the document's own pages are laid out. */
const LETTER_WIDTH = 816;

interface Point {
    x: number;
    y: number;
}

/** A document point (page px at zoom 1, from the pages' corner) to keep at a screen point across a zoom change. */
interface Anchor {
    page: Point;
    screen: Point;
}

interface Pinch {
    distance: number;
    /** The editor's zoom when the pinch began, and the zoom the fingers ask for now. */
    zoom: number;
    target: number;
    /** Where the pages' scroll content was on screen, and the fingers' midpoint in it, when the pinch began. */
    contentOrigin: Point;
    start: Point;
    /** The document point that was between the fingers; `screen` follows the fingers. */
    anchor: Anchor;
}

/** The zoom that fits a Letter page in #root: the editor opens at it, then fits the document's own pages. */
export function initialFitZoom(): number {
    const width = document.getElementById("root")?.clientWidth || window.innerWidth;
    return Math.max(0.1, (width - 2 * GUTTER) / LETTER_WIDTH);
}

const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
const midpoint = (touches: TouchList): Point => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
});

export function useMobileZoom(
    enabled: boolean,
    viewerRef: RefObject<HTMLElement | null>,
    editorRef: RefObject<DocxEditorRef | null>,
    documentBuffer: ArrayBuffer | undefined,
) {
    useEffect(() => {
        const viewer = viewerRef.current;
        if (!enabled || !viewer || !documentBuffer) {
            return;
        }
        let pageWidth = 0;
        let fittedWidth = 0;
        let minZoom = 0.1;
        let pinch: Pinch | null = null;
        let fingerTargets: EventTarget[] = [];
        let frame = 0;
        let pinchEndFrame = 0;
        let stopWaiting = () => { };

        const scroller = () => viewer.querySelector<HTMLElement>(".docx-editor__scroll-container");
        const pages = () => viewer.querySelector<HTMLElement>(".paged-editor__pages");
        const clamp = (zoom: number, low = minZoom) => Math.min(Math.max(zoom, low), Math.max(MAX_ZOOM, minZoom));

        const anchorAt = (screen: Point): Anchor | null => {
            const box = pages()?.getBoundingClientRect();
            const zoom = editorRef.current?.getZoom();
            return box && zoom ? { screen, page: { x: (screen.x - box.left) / zoom, y: (screen.y - box.top) / zoom } } : null;
        };

        /**
         * Sets the editor's zoom, then sizes the scroll area to it and scrolls `anchor` back in place right when
         * the editor shows it: before the editor lays the pages out again and restores its own scroll position
         * from that moment (so it keeps ours). Call outside touch handlers (a discrete event would make React run
         * that layout in the same task).
         */
        const applyZoom = (zoom: number, anchor: Anchor | null, done?: () => void) => {
            stopWaiting();
            const editor = editorRef.current;
            const scaled = pages()?.parentElement; // the element the editor scales (style transform)
            const finish = () => {
                stopWaiting();
                // The editor scales the pages from their top center but keeps its desktop minimum width (the
                // page at zoom 1 plus the outline's gutters): size the scroll area to the zoomed page instead.
                viewer.style.setProperty("--word-mobile-min-width", `${Math.round(pageWidth * zoom + 2 * GUTTER)}px`);
                done?.();
                const area = scroller();
                const box = pages()?.getBoundingClientRect();
                if (anchor && area && box) {
                    area.scrollLeft += box.left + anchor.page.x * zoom - anchor.screen.x;
                    area.scrollTop += box.top + anchor.page.y * zoom - anchor.screen.y;
                }
            };
            if (!editor || !scaled || editor.getZoom() === zoom) {
                editor?.setZoom(zoom);
                finish();
                return;
            }
            const shown = () => editorRef.current?.getZoom() === zoom;
            const committed = new MutationObserver(() => shown() && finish());
            committed.observe(scaled, { attributes: true, attributeFilter: ["style"] });
            let frames = 0;
            const poll = () => {
                if (shown() || ++frames > 30) {
                    finish();
                } else {
                    frame = requestAnimationFrame(poll);
                }
            };
            frame = requestAnimationFrame(poll);
            stopWaiting = () => {
                committed.disconnect();
                cancelAnimationFrame(frame);
                stopWaiting = () => { };
            };
            editor.setZoom(zoom);
        };

        const fit = (keepTop: boolean) => {
            const area = scroller();
            pageWidth = 0;
            viewer.querySelectorAll<HTMLElement>(".paged-editor__pages .layout-page").forEach((page) => {
                pageWidth = Math.max(pageWidth, page.offsetWidth);
            });
            if (!area?.clientWidth || !pageWidth || pinch) {
                return;
            }
            const box = area.getBoundingClientRect();
            // On a new width, what was at the top of the view stays there.
            const anchor = keepTop ? anchorAt({ x: box.left + area.clientWidth / 2, y: box.top }) : null;
            fittedWidth = area.clientWidth;
            minZoom = Math.max(0.1, (fittedWidth - 2 * GUTTER) / pageWidth);
            applyZoom(minZoom, anchor);
        };

        // Fit once the pages are laid out, and again when the width changes (rotation, iPad split view).
        const fitWhenShown = () => {
            if (viewer.querySelector(".paged-editor__pages .layout-page")) {
                pagesShown.disconnect();
                fit(false);
            }
        };
        const pagesShown = new MutationObserver(fitWhenShown);
        pagesShown.observe(viewer, { childList: true, subtree: true });
        fitWhenShown();
        const resized = new ResizeObserver(() => {
            const width = scroller()?.clientWidth;
            if (fittedWidth && width && width !== fittedWidth) {
                fit(true);
            }
        });
        resized.observe(viewer);

        const onTouchStart = (event: TouchEvent) => {
            const area = scroller();
            const content = area?.firstElementChild;
            const editor = editorRef.current;
            // (not while the last pinch's zoom is still being applied: the pages are still transformed)
            const busy = pinch || viewer.classList.contains("word-viewer--pinching");
            if (event.touches.length !== 2 || busy || !content || !editor || !area.contains(event.target as Node)) {
                return;
            }
            const mid = midpoint(event.touches);
            const anchor = anchorAt(mid);
            if (!anchor) {
                return;
            }
            event.preventDefault();
            const contentBox = content.getBoundingClientRect();
            const zoom = editor.getZoom();
            pinch = {
                distance: distance(event.touches),
                zoom,
                target: zoom,
                contentOrigin: { x: contentBox.left, y: contentBox.top },
                start: { x: mid.x - contentBox.left, y: mid.y - contentBox.top },
                anchor,
            };
            viewer.style.setProperty("--word-pinch-transform", "none");
            viewer.classList.add("word-viewer--pinching");
            followFingers([...new Set([...event.touches].map(touch => touch.target))]);
        };

        const onTouchMove = (event: TouchEvent) => {
            if (!pinch || event.touches.length < 2) {
                return;
            }
            event.preventDefault();
            const mid = midpoint(event.touches);
            pinch.anchor.screen = mid;
            // A little below the fit while the fingers move; it springs back when they lift.
            pinch.target = clamp(pinch.zoom * distance(event.touches) / pinch.distance, minZoom * 0.75);
            const scale = pinch.target / pinch.zoom;
            // Keep the point that was between the fingers between them.
            const x = mid.x - pinch.contentOrigin.x - scale * pinch.start.x;
            const y = mid.y - pinch.contentOrigin.y - scale * pinch.start.y;
            viewer.style.setProperty("--word-pinch-transform", `translate(${x}px, ${y}px) scale(${scale})`);
        };

        const onTouchEnd = (event: TouchEvent) => {
            if (!pinch || event.touches.length >= 2) {
                return;
            }
            const { anchor } = pinch;
            const zoom = clamp(pinch.target);
            pinch = null;
            followFingers([]);
            pinchEndFrame = requestAnimationFrame(() => applyZoom(zoom, anchor, () => {
                viewer.classList.remove("word-viewer--pinching");
                viewer.style.removeProperty("--word-pinch-transform");
            }));
        };

        // A finger's touch events keep going to the element it first touched, even when the editor has
        // re-rendered that element away (they no longer reach the viewer then): listen there.
        const followFingers = (targets: EventTarget[]) => {
            for (const target of fingerTargets) {
                target.removeEventListener("touchmove", onTouchMove);
                target.removeEventListener("touchend", onTouchEnd);
                target.removeEventListener("touchcancel", onTouchEnd);
            }
            fingerTargets = targets;
            for (const target of fingerTargets) {
                target.addEventListener("touchmove", onTouchMove, { passive: false });
                target.addEventListener("touchend", onTouchEnd);
                target.addEventListener("touchcancel", onTouchEnd);
            }
        };

        viewer.addEventListener("touchstart", onTouchStart, { passive: false });
        return () => {
            pagesShown.disconnect();
            resized.disconnect();
            stopWaiting();
            cancelAnimationFrame(pinchEndFrame);
            viewer.removeEventListener("touchstart", onTouchStart);
            followFingers([]);
            viewer.classList.remove("word-viewer--pinching");
            viewer.style.removeProperty("--word-pinch-transform");
            viewer.style.removeProperty("--word-mobile-min-width");
        };
    }, [enabled, viewerRef, editorRef, documentBuffer]);
}
