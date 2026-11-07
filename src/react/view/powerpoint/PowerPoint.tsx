import { AppstoreOutlined, CloseOutlined, LeftOutlined, MoonOutlined, RightOutlined, SunOutlined } from "@ant-design/icons";
import { Alert, Layout, Spin } from "antd";
import { PPTXViewer } from "pptxviewjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { handler, loadDarkMode, applyDarkMode } from "../../util/vscode";
import { loadOfficeBuffer } from "../../util/loadOfficeContent";
import { getConfigs } from "../../util/vscodeConfig";
import './PowerPoint.css';

const { Sider, Content } = Layout;

const THUMB_WIDTH = 192;
const THUMB_HEIGHT = 108;
const SIDER_WIDTH = 220;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const WHEEL_NAV_INTERVAL_MS = 300;
const WHEEL_ZOOM_BASE = 1.004;
const PINCH_ZOOM_GAIN = 2.5;

// ANYfile app (iPhone/iPad): the slide fits the screen, thumbnails live in a drawer, swipes change slides.
const IS_MOBILE = getConfigs()?.mobile === true;
const MOBILE_THUMB_WIDTH = 240;
const FIT_MARGIN = 8;
const SWIPE_MIN_DISTANCE = 60;
const DOUBLE_TAP_ZOOM = 2.5;
// Largest main canvas (in device pixels) when re-rendering a zoomed slide; iOS caps canvases at 16.7M pixels.
const MAX_CANVAS_PIXELS = 12_000_000;

async function waitForCanvasContainer(wrap: HTMLElement): Promise<{ width: number; height: number }> {
    for (let i = 0; i < 60; i++) {
        const width = wrap.clientWidth;
        const height = wrap.clientHeight;
        if (width > 0 && height > 0) {
            return { width, height };
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    return { width: wrap.clientWidth, height: wrap.clientHeight };
}

function applyCanvasSize(canvas: HTMLCanvasElement, width: number, height: number) {
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
}

function clampPan(
    x: number,
    y: number,
    zoomLevel: number,
    wrap: HTMLElement,
    canvas: HTMLCanvasElement,
) {
    if (zoomLevel <= 1) {
        return { x: 0, y: 0 };
    }
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const baseW = parseFloat(canvas.style.width) || canvas.clientWidth;
    const baseH = parseFloat(canvas.style.height) || canvas.clientHeight;
    const maxX = Math.max(0, (baseW * zoomLevel - wrapW) / 2);
    const maxY = Math.max(0, (baseH * zoomLevel - wrapH) / 2);
    return {
        x: Math.min(maxX, Math.max(-maxX, x)),
        y: Math.min(maxY, Math.max(-maxY, y)),
    };
}

function getStageTransform(zoom: number, pan: { x: number; y: number }) {
    if (zoom === 1 && pan.x === 0 && pan.y === 0) {
        return undefined;
    }
    return `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
}

async function generateThumbnails(viewer: PPTXViewer, count: number): Promise<string[]> {
    const offscreen = document.createElement('canvas');
    offscreen.width = THUMB_WIDTH;
    offscreen.height = THUMB_HEIGHT;
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
        await viewer.renderSlide(i, offscreen);
        urls.push(offscreen.toDataURL('image/jpeg', 0.85));
    }
    return urls;
}

type RenderQueue = <T>(task: () => Promise<T>) => Promise<T>;

// pptxviewjs shares one drawing state between canvases: on the phone, renders (main slide and
// thumbnails) run one at a time so changing slides while thumbnails are made cannot mix them up.
function createRenderQueue(): RenderQueue {
    let last: Promise<unknown> = Promise.resolve();
    return task => {
        const run = last.then(task);
        last = run.catch(() => undefined);
        return run;
    };
}

type PptxInternals = {
    processor?: {
        getSlideDimensions?: () => { cx?: number; cy?: number };
        processor?: { setPixelRatio?: (ratio: number) => void };
    };
};

function getSlideAspect(viewer: PPTXViewer) {
    const size = (viewer as unknown as PptxInternals).processor?.getSlideDimensions?.();
    return size?.cx > 0 && size?.cy > 0 ? size.cx / size.cy : 16 / 9;
}

// The renderer draws at window.devicePixelRatio; a zoomed slide is drawn with more pixels to stay sharp.
function setRenderPixelRatio(viewer: PPTXViewer, ratio: number) {
    (viewer as unknown as PptxInternals).processor?.processor?.setPixelRatio?.(ratio);
}

function getMainPixelRatio(canvas: HTMLCanvasElement, zoom: number) {
    const dpr = window.devicePixelRatio || 1;
    const area = (parseFloat(canvas.style.width) || 1) * (parseFloat(canvas.style.height) || 1);
    const limit = Math.max(dpr, Math.sqrt(MAX_CANVAS_PIXELS / area));
    return Math.min(limit, Math.round(dpr * Math.max(1, zoom) * 4) / 4);
}

// The largest whole-pixel slide size within maxWidth x maxHeight. The renderer rounds the slide's area to
// whole pixels: pick a size it covers exactly, so no blank line shows along an edge.
function slideCanvasSize(maxWidth: number, maxHeight: number, aspect: number) {
    const largest = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * aspect)));
    for (let width = largest; width > Math.max(0, largest - 16); width--) {
        const height = width / aspect;
        const fraction = height - Math.floor(height);
        if ((fraction < 1e-6 || fraction >= 0.5) && Math.ceil(height - 1e-6) <= maxHeight) {
            return { width, height: Math.max(1, Math.ceil(height - 1e-6)) };
        }
    }
    return { width: largest, height: Math.max(1, Math.floor(largest / aspect)) };
}

// The slide's size in the canvas area (inside the safe-area padding and a margin).
function fitSlideSize(wrap: HTMLElement, aspect: number) {
    const style = getComputedStyle(wrap);
    const width = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2 * FIT_MARGIN;
    const height = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 2 * FIT_MARGIN;
    return slideCanvasSize(width, height, aspect);
}

async function generateMobileThumbnails(viewer: PPTXViewer, count: number, aspect: number, queue: RenderQueue): Promise<string[]> {
    const offscreen = document.createElement('canvas');
    // With a CSS size the renderer draws at the device pixel ratio: sharp thumbnails, in the slide's shape.
    const size = slideCanvasSize(MOBILE_THUMB_WIDTH, Infinity, aspect);
    offscreen.style.width = `${size.width}px`;
    offscreen.style.height = `${size.height}px`;
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
        urls.push(await queue(async () => {
            setRenderPixelRatio(viewer, window.devicePixelRatio || 1);
            await viewer.renderSlide(i, offscreen);
            return offscreen.toDataURL('image/jpeg', 0.85);
        }));
    }
    return urls;
}

export default function PowerPoint() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const canvasWrapRef = useRef<HTMLDivElement>(null);
    const mainPanelRef = useRef<HTMLDivElement>(null);
    const thumbListRef = useRef<HTMLDivElement>(null);
    const viewerRef = useRef<PPTXViewer | null>(null);
    const thumbRefs = useRef<(HTMLDivElement | null)[]>([]);
    const wheelNavLockRef = useRef(0);
    const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
    const zoomRef = useRef(1);
    const panRef = useRef({ x: 0, y: 0 });
    const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
    const touchPanRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
    const [loading, setLoading] = useState(true);
    const [thumbsLoading, setThumbsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [slideCount, setSlideCount] = useState(0);
    const [thumbnails, setThumbnails] = useState<string[]>([]);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const [dark, setDark] = useState(loadDarkMode);
    // Phone only: the slide shown (the viewer's own index also moves while thumbnails are rendered).
    const currentIndexRef = useRef(0);
    const slideAspectRef = useRef(16 / 9);
    const renderRatioRef = useRef(0);
    const [queueRender] = useState(createRenderQueue);
    const [drawerOpen, setDrawerOpen] = useState(false);

    useEffect(() => {
        document.body.classList.toggle('office-dark', dark);
    }, [dark]);

    const toggleDark = () => {
        setDark(prev => {
            const next = !prev;
            applyDarkMode(next);
            return next;
        });
    };

    useEffect(() => {
        zoomRef.current = zoom;
    }, [zoom]);

    useEffect(() => {
        panRef.current = pan;
    }, [pan]);

    const resetView = useCallback(() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, []);

    const applyPan = useCallback((x: number, y: number, zoomLevel = zoomRef.current) => {
        const wrap = canvasWrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) {
            return;
        }
        setPan(clampPan(x, y, zoomLevel, wrap, canvas));
    }, []);

    const setZoomLevel = useCallback((value: number | ((prev: number) => number)) => {
        setZoom(prev => {
            const next = typeof value === 'function' ? value(prev) : value;
            const clamped = Math.min(MAX_ZOOM, Math.max(IS_MOBILE ? 1 : MIN_ZOOM, next));
            if (clamped <= 1) {
                setPan({ x: 0, y: 0 });
            } else {
                const wrap = canvasWrapRef.current;
                const canvas = canvasRef.current;
                if (wrap && canvas) {
                    setPan(current => clampPan(current.x, current.y, clamped, wrap, canvas));
                }
            }
            return clamped;
        });
    }, []);

    const syncCanvasSize = useCallback(() => {
        const canvas = canvasRef.current;
        const wrap = canvasWrapRef.current;
        if (!canvas || !wrap) {
            return false;
        }
        const width = wrap.clientWidth;
        const height = wrap.clientHeight;
        if (width <= 0 || height <= 0) {
            return false;
        }
        if (IS_MOBILE) {
            const fit = fitSlideSize(wrap, slideAspectRef.current);
            applyCanvasSize(canvas, fit.width, fit.height);
            return true;
        }
        applyCanvasSize(canvas, width, height);
        return true;
    }, []);

    // Phone: draws slide `index` at the size that fits the screen, sharp at the current zoom.
    const renderMobileSlide = useCallback((index: number) => queueRender(async () => {
        const viewer = viewerRef.current;
        const canvas = canvasRef.current;
        if (!viewer || !canvas || index !== currentIndexRef.current || !syncCanvasSize()) {
            return;
        }
        renderRatioRef.current = getMainPixelRatio(canvas, zoomRef.current);
        setRenderPixelRatio(viewer, renderRatioRef.current);
        await viewer.render(canvas, { slideIndex: index });
    }), [queueRender, syncCanvasSize]);

    const rerenderSlide = useCallback(async () => {
        if (IS_MOBILE) {
            await renderMobileSlide(currentIndexRef.current);
            return;
        }
        const viewer = viewerRef.current;
        const canvas = canvasRef.current;
        if (!viewer || !canvas || !syncCanvasSize()) {
            return;
        }
        await viewer.render(canvas);
    }, [syncCanvasSize, renderMobileSlide]);

    const selectSlide = useCallback(async (index: number) => {
        const viewer = viewerRef.current;
        const canvas = canvasRef.current;
        if (!viewer || !canvas || index < 0 || index >= viewer.getSlideCount()) {
            return;
        }
        if (IS_MOBILE) {
            currentIndexRef.current = index;
            zoomRef.current = 1;
            setCurrentIndex(index);
            resetView();
            await renderMobileSlide(index);
            return;
        }
        syncCanvasSize();
        await viewer.goToSlide(index, canvas);
        setCurrentIndex(index);
        resetView();
    }, [syncCanvasSize, resetView, renderMobileSlide]);

    const loadPresentation = useCallback(async (payload: { path?: string; buffer?: number[]; error?: string }) => {
        setLoading(true);
        setThumbsLoading(false);
        setError(null);
        setThumbnails([]);
        setCurrentIndex(0);
        setSlideCount(0);
        resetView();
        viewerRef.current?.destroy();
        viewerRef.current = null;

        try {
            const buffer = await loadOfficeBuffer(payload);
            const canvas = canvasRef.current;
            const wrap = canvasWrapRef.current;
            if (!canvas || !wrap) {
                return;
            }

            setLoading(false);
            await waitForCanvasContainer(wrap);
            applyCanvasSize(canvas, wrap.clientWidth, wrap.clientHeight);

            const viewer = new PPTXViewer({
                canvas,
                slideSizeMode: 'fit',
                backgroundColor: '#ffffff',
                // Phone: no unqueued re-render; the slide is drawn again once the thumbnails are made.
                ...(IS_MOBILE ? { autoChartRerenderDelayMs: 0 } : {}),
            });
            await viewer.loadFile(buffer);
            if (IS_MOBILE) {
                slideAspectRef.current = getSlideAspect(viewer);
                currentIndexRef.current = 0;
                viewerRef.current = viewer;
                await renderMobileSlide(0);
            } else {
                await viewer.render(canvas);
            }

            const count = viewer.getSlideCount();
            const activeIndex = viewer.getCurrentSlideIndex();
            viewerRef.current = viewer;
            setSlideCount(count);
            setCurrentIndex(IS_MOBILE ? currentIndexRef.current : activeIndex);

            setThumbsLoading(true);
            if (IS_MOBILE) {
                setThumbnails(await generateMobileThumbnails(viewer, count, slideAspectRef.current, queueRender));
                await renderMobileSlide(currentIndexRef.current);
                return;
            }
            const urls = await generateThumbnails(viewer, count);
            setThumbnails(urls);
            applyCanvasSize(canvas, wrap.clientWidth, wrap.clientHeight);
            await viewer.goToSlide(activeIndex, canvas);
            await viewer.render(canvas);
            setCurrentIndex(activeIndex);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load presentation');
            setLoading(false);
        } finally {
            setThumbsLoading(false);
        }
    }, [resetView, renderMobileSlide, queueRender]);

    useEffect(() => {
        handler.on('open', (payload) => {
            loadPresentation(payload);
        }).emit('init');

        return () => {
            viewerRef.current?.destroy();
        };
    }, [loadPresentation]);

    useEffect(() => {
        if (IS_MOBILE) {
            return;
        }
        thumbRefs.current[currentIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [currentIndex, thumbnails]);

    // Phone: the open drawer shows the current slide's thumbnail in the middle of the list.
    useEffect(() => {
        const list = thumbListRef.current;
        const thumb = thumbRefs.current[currentIndex];
        if (!IS_MOBILE || !drawerOpen || !list || !thumb) {
            return;
        }
        const listRect = list.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        list.scrollTop += thumbRect.top - listRect.top - (list.clientHeight - thumbRect.height) / 2;
    }, [drawerOpen, currentIndex, thumbnails]);

    useEffect(() => {
        const onKeyDown = async (e: KeyboardEvent) => {
            const viewer = viewerRef.current;
            if (!viewer || loading) {
                return;
            }
            const current = IS_MOBILE ? currentIndexRef.current : viewer.getCurrentSlideIndex();
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
                e.preventDefault();
                const next = Math.min(current + 1, viewer.getSlideCount() - 1);
                await selectSlide(next);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
                e.preventDefault();
                const prev = Math.max(current - 1, 0);
                await selectSlide(prev);
            } else if (IS_MOBILE && e.key === 'Escape') {
                setDrawerOpen(false);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [loading, selectSlide]);

    useEffect(() => {
        if (loading || slideCount === 0) {
            return;
        }
        requestAnimationFrame(() => {
            rerenderSlide();
        });
    }, [loading, slideCount, rerenderSlide]);

    useEffect(() => {
        const el = canvasWrapRef.current;
        if (!el) {
            return;
        }
        let timeout: ReturnType<typeof setTimeout>;
        const observer = new ResizeObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                rerenderSlide();
            }, 100);
        });
        observer.observe(el);
        return () => {
            clearTimeout(timeout);
            observer.disconnect();
        };
    }, [rerenderSlide]);

    useEffect(() => {
        const el = mainPanelRef.current;
        if (!el) {
            return;
        }

        const getTouchDistance = (touches: TouchList) => {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.hypot(dx, dy);
        };

        const isRightPanelEvent = (target: EventTarget | null) => {
            if (!(target instanceof Node)) {
                return false;
            }
            const thumbList = thumbListRef.current;
            if (thumbList?.contains(target)) {
                return false;
            }
            return el.contains(target);
        };

        const onWheel = (e: WheelEvent) => {
            if (!isRightPanelEvent(e.target) || loading) {
                return;
            }
            const viewer = viewerRef.current;
            if (!viewer) {
                return;
            }

            // Trackpad pinch / ctrl+wheel → zoom
            if (e.ctrlKey) {
                e.preventDefault();
                const factor = Math.pow(WHEEL_ZOOM_BASE, -e.deltaY);
                setZoomLevel(value => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value * factor)));
                return;
            }

            // When zoomed in, scroll wheel pans vertically
            if (zoomRef.current > 1) {
                e.preventDefault();
                applyPan(panRef.current.x, panRef.current.y - e.deltaY);
                return;
            }

            // Mouse wheel / two-finger scroll → change slide
            e.preventDefault();
            const now = Date.now();
            if (now - wheelNavLockRef.current < WHEEL_NAV_INTERVAL_MS) {
                return;
            }
            wheelNavLockRef.current = now;

            const current = IS_MOBILE ? currentIndexRef.current : viewer.getCurrentSlideIndex();
            if (e.deltaY > 0) {
                void selectSlide(Math.min(current + 1, viewer.getSlideCount() - 1));
            } else if (e.deltaY < 0) {
                void selectSlide(Math.max(current - 1, 0));
            }
        };

        const onTouchStart = (e: TouchEvent) => {
            if (!isRightPanelEvent(e.target) || e.touches.length !== 2) {
                return;
            }
            pinchStartRef.current = {
                distance: getTouchDistance(e.touches),
                zoom: zoomRef.current,
            };
        };

        const onTouchMove = (e: TouchEvent) => {
            const pinchStart = pinchStartRef.current;
            if (!pinchStart || e.touches.length !== 2) {
                return;
            }
            if (!isRightPanelEvent(e.target)) {
                return;
            }
            e.preventDefault();
            const distance = getTouchDistance(e.touches);
            if (pinchStart.distance <= 0) {
                return;
            }
            const ratio = distance / pinchStart.distance;
            const nextZoom = pinchStart.zoom * (1 + (ratio - 1) * PINCH_ZOOM_GAIN);
            setZoomLevel(nextZoom);
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2) {
                pinchStartRef.current = null;
            }
            if (e.touches.length === 0) {
                touchPanRef.current = null;
            }
        };

        el.addEventListener('wheel', onWheel, { passive: false });
        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd);
        el.addEventListener('touchcancel', onTouchEnd);
        return () => {
            el.removeEventListener('wheel', onWheel);
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchEnd);
        };
    }, [loading, selectSlide, applyPan, setZoomLevel]);

    useEffect(() => {
        const el = canvasWrapRef.current;
        if (!el) {
            return;
        }

        const onMouseDown = (e: MouseEvent) => {
            if (zoomRef.current <= 1 || e.button !== 0) {
                return;
            }
            e.preventDefault();
            dragRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                panX: panRef.current.x,
                panY: panRef.current.y,
            };
            setDragging(true);
        };

        const onMouseMove = (e: MouseEvent) => {
            const drag = dragRef.current;
            if (!drag) {
                return;
            }
            e.preventDefault();
            applyPan(
                drag.panX + e.clientX - drag.startX,
                drag.panY + e.clientY - drag.startY,
            );
        };

        const endDrag = () => {
            dragRef.current = null;
            setDragging(false);
        };

        const onTouchStart = (e: TouchEvent) => {
            if (zoomRef.current <= 1 || e.touches.length !== 1 || pinchStartRef.current) {
                return;
            }
            touchPanRef.current = {
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                panX: panRef.current.x,
                panY: panRef.current.y,
            };
        };

        const onTouchMove = (e: TouchEvent) => {
            const touchPan = touchPanRef.current;
            if (!touchPan || e.touches.length !== 1 || pinchStartRef.current) {
                return;
            }
            e.preventDefault();
            applyPan(
                touchPan.panX + e.touches[0].clientX - touchPan.startX,
                touchPan.panY + e.touches[0].clientY - touchPan.startY,
            );
        };

        const onTouchEnd = () => {
            touchPanRef.current = null;
        };

        el.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', endDrag);
        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd);
        el.addEventListener('touchcancel', onTouchEnd);
        return () => {
            el.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', endDrag);
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchEnd);
        };
    }, [applyPan]);

    useEffect(() => {
        if (zoom <= 1) {
            return;
        }
        const wrap = canvasWrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) {
            return;
        }
        setPan(current => clampPan(current.x, current.y, zoom, wrap, canvas));
    }, [zoom]);

    // Phone: once a pinch settles, draw the slide again with enough pixels for the new zoom.
    useEffect(() => {
        if (!IS_MOBILE || slideCount === 0) {
            return;
        }
        const timer = setTimeout(() => {
            const canvas = canvasRef.current;
            if (canvas && getMainPixelRatio(canvas, zoom) !== renderRatioRef.current) {
                void rerenderSlide();
            }
        }, 250);
        return () => clearTimeout(timer);
    }, [zoom, slideCount, rerenderSlide]);

    // Phone: swipe left/right for the next/previous slide (the slide follows the finger), double-tap to zoom.
    useEffect(() => {
        const el = canvasWrapRef.current;
        if (!IS_MOBILE || !el) {
            return;
        }
        let swipe: { x: number; y: number; dx: number; dy: number; time: number; horizontal: boolean | null } | null = null;
        let lastTap = { time: 0, x: 0, y: 0 };

        const setOffset = (dx: number, animate: boolean) => {
            const canvas = canvasRef.current;
            if (canvas) {
                canvas.style.transition = animate ? 'transform 0.2s ease' : '';
                canvas.style.transform = dx ? `translateX(${dx}px)` : '';
            }
        };

        const cancelSwipe = () => {
            if (swipe) {
                setOffset(0, true);
            }
            swipe = null;
        };

        const toggleZoomAt = (x: number, y: number) => {
            const canvas = canvasRef.current;
            if (!canvas) {
                return;
            }
            if (zoomRef.current > 1) {
                resetView();
                return;
            }
            // Keep the tapped point under the finger: the stage scales around its center.
            const rect = canvas.getBoundingClientRect();
            const zoomLevel = DOUBLE_TAP_ZOOM;
            setZoom(zoomLevel);
            setPan(clampPan(
                (1 - zoomLevel) * (x - rect.left - rect.width / 2),
                (1 - zoomLevel) * (y - rect.top - rect.height / 2),
                zoomLevel, el, canvas,
            ));
        };

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 1) {
                cancelSwipe();
                return;
            }
            const touch = e.touches[0];
            swipe = { x: touch.clientX, y: touch.clientY, dx: 0, dy: 0, time: Date.now(), horizontal: null };
        };

        const onTouchMove = (e: TouchEvent) => {
            if (!swipe) {
                return;
            }
            if (e.touches.length !== 1 || pinchStartRef.current) {
                cancelSwipe();
                return;
            }
            swipe.dx = e.touches[0].clientX - swipe.x;
            swipe.dy = e.touches[0].clientY - swipe.y;
            if (zoomRef.current > 1) {
                return; // one finger pans the zoomed slide
            }
            if (swipe.horizontal === null && Math.hypot(swipe.dx, swipe.dy) > 10) {
                swipe.horizontal = Math.abs(swipe.dx) > Math.abs(swipe.dy);
            }
            if (!swipe.horizontal) {
                return;
            }
            e.preventDefault();
            const count = viewerRef.current?.getSlideCount() ?? 0;
            const atEnd = swipe.dx > 0 ? currentIndexRef.current <= 0 : currentIndexRef.current >= count - 1;
            setOffset(atEnd ? swipe.dx * 0.3 : swipe.dx, false);
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (!swipe || e.touches.length > 0) {
                return;
            }
            const { dx, dy, time, horizontal } = swipe;
            swipe = null;
            const elapsed = Date.now() - time;
            if (Math.hypot(dx, dy) < 10 && elapsed < 300) {
                const touch = e.changedTouches[0];
                const now = Date.now();
                if (now - lastTap.time < 300 && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 30) {
                    lastTap = { time: 0, x: 0, y: 0 };
                    toggleZoomAt(touch.clientX, touch.clientY);
                } else {
                    lastTap = { time: now, x: touch.clientX, y: touch.clientY };
                }
                return;
            }
            if (!horizontal || zoomRef.current > 1) {
                setOffset(0, true);
                return;
            }
            const target = currentIndexRef.current + (dx < 0 ? 1 : -1);
            const count = viewerRef.current?.getSlideCount() ?? 0;
            const far = Math.abs(dx) > Math.min(SWIPE_MIN_DISTANCE, el.clientWidth * 0.15);
            const flick = Math.abs(dx) > 25 && elapsed < 250;
            if ((far || flick) && target >= 0 && target < count) {
                setOffset(0, false);
                void selectSlide(target);
            } else {
                setOffset(0, true);
            }
        };

        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd);
        el.addEventListener('touchcancel', cancelSwipe);
        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', cancelSwipe);
        };
    }, [selectSlide, resetView]);

    const goToSlideFromDrawer = (index: number) => {
        void selectSlide(index);
        setDrawerOpen(false);
    };

    const thumbnailsHeader = (
        <>
            {slideCount > 0 ? `${slideCount} slides` : 'Slides'}
            {thumbsLoading && ' · loading…'}
        </>
    );

    const thumbnailsPanel = (
        <div className="ppt-thumbnails-inner">
            <div className="ppt-thumbnails-header">
                {IS_MOBILE ? (
                    <>
                        <span>{thumbnailsHeader}</span>
                        <button type="button" className="ppt-bar-button" aria-label="Hide slides" onClick={() => setDrawerOpen(false)}>
                            <CloseOutlined />
                        </button>
                    </>
                ) : thumbnailsHeader}
            </div>
            <div className="ppt-thumbnails-list" ref={thumbListRef}>
                {slideCount > 0 && thumbnails.length === 0 && thumbsLoading && (
                    Array.from({ length: Math.min(slideCount, 8) }, (_, i) => (
                        <div key={i} className="ppt-thumb">
                            <div className="ppt-thumb-placeholder" />
                        </div>
                    ))
                )}
                {thumbnails.map((url, index) => (
                    <div
                        key={index}
                        ref={el => { thumbRefs.current[index] = el; }}
                        className={`ppt-thumb${index === currentIndex ? ' is-active' : ''}`}
                        onClick={() => IS_MOBILE ? goToSlideFromDrawer(index) : selectSlide(index)}
                    >
                        <img src={url} alt={`Slide ${index + 1}`} draggable={false} />
                        <span className="ppt-thumb-num">{index + 1}</span>
                    </div>
                ))}
            </div>
        </div>
    );

    const colorModeToggle = (
        <button
            type="button"
            className={`color-mode-toggle${slideCount > 0 ? ' is-above-status' : ''}`}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggleDark}
        >
            {dark ? <SunOutlined /> : <MoonOutlined />}
        </button>
    );

    return (
        <>
            <Spin spinning={loading} fullscreen />
            {error && <Alert type="error" message={error} showIcon style={{ margin: 16 }} />}
            <Layout className="ppt-viewer office-viewer-themed">
                <Layout className="ppt-body">
                    {!IS_MOBILE && (
                        <Sider width={SIDER_WIDTH} className="ppt-thumbnails">
                            {thumbnailsPanel}
                        </Sider>
                    )}
                    <Content className="ppt-main" ref={mainPanelRef}>
                        <div
                            className={`ppt-main-canvas${zoom > 1 ? ' is-pannable' : ''}${dragging ? ' is-dragging' : ''}`}
                            ref={canvasWrapRef}
                        >
                            <div
                                className="ppt-canvas-stage"
                                style={{ transform: getStageTransform(zoom, pan) }}
                            >
                                <canvas ref={canvasRef} id="ppt-canvas" />
                            </div>
                        </div>
                        {!IS_MOBILE && slideCount > 0 && (
                            <div className="ppt-statusbar">
                                Slide {currentIndex + 1} / {slideCount}
                                {zoom !== 1 && ` · ${Math.round(zoom * 100)}%`}
                            </div>
                        )}
                        {IS_MOBILE && (
                            <div className="ppt-mobile-bar">
                                <button
                                    type="button"
                                    className="ppt-bar-button ppt-bar-slides"
                                    aria-label="Show slides"
                                    disabled={slideCount === 0}
                                    onClick={() => setDrawerOpen(true)}
                                >
                                    <AppstoreOutlined />
                                </button>
                                <div className="ppt-bar-nav">
                                    <button
                                        type="button"
                                        className="ppt-bar-button ppt-bar-prev"
                                        aria-label="Previous slide"
                                        disabled={currentIndex <= 0}
                                        onClick={() => selectSlide(currentIndexRef.current - 1)}
                                    >
                                        <LeftOutlined />
                                    </button>
                                    <span className="ppt-bar-counter" aria-live="polite">
                                        {slideCount > 0 ? `${currentIndex + 1} / ${slideCount}` : ''}
                                    </span>
                                    <button
                                        type="button"
                                        className="ppt-bar-button ppt-bar-next"
                                        aria-label="Next slide"
                                        disabled={currentIndex >= slideCount - 1}
                                        onClick={() => selectSlide(currentIndexRef.current + 1)}
                                    >
                                        <RightOutlined />
                                    </button>
                                </div>
                                {colorModeToggle}
                            </div>
                        )}
                    </Content>
                </Layout>
                {!IS_MOBILE && colorModeToggle}
                {IS_MOBILE && (
                    <>
                        <div className={`ppt-drawer-scrim${drawerOpen ? ' is-open' : ''}`} onClick={() => setDrawerOpen(false)} />
                        <aside className={`ppt-thumbnails ppt-drawer${drawerOpen ? ' is-open' : ''}`} aria-hidden={!drawerOpen}>
                            {thumbnailsPanel}
                        </aside>
                    </>
                )}
            </Layout>
        </>
    );
}
