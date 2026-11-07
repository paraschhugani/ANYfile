# ANYfile for iPhone and iPad

The ANYfile viewers from the VS Code extension, as an iOS app. PDFs: it reads and writes the same things
inside the PDF, so a PDF in iCloud Drive opens at the same page, with the same highlights, on the Mac
(VS Code) and on the iPhone. Excel, CSV, Word, PowerPoint, EPUB, fonts and Parquet open view-only in the
extension's React viewers; images open in the system's Quick Look.

- **Shared with the extension:** the viewer (`resource/pdf`: PDF.js, `highlight.js`, `viewstate.js`)
  and the PDF writer (`src/provider/handlers/pdfHighlightWriter.ts`). `build.mjs` copies the viewer as-is and
  swaps the VS Code bridge (`resource/lib/vscode.js`) for `src/bridge.ts`.
- **Shared with the extension (other formats):** the React viewer app (`src/react`), built by `build.mjs` with
  Vite; `src/reactBridge.ts` stands in for `acquireVsCodeApi` and `src/officeHost.ts` for `commonHandler.ts`.
- **App only (JavaScript):** `src/host.ts` (the app's version of `pdfHighlightHandler.ts`), the library screen
  (`src/formats.ts` maps each file type to its viewer), pinch to zoom, saving when the app leaves the screen.
- **Native (one Swift file):** `ios/App/App/AnyFilePlugin.swift` opens files in place from Files / iCloud Drive,
  remembers them, and reads/writes them with file coordination. A save is refused if the file changed since it
  was read; the app then re-reads it and applies its change again, so nothing another device saved is lost.

## Build and run

Needs Xcode (with the iOS platform installed) and Node.js. CocoaPods is not needed (Swift Package Manager).

```bash
cd mobile
npm install
npm run ios       # builds and runs it in a simulator (pick one from the list)
npm run sync      # or: build www/ and copy it into the Xcode project,
npm run open      #     then open Xcode
```

In Xcode, pick a simulator or your iPhone and press Run.

### On your iPhone or iPad

1. Xcode → Settings → Accounts: add your Apple ID.
2. Select the **App** target → Signing & Capabilities → Team: pick your team (a free Apple ID shows as
   "Personal Team"). If Xcode says the bundle identifier is taken, change `com.paraschhugani.anyfile` to something unique.
3. Connect the iPhone, turn on Developer Mode (Settings → Privacy & Security → Developer Mode), and press Run.
4. The first time, trust the developer on the iPhone: Settings → General → VPN & Device Management.

With a free Apple ID the app stops opening after 7 days; press Run in Xcode again to renew it. A paid Apple
Developer account ($99/year) makes it last a year and allows TestFlight.

After changing anything in `resource/pdf`, `src/`, or `mobile/src`, run `npm run sync` again.

## Tests

```bash
npm test            # the web side in headless Chrome as an iPhone, with a fake native plugin (PDF and each format)
npm run typecheck
```

Debug builds also accept launch arguments for scripted runs in the Simulator:

```bash
xcrun simctl launch --console-pty booted com.paraschhugani.anyfile \
  -anyfileOpen /path/to/file.pdf -anyfileTest "page:3;wait:1000;highlight:some words;report"
```
