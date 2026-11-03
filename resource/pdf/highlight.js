"use strict";

/*
 * Highlight mode for the PDF viewer.
 *
 * While highlight mode is on (the default), selecting text in a page immediately creates a
 * highlight. The webview only draws a temporary overlay; the extension writes a standard
 * /Highlight annotation into the PDF file (see src/provider/handlers/pdfHighlight*.ts).
 *
 * Messages (vscodeEvent):
 *   -> pdfHighlightAdd    { id, pageIndex, quadPoints, rect, color, text, fingerprint }
 *   -> pdfHighlightRemove { id?, ref?, pageIndex, fingerprint }
 *   <- pdfHighlightConfig { writable, reason? }
 *   <- pdfHighlightResult { ok, ids, error? }
 */
(function () {
  const MODE_STORAGE_KEY = 'vscode-office.pdf.highlightMode';
  const COLOR_STORAGE_KEY = 'vscode-office.pdf.highlightColor';
  // PDFCursorTools CursorTool.HAND (viewer.js: CursorTool = { SELECT: 0, HAND: 1, ZOOM: 2 })
  const CURSOR_TOOL_HAND = 1;
  // Max pointer travel (CSS px) for a pointerdown/up pair to count as a click.
  const CLICK_TOLERANCE = 4;
  // Rects on the same line are merged unless the horizontal gap exceeds this many line heights
  // (keeps two-column layouts from highlighting the gutter).
  const LINE_GAP_FACTOR = 2;
  // Tolerance (PDF points) for hit testing and for matching overlays to saved annotations.
  const HIT_TOLERANCE = 0.75;
  const MATCH_TOLERANCE = 0.5;
  const TOAST_DURATION = 4500;
  // PDF.js annotation ids are Ref.toString(): `${num}R` or `${num}R${gen}`; direct dicts get `annot_*`.
  const REF_ID_PATTERN = /^\d+R\d*$/;
  const ANNOTATION_FLAG_HIDDEN = 2;

  const COLORS = [
    { name: 'yellow', label: 'Yellow', hex: '#ffe45c' },
    { name: 'green', label: 'Green', hex: '#7ee28c' },
    { name: 'blue', label: 'Blue', hex: '#80c6ff' },
    { name: 'pink', label: 'Pink', hex: '#ff92c9' },
    { name: 'orange', label: 'Orange', hex: '#ffb85c' },
  ];
  const DEFAULT_COLOR = 'yellow';

  const TRASH_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4 4.25l.6 9h6.8l.6-9M6.75 6.75v4M9.25 6.75v4"/></svg>';

  function highlighterIcon(hex) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M9.6 2.4l3.9 3.9-5 5-3.9-3.9z"/>'
      + '<path d="M4.6 7.4L3.2 10.9l1.8 1.8 3.5-1.4"/>'
      + `<rect x="1.75" y="13.5" width="12.5" height="1.75" rx=".6" fill="${hex}" stroke="none"/>`
      + '</svg>';
  }

  function swatchIcon(hex) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + `<circle cx="6" cy="8" r="4.25" fill="${hex}" stroke="rgba(0, 0, 0, 0.35)" stroke-width="1"/>`
      + '<path d="M11.5 7l1.75 1.75L15 7" stroke="currentColor" stroke-width="1.25"/>'
      + '</svg>';
  }

  function loadMode() {
    try {
      // Missing / unknown value => on (the default).
      return localStorage.getItem(MODE_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  }

  function saveMode(on) {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, on ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }

  function loadColor() {
    try {
      const saved = localStorage.getItem(COLOR_STORAGE_KEY);
      if (COLORS.some((color) => color.name === saved)) {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
    return DEFAULT_COLOR;
  }

  function saveColor(name) {
    try {
      localStorage.setItem(COLOR_STORAGE_KEY, name);
    } catch {
      // ignore storage errors
    }
  }

  const state = {
    modePreference: loadMode(),
    colorName: loadColor(),
    writable: true,
    reason: '',
    doc: null,
    docGeneration: 0,
    // id -> { id, pageIndex, quads: [[x1, y1, x2, y2]...] (PDF space), hex, status, needsReconcile }
    session: new Map(),
    // Each entry is the list of ids created by one selection gesture (one per page).
    undoStack: [],
    // pageIndex -> { pdfPage, list: null | [{ ref, quads, removable }] }
    fileHighlights: new Map(),
    pendingRefRemovals: new Set(),
    pointer: null,
    popup: null,
    toast: null,
    toastTimer: null,
    colorMenuOpen: false,
  };

  function app() {
    return window.PDFViewerApplication || null;
  }

  function isModeOn() {
    return state.writable && state.modePreference;
  }

  function currentColor() {
    return COLORS.find((color) => color.name === state.colorName) || COLORS[0];
  }

  function hexToRgb01(hex) {
    const value = parseInt(hex.slice(1), 16);
    const round = (n) => Math.round((n / 255) * 1000) / 1000;
    return [round((value >> 16) & 255), round((value >> 8) & 255), round(value & 255)];
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function createId() {
    return 'vso-hl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function getFingerprint() {
    const doc = app()?.pdfDocument;
    if (!doc) {
      return null;
    }
    return (doc.fingerprints && doc.fingerprints[0]) || doc.fingerprint || null;
  }

  function emit(type, data) {
    if (window.vscodeEvent) {
      window.vscodeEvent.emit(type, data);
    }
  }

  function getPageView(pageIndex) {
    const viewer = app()?.pdfViewer;
    if (!viewer || typeof viewer.getPageView !== 'function') {
      return null;
    }
    return viewer.getPageView(pageIndex) || null;
  }

  function pageIndexOfElement(element) {
    const pageDiv = element?.closest?.('.page');
    if (!pageDiv) {
      return -1;
    }
    const pageNumber = parseInt(pageDiv.getAttribute('data-page-number'), 10);
    return Number.isFinite(pageNumber) ? pageNumber - 1 : -1;
  }

  /* ---------------------------------------------------------------- geometry */

  // Client px -> page viewport px. The .page div is never transformed by PDF.js, so its
  // border-box rect over its layout width gives the exact client/CSS ratio (covers any CSS
  // zoom applied by the host), and its padding box is the origin of all page layers.
  function getPageFrame(pageView) {
    const div = pageView.div;
    const rect = div.getBoundingClientRect();
    const scale = div.offsetWidth > 0 && rect.width > 0 ? rect.width / div.offsetWidth : 1;
    return {
      left: rect.left + div.clientLeft * scale,
      top: rect.top + div.clientTop * scale,
      scale,
    };
  }

  function clientToPdfPoint(pageView, frame, x, y) {
    return pageView.viewport.convertToPdfPoint((x - frame.left) / frame.scale, (y - frame.top) / frame.scale);
  }

  // The page as laid out without the user's view rotation (only the page's own /Rotate).
  // Text lines run horizontally here for regular documents, so line merging happens in this space.
  function getBaseViewport(pageView) {
    const rotation = Number.isFinite(pageView.pdfPageRotate) ? pageView.pdfPageRotate : pageView.pdfPage.rotate;
    return pageView.pdfPage.getViewport({ scale: 1, rotation });
  }

  function boundsOfPoints(points) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [x, y] of points) {
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
    return [x1, y1, x2, y2];
  }

  function clientRectToBase(pageView, frame, baseViewport, rect) {
    const corners = [
      [rect.left, rect.top], [rect.right, rect.top],
      [rect.left, rect.bottom], [rect.right, rect.bottom],
    ].map(([x, y]) => {
      const [px, py] = clientToPdfPoint(pageView, frame, x, y);
      return baseViewport.convertToViewportPoint(px, py);
    });
    const [left, top, right, bottom] = boundsOfPoints(corners);
    return { left, top, right, bottom };
  }

  function baseRectToPdfQuad(baseViewport, rect) {
    return boundsOfPoints([
      [rect.left, rect.top], [rect.right, rect.top],
      [rect.left, rect.bottom], [rect.right, rect.bottom],
    ].map(([x, y]) => baseViewport.convertToPdfPoint(x, y)));
  }

  function isSameLine(a, b) {
    const heightA = a.bottom - a.top;
    const heightB = b.bottom - b.top;
    const minHeight = Math.min(heightA, heightB);
    if (minHeight <= 0) {
      return false;
    }
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (overlap < minHeight * 0.5) {
      return false;
    }
    const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
    return gap <= Math.max(heightA, heightB) * LINE_GAP_FACTOR;
  }

  function mergeLineRects(rects) {
    let lines = rects.map((rect) => ({ ...rect }));
    let changed = true;
    while (changed) {
      changed = false;
      const next = [];
      for (const rect of lines) {
        const line = next.find((candidate) => isSameLine(candidate, rect));
        if (line) {
          line.left = Math.min(line.left, rect.left);
          line.top = Math.min(line.top, rect.top);
          line.right = Math.max(line.right, rect.right);
          line.bottom = Math.max(line.bottom, rect.bottom);
          changed = true;
        } else {
          next.push(rect);
        }
      }
      lines = next;
    }
    return lines.sort((a, b) => a.top - b.top || a.left - b.left);
  }

  function clipQuad(quad, view) {
    if (!Array.isArray(view) || view.length !== 4) {
      return quad;
    }
    const x1 = Math.max(quad[0], Math.min(view[0], view[2]));
    const y1 = Math.max(quad[1], Math.min(view[1], view[3]));
    const x2 = Math.min(quad[2], Math.max(view[0], view[2]));
    const y2 = Math.min(quad[3], Math.max(view[1], view[3]));
    return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
  }

  function quadContains(quad, x, y, tolerance) {
    return x >= quad[0] - tolerance && x <= quad[2] + tolerance && y >= quad[1] - tolerance && y <= quad[3] + tolerance;
  }

  function quadsMatch(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((quad, i) => quad.every((value, j) => Math.abs(value - b[i][j]) <= MATCH_TOLERANCE));
  }

  // Acrobat order per quad: xLeft,yTop, xRight,yTop, xLeft,yBottom, xRight,yBottom (PDF y-up).
  function toQuadPoints(quads) {
    const points = [];
    for (const [x1, y1, x2, y2] of quads) {
      points.push(x1, y2, x2, y2, x1, y1, x2, y1);
    }
    return points.map(round3);
  }

  /* --------------------------------------------------------------- selection */

  function rangeSnapshot(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    return {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
    };
  }

  function sameSnapshot(a, b) {
    if (!a || !b) {
      return a === b;
    }
    return a.startContainer === b.startContainer && a.startOffset === b.startOffset
      && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
  }

  // Per page: client rects of the selected text. Only text nodes inside a page's text layer
  // count; whole-range rects are never used because they include the full-page endOfContent div.
  function collectSelection(range, viewerElement) {
    const pages = new Map();
    let root = range.commonAncestorContainer;
    if (root.nodeType !== Node.ELEMENT_NODE) {
      root = root.parentNode;
    }
    if (!root || !viewerElement.contains(root) && !root.contains(viewerElement)) {
      return pages;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!range.intersectsNode(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || !viewerElement.contains(parent) || !parent.closest('.page .textLayer') || parent.closest('.endOfContent')) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (end <= start) {
        continue;
      }
      const pageIndex = pageIndexOfElement(node.parentElement);
      if (pageIndex < 0) {
        continue;
      }
      let entry = pages.get(pageIndex);
      if (!entry) {
        entry = { pageIndex, rects: [], texts: [] };
        pages.set(pageIndex, entry);
      }
      const text = node.data.slice(start, end);
      entry.texts.push(text);
      if (!text.trim()) {
        continue;
      }
      const subRange = document.createRange();
      subRange.setStart(node, start);
      subRange.setEnd(node, end);
      for (const rect of subRange.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) {
          continue;
        }
        entry.rects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      }
    }
    return pages;
  }

  function buildHighlight(pageEntry, color) {
    const pageView = getPageView(pageEntry.pageIndex);
    if (!pageView || !pageView.pdfPage || !pageView.viewport || !pageEntry.rects.length) {
      return null;
    }
    const frame = getPageFrame(pageView);
    const baseViewport = getBaseViewport(pageView);
    const baseRects = pageEntry.rects.map((rect) => clientRectToBase(pageView, frame, baseViewport, rect));
    const quads = mergeLineRects(baseRects)
      .map((rect) => clipQuad(baseRectToPdfQuad(baseViewport, rect), pageView.pdfPage.view))
      .filter(Boolean)
      .map((quad) => quad.map(round3));
    if (!quads.length) {
      return null;
    }
    return {
      id: createId(),
      pageIndex: pageEntry.pageIndex,
      quads,
      hex: color.hex,
      status: 'pending',
      needsReconcile: false,
      text: pageEntry.texts.join('').replace(/\s+/g, ' ').trim(),
    };
  }

  function createHighlightsFromSelection() {
    const viewerElement = document.getElementById('viewer');
    const selection = document.getSelection();
    if (!viewerElement || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }
    syncDocument();
    const pages = collectSelection(selection.getRangeAt(0), viewerElement);
    if (!pages.size) {
      return false;
    }
    const color = currentColor();
    const rgb = hexToRgb01(color.hex);
    const fingerprint = getFingerprint();
    const created = [];
    for (const pageEntry of [...pages.values()].sort((a, b) => a.pageIndex - b.pageIndex)) {
      const highlight = buildHighlight(pageEntry, color);
      if (!highlight) {
        continue;
      }
      state.session.set(highlight.id, highlight);
      created.push(highlight.id);
      const allPoints = highlight.quads.flatMap(([x1, y1, x2, y2]) => [[x1, y1], [x2, y2]]);
      emit('pdfHighlightAdd', {
        id: highlight.id,
        pageIndex: highlight.pageIndex,
        quadPoints: toQuadPoints(highlight.quads),
        rect: boundsOfPoints(allPoints).map(round3),
        color: rgb,
        text: highlight.text,
        fingerprint,
      });
      renderPage(highlight.pageIndex);
    }
    if (created.length) {
      state.undoStack.push(created);
    }
    return created.length > 0;
  }

  /* --------------------------------------------------------------- rendering */

  function renderPage(pageIndex) {
    const pageView = getPageView(pageIndex);
    if (!pageView || !pageView.div) {
      return;
    }
    const div = pageView.div;
    let layer = div.querySelector(':scope > .office-hl-layer');
    const highlights = [...state.session.values()].filter((hl) => hl.pageIndex === pageIndex && !hl.needsReconcile);
    // The newest .canvasWrapper is the live one; an older one may linger as the zoom layer.
    const wrappers = div.querySelectorAll(':scope > .canvasWrapper');
    const wrapper = wrappers[wrappers.length - 1];
    const viewport = pageView.viewport;
    if (!highlights.length || !wrapper || !viewport) {
      if (layer) {
        layer.remove();
      }
      return;
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'office-hl-layer';
      layer.setAttribute('aria-hidden', 'true');
    }
    // Above the canvas, below the text and annotation layers.
    if (wrapper.nextSibling !== layer) {
      wrapper.after(layer);
    }
    // Percentages of the page box (Math.floor of the viewport, like the page div itself),
    // so CSS-only zoom transforms keep the overlay aligned without a re-render.
    const width = Math.floor(viewport.width) || viewport.width;
    const height = Math.floor(viewport.height) || viewport.height;
    const fragment = document.createDocumentFragment();
    for (const highlight of highlights) {
      for (const quad of highlight.quads) {
        const [a, b, c, d] = viewport.convertToViewportRectangle(quad);
        const element = document.createElement('div');
        element.className = 'office-hl-quad';
        element.dataset.id = highlight.id;
        element.style.left = `${(Math.min(a, c) / width) * 100}%`;
        element.style.top = `${(Math.min(b, d) / height) * 100}%`;
        element.style.width = `${(Math.abs(c - a) / width) * 100}%`;
        element.style.height = `${(Math.abs(d - b) / height) * 100}%`;
        element.style.backgroundColor = highlight.hex;
        fragment.appendChild(element);
      }
    }
    layer.replaceChildren(fragment);
  }

  function removeSessionHighlight(id) {
    const highlight = state.session.get(id);
    if (!highlight) {
      return null;
    }
    state.session.delete(id);
    state.undoStack = state.undoStack
      .map((group) => group.filter((groupId) => groupId !== id))
      .filter((group) => group.length);
    renderPage(highlight.pageIndex);
    return highlight;
  }

  /* --------------------------------------------- highlights already in the file */

  function annotationQuads(annotation) {
    const quads = [];
    if (Array.isArray(annotation.quadPoints)) {
      // PDF.js 3.1.81: [[{x, y} x4], ...] (already axis-aligned per quad).
      for (const quad of annotation.quadPoints) {
        if (Array.isArray(quad) && quad.length) {
          quads.push(boundsOfPoints(quad.map((point) => [point.x, point.y])));
        }
      }
    }
    if (!quads.length && Array.isArray(annotation.rect) && annotation.rect.length === 4) {
      const [x1, y1, x2, y2] = annotation.rect;
      quads.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
    }
    return quads;
  }

  function loadFileHighlights(pageIndex) {
    const pageView = getPageView(pageIndex);
    const pdfPage = pageView?.pdfPage;
    if (!pdfPage || typeof pdfPage.getAnnotations !== 'function') {
      return;
    }
    const cached = state.fileHighlights.get(pageIndex);
    if (cached && cached.pdfPage === pdfPage) {
      return;
    }
    const entry = { pdfPage, list: null };
    state.fileHighlights.set(pageIndex, entry);
    const generation = state.docGeneration;
    pdfPage.getAnnotations({ intent: 'display' }).then((annotations) => {
      const list = [];
      for (const annotation of annotations || []) {
        if (annotation.subtype !== 'Highlight' || annotation.annotationFlags & ANNOTATION_FLAG_HIDDEN) {
          continue;
        }
        const quads = annotationQuads(annotation);
        if (quads.length) {
          list.push({ ref: annotation.id, quads, removable: REF_ID_PATTERN.test(String(annotation.id)) });
        }
      }
      return list;
    }).catch(() => []).then((list) => {
      if (generation !== state.docGeneration || state.fileHighlights.get(pageIndex) !== entry) {
        return;
      }
      entry.list = list;
      reconcilePage(pageIndex, list);
    });
  }

  // After a reload, highlights whose save had not been confirmed yet are kept but hidden
  // until we know whether the reloaded file already contains them.
  function reconcilePage(pageIndex, fileList) {
    let changed = false;
    for (const highlight of [...state.session.values()]) {
      if (highlight.pageIndex !== pageIndex || !highlight.needsReconcile) {
        continue;
      }
      highlight.needsReconcile = false;
      changed = true;
      if (fileList.some((fileHighlight) => quadsMatch(fileHighlight.quads, highlight.quads))) {
        removeSessionHighlight(highlight.id);
      }
    }
    if (changed) {
      renderPage(pageIndex);
    }
  }

  // A different PDFDocumentProxy means the document was (re)loaded: highlights now come from
  // the file, so drop confirmed overlays and every per-document cache.
  function syncDocument() {
    const doc = app()?.pdfDocument || null;
    if (!doc || doc === state.doc) {
      return;
    }
    const isReload = state.doc !== null;
    state.doc = doc;
    state.docGeneration++;
    state.fileHighlights.clear();
    state.pendingRefRemovals.clear();
    closePopup();
    if (!isReload) {
      return;
    }
    for (const highlight of [...state.session.values()]) {
      if (highlight.status === 'saved') {
        removeSessionHighlight(highlight.id);
      } else {
        highlight.needsReconcile = true;
      }
    }
  }

  /* ------------------------------------------------------------------ remove */

  function findHighlightAt(pageIndex, clientX, clientY) {
    const pageView = getPageView(pageIndex);
    if (!pageView || !pageView.viewport || !pageView.div) {
      return null;
    }
    const [x, y] = clientToPdfPoint(pageView, getPageFrame(pageView), clientX, clientY);
    const sessionHighlights = [...state.session.values()].filter((hl) => hl.pageIndex === pageIndex && !hl.needsReconcile);
    for (let i = sessionHighlights.length - 1; i >= 0; i--) {
      if (sessionHighlights[i].quads.some((quad) => quadContains(quad, x, y, HIT_TOLERANCE))) {
        return { kind: 'session', id: sessionHighlights[i].id, pageIndex };
      }
    }
    const fileList = state.fileHighlights.get(pageIndex)?.list || [];
    for (let i = fileList.length - 1; i >= 0; i--) {
      const fileHighlight = fileList[i];
      if (!fileHighlight.removable || state.pendingRefRemovals.has(fileHighlight.ref)) {
        continue;
      }
      if (fileHighlight.quads.some((quad) => quadContains(quad, x, y, HIT_TOLERANCE))) {
        return { kind: 'file', ref: fileHighlight.ref, pageIndex };
      }
    }
    return null;
  }

  function removeTarget(target) {
    const fingerprint = getFingerprint();
    if (target.kind === 'session') {
      if (removeSessionHighlight(target.id)) {
        emit('pdfHighlightRemove', { id: target.id, pageIndex: target.pageIndex, fingerprint });
      }
      return;
    }
    // Baked into the rendered page: the extension saves and reloads the document.
    state.pendingRefRemovals.add(target.ref);
    emit('pdfHighlightRemove', { ref: target.ref, pageIndex: target.pageIndex, fingerprint });
    showToast('Removing highlight…');
  }

  function undoLastHighlight() {
    const group = state.undoStack.pop();
    if (!group) {
      return false;
    }
    const fingerprint = getFingerprint();
    for (const id of group) {
      const highlight = removeSessionHighlight(id);
      if (highlight) {
        emit('pdfHighlightRemove', { id, pageIndex: highlight.pageIndex, fingerprint });
      }
    }
    closePopup();
    return true;
  }

  function closePopup() {
    if (state.popup) {
      state.popup.remove();
      state.popup = null;
    }
  }

  function showRemovePopup(target, clientX, clientY) {
    closePopup();
    const popup = document.createElement('div');
    popup.className = 'office-hl-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Highlight');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'office-hl-popup-remove';
    button.innerHTML = `${TRASH_ICON}<span>Remove highlight</span>`;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closePopup();
      removeTarget(target);
    });
    popup.appendChild(button);
    document.body.appendChild(popup);
    const margin = 8;
    const { width, height } = popup.getBoundingClientRect();
    let left = clientX - width / 2;
    let top = clientY + 12;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    if (top + height > window.innerHeight - margin) {
      top = clientY - height - 12;
    }
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(Math.max(margin, top))}px`;
    state.popup = popup;
  }

  /* ------------------------------------------------------------------- toast */

  function showToast(message) {
    if (!state.toast) {
      state.toast = document.createElement('div');
      state.toast.className = 'office-hl-toast';
      state.toast.setAttribute('role', 'status');
      state.toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(state.toast);
    }
    const toast = state.toast;
    toast.textContent = message;
    const container = document.getElementById('viewerContainer');
    if (container) {
      const rect = container.getBoundingClientRect();
      toast.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    }
    // Restart the fade-in.
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), TOAST_DURATION);
  }

  /* ----------------------------------------------------------------- toolbar */

  function updateToolbar() {
    const toggle = document.getElementById('highlightModeToggle');
    const colorToggle = document.getElementById('highlightColorToggle');
    const color = currentColor();
    const on = isModeOn();
    if (toggle) {
      toggle.innerHTML = highlighterIcon(color.hex);
      toggle.classList.toggle('toggled', on);
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      toggle.disabled = !state.writable;
      if (!state.writable) {
        toggle.title = `Highlighting unavailable: ${state.reason || 'this PDF cannot be modified'}`;
      } else {
        toggle.title = on
          ? 'Highlight mode on: selecting text highlights it (click to turn off)'
          : 'Highlight mode off: click to highlight text as you select it';
      }
      toggle.setAttribute('aria-label', toggle.title);
    }
    if (colorToggle) {
      colorToggle.innerHTML = swatchIcon(color.hex);
      colorToggle.disabled = !state.writable;
      colorToggle.title = `Highlight color: ${color.label}`;
      colorToggle.setAttribute('aria-label', colorToggle.title);
    }
    const menu = document.getElementById('highlightColorMenu');
    if (menu) {
      for (const item of menu.querySelectorAll('.office-highlight-swatch')) {
        const selected = item.dataset.color === color.name;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-checked', selected ? 'true' : 'false');
      }
    }
    if (!state.writable) {
      closeColorMenu();
    }
  }

  function closeColorMenu() {
    const menu = document.getElementById('highlightColorMenu');
    const colorToggle = document.getElementById('highlightColorToggle');
    if (menu) {
      menu.classList.add('hidden');
    }
    if (colorToggle) {
      colorToggle.setAttribute('aria-expanded', 'false');
    }
    state.colorMenuOpen = false;
  }

  function openColorMenu() {
    const menu = document.getElementById('highlightColorMenu');
    const colorToggle = document.getElementById('highlightColorToggle');
    if (!menu || !colorToggle || !state.writable) {
      return;
    }
    menu.classList.remove('hidden');
    colorToggle.setAttribute('aria-expanded', 'true');
    state.colorMenuOpen = true;
  }

  function setupToolbar() {
    const toggle = document.getElementById('highlightModeToggle');
    const colorToggle = document.getElementById('highlightColorToggle');
    const menu = document.getElementById('highlightColorMenu');
    if (toggle) {
      toggle.addEventListener('click', () => {
        if (!state.writable) {
          return;
        }
        state.modePreference = !state.modePreference;
        saveMode(state.modePreference);
        updateToolbar();
      });
    }
    if (menu) {
      menu.replaceChildren();
      for (const color of COLORS) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'office-highlight-swatch';
        item.dataset.color = color.name;
        item.title = color.label;
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-label', color.label);
        item.style.setProperty('--office-swatch-color', color.hex);
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          state.colorName = color.name;
          saveColor(color.name);
          // Picking a color implies the user wants to highlight.
          if (state.writable && !state.modePreference) {
            state.modePreference = true;
            saveMode(true);
          }
          closeColorMenu();
          updateToolbar();
          colorToggle?.focus();
        });
        menu.appendChild(item);
      }
      menu.addEventListener('click', (event) => event.stopPropagation());
    }
    if (colorToggle) {
      colorToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.colorMenuOpen) {
          closeColorMenu();
        } else {
          openColorMenu();
        }
      });
    }
    document.addEventListener('click', () => {
      if (state.colorMenuOpen) {
        closeColorMenu();
      }
    });
    updateToolbar();
  }

  /* ------------------------------------------------------------------ events */

  function isEditableTarget(target) {
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    if (!element) {
      return false;
    }
    return !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  function isHandToolActive() {
    return app()?.pdfCursorTools?.activeTool === CURSOR_TOOL_HAND;
  }

  function onPointerDown(event) {
    if (state.popup && !state.popup.contains(event.target)) {
      closePopup();
    }
    const container = document.getElementById('viewerContainer');
    if (event.button !== 0 || !container || !container.contains(event.target)) {
      state.pointer = null;
      return;
    }
    state.pointer = {
      x: event.clientX,
      y: event.clientY,
      target: event.target,
      selection: rangeSnapshot(document.getSelection()),
    };
  }

  function onPointerUp(event) {
    const pointer = state.pointer;
    state.pointer = null;
    if (!pointer || event.button !== 0) {
      return;
    }
    const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > CLICK_TOLERANCE;
    const { clientX, clientY } = event;
    // Let the selection settle (double/triple click, mouseup handlers) before reading it.
    setTimeout(() => handleGesture(pointer, moved, clientX, clientY), 0);
  }

  function handleGesture(pointer, moved, clientX, clientY) {
    if (!state.doc && !app()?.pdfDocument) {
      return;
    }
    if (isHandToolActive() || app()?.pdfViewer?.isInPresentationMode) {
      return;
    }
    syncDocument();
    const selection = document.getSelection();
    const snapshot = rangeSnapshot(selection);
    if (snapshot) {
      // Ignore gestures that did not change the selection (e.g. a click on the scrollbar).
      if (isModeOn() && !sameSnapshot(snapshot, pointer.selection)) {
        closePopup();
        createHighlightsFromSelection();
      }
      return;
    }
    if (moved || !state.writable) {
      return;
    }
    const pageIndex = pageIndexOfElement(pointer.target);
    if (pageIndex < 0) {
      return;
    }
    const target = findHighlightAt(pageIndex, clientX, clientY);
    if (target) {
      showRemovePopup(target, clientX, clientY);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (state.popup) {
        closePopup();
      }
      if (state.colorMenuOpen) {
        closeColorMenu();
        document.getElementById('highlightColorToggle')?.focus();
      }
      return;
    }
    const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
      && (event.key === 'z' || event.key === 'Z');
    if (!isUndo || isEditableTarget(event.target) || isEditableTarget(document.activeElement)) {
      return;
    }
    if (undoLastHighlight()) {
      event.preventDefault();
    }
  }

  function onPageEvent(event) {
    syncDocument();
    const pageIndex = (event?.pageNumber || event?.source?.id || 0) - 1;
    if (pageIndex < 0) {
      return;
    }
    renderPage(pageIndex);
    loadFileHighlights(pageIndex);
  }

  function onConfig(config) {
    if (!config || typeof config !== 'object') {
      return;
    }
    state.writable = config.writable !== false;
    state.reason = typeof config.reason === 'string' ? config.reason : '';
    if (!state.writable) {
      closePopup();
    }
    updateToolbar();
  }

  function onResult(result) {
    if (!result || typeof result !== 'object') {
      return;
    }
    const ids = Array.isArray(result.ids) ? result.ids : [];
    if (result.ok) {
      for (const id of ids) {
        const highlight = state.session.get(id);
        if (highlight) {
          highlight.status = 'saved';
        }
      }
      return;
    }
    for (const id of ids) {
      removeSessionHighlight(id);
    }
    if (!ids.length) {
      // A failed removal: allow retrying.
      state.pendingRefRemovals.clear();
    }
    const error = result.error ? String(result.error) : 'Unknown error';
    showToast(ids.length ? `Highlight not saved: ${error}` : `Highlight not removed: ${error}`);
  }

  // Register right away so a config sent in response to 'init' is never missed.
  if (window.vscodeEvent) {
    window.vscodeEvent.on('pdfHighlightConfig', onConfig);
    window.vscodeEvent.on('pdfHighlightResult', onResult);
  }

  window.addEventListener('load', function () {
    setupToolbar();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('keydown', onKeyDown);
    const container = document.getElementById('viewerContainer');
    if (container) {
      container.addEventListener('scroll', closePopup, { passive: true });
    }
    window.addEventListener('resize', closePopup);
    PDFViewerApplication.initializedPromise.then(() => {
      const eventBus = PDFViewerApplication.eventBus;
      eventBus.on('pagesinit', syncDocument);
      eventBus.on('documentloaded', syncDocument);
      // PDF.js reset() drops unknown children of the page div, so re-attach on every (re)draw.
      eventBus.on('pagerender', onPageEvent);
      eventBus.on('pagerendered', onPageEvent);
      eventBus.on('textlayerrendered', onPageEvent);
    });
  }, { once: true });
}());
