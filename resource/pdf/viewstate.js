"use strict";

/*
 * Remembers the reading position inside the PDF file itself, so it follows the file to other
 * devices and is not limited to PDF.js's local view history (last 20 files).
 *
 * The extension stores the position as a custom document info entry, /ANYfileLastView =
 * JSON { v, page, left?, top?, t? } (PDF coordinates of the page, t = save time in ms). Other PDF
 * readers do not act on it, but may list it in their document properties.
 * When a PDF is opened, the stored position is used only if it was saved after this device last
 * showed the document (e.g. on another device); otherwise PDF.js's local history, which is exact
 * and also covers quitting VS Code without closing the editor, stays in charge.
 *
 * Messages (vscodeEvent):
 *   -> pdfViewStored  { page, fingerprint }  position found in the file when it was loaded (page null if none)
 *   -> pdfViewChanged { page, left, top }    current position: right away on page changes, debounced within a page
 *   <- pdfViewConfig  { rememberPosition }
 */
(function () {
  const VIEW_STATE_KEY = 'ANYfileLastView';
  const LAST_SEEN_STORAGE_KEY = 'anyfile.pdf.lastSeen';
  const LAST_SEEN_LIMIT = 500;
  const CHANGE_DEBOUNCE_MS = 400;
  // The extension sends the config right after 'init'; do not block forever if it never arrives.
  const CONFIG_WAIT_MS = 1500;
  // Upper bound for PDF.js to lay out every page (it re-applies the initial view for mixed page sizes).
  const PAGES_LOADED_WAIT_MS = 10000;
  const USER_INPUT_EVENTS = ['wheel', 'keydown', 'pointerdown', 'touchstart'];

  let rememberPosition = null;
  const configWaiters = [];
  let restoredOnce = false;
  // Positions are reported only for this document, once its initial view is final.
  let settledDoc = null;
  let fingerprint = null;
  let lastEmittedPage = null;
  let pending = null;
  let timer = null;
  let userInput = false;

  function app() {
    return window.PDFViewerApplication || null;
  }

  function emit(type, data) {
    if (window.vscodeEvent) {
      window.vscodeEvent.emit(type, data);
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function whenConfigKnown() {
    if (rememberPosition !== null) {
      return Promise.resolve(rememberPosition);
    }
    return new Promise((resolve) => {
      configWaiters.push(resolve);
      setTimeout(() => resolve(rememberPosition !== false), CONFIG_WAIT_MS);
    });
  }

  function onConfig(config) {
    rememberPosition = !(config && config.rememberPosition === false);
    configWaiters.splice(0).forEach((resolve) => resolve(rememberPosition));
  }

  /* ------------------------------------------------- local "last seen" times */

  function loadLastSeen() {
    try {
      const value = JSON.parse(localStorage.getItem(LAST_SEEN_STORAGE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function markSeen(fp) {
    if (!fp) {
      return;
    }
    try {
      const seen = loadLastSeen();
      seen[fp] = Date.now();
      const entries = Object.entries(seen);
      if (entries.length > LAST_SEEN_LIMIT) {
        entries.sort((a, b) => b[1] - a[1]);
        localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, LAST_SEEN_LIMIT))));
        return;
      }
      localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify(seen));
    } catch {
      // ignore storage errors
    }
  }

  /* ------------------------------------------------------------------ restore */

  function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function parseStored(raw, numPages) {
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      const value = JSON.parse(raw);
      const page = value && value.page;
      if (!Number.isInteger(page) || page < 1 || page > numPages) {
        return null;
      }
      return { page, left: finiteOrNull(value.left), top: finiteOrNull(value.top), t: finiteOrNull(value.t) };
    } catch {
      return null;
    }
  }

  function jumpTo(pdfApp, stored) {
    pdfApp.pdfViewer.scrollPageIntoView({
      pageNumber: stored.page,
      // null zoom keeps the current zoom; null left/top means the page's left/top edge
      destArray: [null, { name: 'XYZ' }, stored.left, stored.top, null],
    });
  }

  function trackUserInput() {
    userInput = false;
    const container = document.getElementById('viewerContainer');
    if (!container) {
      return () => {};
    }
    const onInput = () => { userInput = true; };
    USER_INPUT_EVENTS.forEach((type) => container.addEventListener(type, onInput, { passive: true }));
    return () => USER_INPUT_EVENTS.forEach((type) => container.removeEventListener(type, onInput));
  }

  // Runs after PDF.js applied its initial view (its local history, if any).
  async function onDocumentInit() {
    const pdfApp = app();
    const doc = pdfApp && pdfApp.pdfDocument;
    if (!doc) {
      return;
    }
    settledDoc = null;
    lastEmittedPage = null;
    fingerprint = (doc.fingerprints && doc.fingerprints[0]) || doc.fingerprint || null;
    // Only the first document of this viewer may jump to the stored position: later loads are reloads
    // (e.g. after removing a highlight or an external change), where local history holds the position.
    const isFirstLoad = !restoredOnce;
    restoredOnce = true;
    const lastSeen = fingerprint ? loadLastSeen()[fingerprint] : undefined;
    let stored = null;
    try {
      const { info } = await doc.getMetadata();
      stored = parseStored(info && info.Custom && info.Custom[VIEW_STATE_KEY], doc.numPages);
    } catch {
      stored = null;
    }
    const enabled = await whenConfigKnown();
    if (doc !== pdfApp.pdfDocument) {
      return;
    }
    // Newer than what this device last showed (or never shown here): it comes from elsewhere.
    const newer = stored && (typeof lastSeen !== 'number' || (stored.t !== null && stored.t > lastSeen));
    if (enabled && isFirstLoad && newer) {
      const stopTracking = trackUserInput();
      if (stored.page !== pdfApp.page) {
        jumpTo(pdfApp, stored);
      }
      // With mixed page sizes PDF.js re-applies its initial view once every page is laid out,
      // which undoes the jump: re-apply it unless the reader has moved in the meantime.
      await Promise.race([pdfApp.pdfViewer.pagesPromise, delay(PAGES_LOADED_WAIT_MS)]);
      await delay(0);
      stopTracking();
      if (doc === pdfApp.pdfDocument && !userInput && pdfApp.page !== stored.page) {
        jumpTo(pdfApp, stored);
      }
    }
    if (doc !== pdfApp.pdfDocument) {
      return;
    }
    emit('pdfViewStored', { page: stored ? stored.page : null, fingerprint });
    settledDoc = doc;
    reportCurrent(pdfApp);
  }

  /* ------------------------------------------------------------------- report */

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (pending) {
      emit('pdfViewChanged', pending);
      lastEmittedPage = pending.page;
      pending = null;
      markSeen(fingerprint);
    }
  }

  function report(location) {
    pending = { page: location.pageNumber, left: finiteOrNull(location.left), top: finiteOrNull(location.top) };
    clearTimeout(timer);
    // A page change is sent right away: the extension saves when the editor is hidden or closed,
    // and the webview may be gone before a debounce fires.
    if (pending.page !== lastEmittedPage) {
      flush();
      return;
    }
    timer = setTimeout(flush, CHANGE_DEBOUNCE_MS);
  }

  function reportCurrent(pdfApp) {
    const location = pdfApp.pdfViewer && pdfApp.pdfViewer._location;
    if (location) {
      report(location);
    }
  }

  function onUpdateViewArea(event) {
    const location = event && event.location;
    const pdfApp = app();
    if (!location || !pdfApp || !pdfApp.isInitialViewSet || !settledDoc || pdfApp.pdfDocument !== settledDoc) {
      return;
    }
    report(location);
  }

  // Register right away so a config sent in response to 'init' is never missed.
  if (window.vscodeEvent) {
    window.vscodeEvent.on('pdfViewConfig', onConfig);
  }

  window.addEventListener('load', function () {
    // Best effort: send a pending within-page move before the editor is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    });
    window.addEventListener('pagehide', flush);
    PDFViewerApplication.initializedPromise.then(() => {
      const eventBus = PDFViewerApplication.eventBus;
      eventBus.on('documentinit', () => { void onDocumentInit(); });
      eventBus.on('updateviewarea', onUpdateViewArea);
    });
  }, { once: true });
}());
