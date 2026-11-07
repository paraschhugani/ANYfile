import Foundation
import UIKit
import UniformTypeIdentifiers
import QuickLook
import Capacitor

/// Native file access for ANYfile, and nothing else: the viewers, highlights, reading position and PDF
/// writing are the shared JavaScript of the VS Code extension.
///
/// Files are opened in place (iCloud Drive, On My iPhone, other file providers), remembered across
/// launches with bookmarks, and read/written with file coordination so iCloud sync never sees a
/// half-written file. Writes are refused when the file changed since it was read ("conflict"), so the
/// JavaScript can re-read it and apply its change again instead of overwriting another device's edit.
/// Images are shown with the system's Quick Look.
@objc(AnyFilePlugin)
public class AnyFilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    public let identifier = "AnyFilePlugin"
    public let jsName = "AnyFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previewFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeBegin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeCommit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeAbort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeOpenedFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endBackgroundTask", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTestScript", returnType: CAPPluginReturnPromise),
    ]

    private let store = FileStore()
    /// Reads may wait for an iCloud download: they must not block writes or each other.
    private let readQueue = DispatchQueue(label: "anyfile.read", qos: .userInitiated, attributes: .concurrent)
    private let writeQueue = DispatchQueue(label: "anyfile.write", qos: .userInitiated)
    private let lock = NSLock()
    private var pickCall: CAPPluginCall?
    private var openedFileId: String?
    private var writes: [String: URL] = [:]
    private var readCopies: [String: URL] = [:]
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var previewURL: URL?
    private var testScript: String?

    private static let supportDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ANYfile", isDirectory: true)
    private static let cacheDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ANYfile-read", isDirectory: true)
    private static let writeDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ANYfile-write", isDirectory: true)
    private static let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    override public func load() {
        store.load(from: Self.supportDirectory.appendingPathComponent("library.json"))
        // Read copies and unfinished writes from an earlier launch are never needed again.
        for directory in [Self.cacheDirectory, Self.writeDirectory] {
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(willResignActive),
                                               name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didOpenURL(_:)),
                                               name: .capacitorSceneOpenURL, object: nil)
        #if DEBUG
        readTestArguments()
        #endif
    }

    // MARK: - Library

    /// Any file: the page decides which ones it can show (by extension) and explains the others.
    @objc func pickFiles(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pickCall == nil, let presenter = self.bridge?.viewController else {
                call.reject("The file picker is already open.", "busy")
                return
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
            picker.allowsMultipleSelection = true
            picker.shouldShowFileExtensions = true
            picker.delegate = self
            self.pickCall = call
            presenter.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        readQueue.async {
            var files: [JSObject] = []
            var failed: [String] = []
            for url in urls {
                do {
                    files.append(try self.addFile(url, inApp: false).json)
                } catch {
                    failed.append(url.lastPathComponent)
                }
            }
            call.resolve(["files": files, "failed": failed])
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.resolve(["files": [], "failed": []])
        pickCall = nil
    }

    @objc func listFiles(_ call: CAPPluginCall) {
        call.resolve(["files": store.all().map(\.json)])
    }

    @objc func updateFile(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing file id.", "invalid")
            return
        }
        store.update(id) { entry in
            if let value = call.getDouble("lastOpened") { entry.lastOpened = value }
            if let value = call.getInt("lastPage") { entry.lastPage = value }
            if let value = call.getInt("pageCount") { entry.pageCount = value }
        }
        call.resolve()
    }

    /// Forgets the file (the file itself is not deleted, except a copy that lives inside the app).
    @objc func removeFile(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let entry = store.get(id) else {
            call.resolve()
            return
        }
        store.remove(id)
        if entry.inApp == true, let url = try? resolve(entry) {
            try? FileManager.default.removeItem(at: url)
        }
        call.resolve()
    }

    /// Adds (or refreshes) a file; the same file picked again keeps its id.
    private func addFile(_ url: URL, inApp: Bool) throws -> FileEntry {
        return try withAccess(url) {
            let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            let path = url.standardizedFileURL.path
            var entry = store.find(path: path) ?? FileEntry(id: UUID().uuidString, name: url.lastPathComponent, path: path,
                                                           bookmark: bookmark, added: Date().timeIntervalSince1970 * 1000)
            entry.name = url.lastPathComponent
            entry.folder = Self.folderName(of: url)
            entry.bookmark = bookmark
            entry.inApp = inApp
            store.put(entry)
            return entry
        }
    }

    // MARK: - Reading

    /// Copies the current file content (downloading it first when it is only in iCloud) to a private
    /// file the web view can load, and returns its path with the modification time to pass back on write.
    @objc func readFile(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let entry = store.get(id) else {
            call.reject("This file is no longer in your library.", "not-found")
            return
        }
        readQueue.async {
            do {
                let url = try self.resolve(entry)
                let result: JSObject = try self.withAccess(url) {
                    try? FileManager.default.startDownloadingUbiquitousItem(at: url)
                    // Keeps the extension: viewers pick the format from it (e.g. the font viewer's WOFF2 check).
                    let copy = Self.cacheDirectory.appendingPathComponent(Self.copyName(for: url))
                    var modified = 0.0
                    var size = 0
                    try self.coordinate(reading: url) { readURL in
                        try FileManager.default.copyItem(at: readURL, to: copy)
                        modified = try Self.modificationTime(of: readURL)
                        size = (try? FileManager.default.attributesOfItem(atPath: readURL.path)[.size] as? Int) ?? 0
                    }
                    return [
                        "path": copy.path,
                        "name": url.lastPathComponent,
                        "modified": modified,
                        "size": size,
                        "writable": FileManager.default.isWritableFile(atPath: url.path),
                    ]
                }
                self.replaceReadCopy(id, with: URL(fileURLWithPath: result["path"] as? String ?? ""))
                call.resolve(result)
            } catch {
                call.reject(Self.describe(error), "read-failed", error)
            }
        }
    }

    private func replaceReadCopy(_ id: String, with copy: URL) {
        lock.lock()
        let previous = readCopies[id]
        readCopies[id] = copy
        lock.unlock()
        if let previous, previous != copy {
            try? FileManager.default.removeItem(at: previous)
        }
    }

    // MARK: - Writing (chunked: the bridge carries strings, so the bytes come as base64 pieces)

    @objc func writeBegin(_ call: CAPPluginCall) {
        let token = UUID().uuidString
        let temp = Self.writeDirectory.appendingPathComponent(token)
        guard FileManager.default.createFile(atPath: temp.path, contents: nil) else {
            call.reject("Could not prepare the save.", "write-failed")
            return
        }
        lock.lock()
        writes[token] = temp
        lock.unlock()
        call.resolve(["token": token])
    }

    @objc func writeChunk(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), let temp = write(token) else {
            call.reject("Unknown save.", "invalid")
            return
        }
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64) else {
            call.reject("Invalid data.", "invalid")
            return
        }
        do {
            let handle = try FileHandle(forWritingTo: temp)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            call.resolve()
        } catch {
            call.reject(Self.describe(error), "write-failed", error)
        }
    }

    /// Replaces the file with the written bytes, unless it changed since `expectedModified` (ms).
    @objc func writeCommit(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), let temp = write(token) else {
            call.reject("Unknown save.", "invalid")
            return
        }
        guard let id = call.getString("id"), let entry = store.get(id) else {
            finishWrite(token)
            call.reject("This file is no longer in your library.", "not-found")
            return
        }
        let expected = call.getDouble("expectedModified")
        writeQueue.async {
            defer { self.finishWrite(token) }
            do {
                let url = try self.resolve(entry)
                let modified: Double = try self.withAccess(url) {
                    var modified = 0.0
                    try self.coordinate(writing: url) { writeURL in
                        let current = try Self.modificationTime(of: writeURL)
                        if let expected, abs(current - expected) > 1 {
                            throw AnyFileError.conflict
                        }
                        try Data(contentsOf: temp).write(to: writeURL, options: .atomic)
                        modified = try Self.modificationTime(of: writeURL)
                    }
                    return modified
                }
                call.resolve(["modified": modified])
            } catch AnyFileError.conflict {
                call.reject("The file was changed by another app or device.", "conflict")
            } catch {
                call.reject(Self.describe(error), "write-failed", error)
            }
        }
    }

    @objc func writeAbort(_ call: CAPPluginCall) {
        if let token = call.getString("token") {
            finishWrite(token)
        }
        call.resolve()
    }

    private func write(_ token: String) -> URL? {
        lock.lock()
        defer { lock.unlock() }
        return writes[token]
    }

    private func finishWrite(_ token: String) {
        lock.lock()
        let temp = writes.removeValue(forKey: token)
        lock.unlock()
        if let temp {
            try? FileManager.default.removeItem(at: temp)
        }
    }

    // MARK: - Quick Look (images, HEIC, TIFF...)

    /// Shows the file with the system viewer. It previews a private copy, so Quick Look never edits the original.
    @objc func previewFile(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let entry = store.get(id) else {
            call.reject("This file is no longer in your library.", "not-found")
            return
        }
        readQueue.async {
            do {
                let url = try self.resolve(entry)
                let copy: URL = try self.withAccess(url) {
                    try? FileManager.default.startDownloadingUbiquitousItem(at: url)
                    // Its own folder, so the copy keeps the file's name (Quick Look shows it as the title).
                    let folder = Self.cacheDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let copy = folder.appendingPathComponent(url.lastPathComponent)
                    try self.coordinate(reading: url) { readURL in
                        try FileManager.default.copyItem(at: readURL, to: copy)
                    }
                    return copy
                }
                DispatchQueue.main.async {
                    guard let presenter = self.bridge?.viewController else {
                        call.reject("Could not show the file.", "unavailable")
                        return
                    }
                    self.previewURL = copy
                    let controller = QLPreviewController()
                    controller.dataSource = self
                    controller.delegate = self
                    presenter.present(controller, animated: true)
                    self.store.update(id) { $0.lastOpened = Date().timeIntervalSince1970 * 1000 }
                    call.resolve()
                }
            } catch {
                call.reject(Self.describe(error), "read-failed", error)
            }
        }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        return previewURL == nil ? 0 : 1
    }

    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        return (previewURL ?? URL(fileURLWithPath: "/")) as NSURL
    }

    public func previewController(_ controller: QLPreviewController, editingModeFor previewItem: QLPreviewItem) -> QLPreviewItemEditingMode {
        return .disabled
    }

    public func previewControllerDidDismiss(_ controller: QLPreviewController) {
        if let folder = previewURL?.deletingLastPathComponent() {
            try? FileManager.default.removeItem(at: folder)
        }
        previewURL = nil
        notifyListeners("previewClosed", data: [:])
    }

    // MARK: - Opening from other apps ("Open in ANYfile", Files app)

    @objc private func didOpenURL(_ notification: Notification) {
        guard let url = notification.userInfo?["url"] as? URL, url.isFileURL else { return }
        let options = notification.userInfo?["options"] as? [UIApplication.OpenURLOptionsKey: Any]
        let inPlace = options?[.openInPlace] as? Bool ?? false
        readQueue.async {
            do {
                // Opened in place: edit the original. Otherwise iOS handed over a copy: keep it in the app.
                let entry: FileEntry
                if inPlace {
                    entry = try self.addFile(url, inApp: false)
                } else {
                    entry = try self.addFile(try self.keepCopy(of: url), inApp: true)
                }
                self.lock.lock()
                self.openedFileId = entry.id
                self.lock.unlock()
                self.notifyListeners("fileOpened", data: [:])
            } catch {
                CAPLog.print("ANYfile: could not open \(url.lastPathComponent): \(error)")
            }
        }
    }

    private func keepCopy(of url: URL) throws -> URL {
        let folder = Self.documentsDirectory.appendingPathComponent("Opened", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let base = url.deletingPathExtension().lastPathComponent
        let suffix = url.pathExtension.isEmpty ? "" : ".\(url.pathExtension)"
        var destination = folder.appendingPathComponent(url.lastPathComponent)
        var counter = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = folder.appendingPathComponent("\(base) \(counter)\(suffix)")
            counter += 1
        }
        try withAccess(url) {
            try FileManager.default.copyItem(at: url, to: destination)
        }
        return destination
    }

    /// The file another app asked to open, once (the event alone can fire before the page listens).
    @objc func takeOpenedFile(_ call: CAPPluginCall) {
        lock.lock()
        let id = openedFileId
        openedFileId = nil
        lock.unlock()
        call.resolve(["id": id ?? NSNull()])
    }

    // MARK: - Saving when the app leaves the screen

    /// The app may be suspended right after this: keep it running while the page saves the reading position.
    @objc private func willResignActive() {
        DispatchQueue.main.async {
            if self.backgroundTask == .invalid {
                let task = UIApplication.shared.beginBackgroundTask(withName: "ANYfile save") { [weak self] in
                    self?.finishBackgroundTask()
                }
                self.backgroundTask = task
                DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                    if self?.backgroundTask == task {
                        self?.finishBackgroundTask()
                    }
                }
            }
            self.notifyListeners("willResignActive", data: [:])
        }
    }

    @objc func endBackgroundTask(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.finishBackgroundTask()
            call.resolve()
        }
    }

    private func finishBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // MARK: - Testing (debug builds only)

    @objc func getTestScript(_ call: CAPPluginCall) {
        call.resolve(["script": testScript ?? NSNull()])
    }

    #if DEBUG
    /// `simctl launch <device> <bundle id> -anyfileOpen /path/file.pdf [-anyfileTest script]`
    private func readTestArguments() {
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-anyfileOpen"), index + 1 < arguments.count,
           let entry = try? addFile(URL(fileURLWithPath: arguments[index + 1]), inApp: false) {
            openedFileId = entry.id
        }
        if let index = arguments.firstIndex(of: "-anyfileTest"), index + 1 < arguments.count {
            testScript = arguments[index + 1]
        }
    }
    #endif

    // MARK: - Helpers

    private func resolve(_ entry: FileEntry) throws -> URL {
        var stale = false
        let url = try URL(resolvingBookmarkData: entry.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        if stale, let bookmark = try? withAccess(url, { try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) }) {
            store.update(entry.id) { $0.bookmark = bookmark; $0.path = url.standardizedFileURL.path; $0.name = url.lastPathComponent }
        }
        return url
    }

    private func withAccess<T>(_ url: URL, _ body: () throws -> T) rethrows -> T {
        // False for files that need no grant (e.g. inside the app): they are readable anyway.
        let accessing = url.startAccessingSecurityScopedResource()
        defer {
            if accessing { url.stopAccessingSecurityScopedResource() }
        }
        return try body()
    }

    private func coordinate(reading url: URL, _ body: (URL) throws -> Void) throws {
        var coordinationError: NSError?
        var bodyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readURL in
            do { try body(readURL) } catch { bodyError = error }
        }
        if let error = coordinationError ?? bodyError { throw error }
    }

    private func coordinate(writing url: URL, _ body: (URL) throws -> Void) throws {
        var coordinationError: NSError?
        var bodyError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { writeURL in
            do { try body(writeURL) } catch { bodyError = error }
        }
        if let error = coordinationError ?? bodyError { throw error }
    }

    /// Not URL.resourceValues: those are cached per URL instance and would miss our own write.
    private static func modificationTime(of url: URL) throws -> Double {
        let date = try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
        return (date?.timeIntervalSince1970 ?? 0) * 1000
    }

    private static func copyName(for url: URL) -> String {
        let suffix = url.pathExtension.lowercased()
        return suffix.isEmpty ? UUID().uuidString : "\(UUID().uuidString).\(suffix)"
    }

    private static func folderName(of url: URL) -> String {
        let folder = url.deletingLastPathComponent()
        if folder.lastPathComponent == "com~apple~CloudDocs" { return "iCloud Drive" }
        if folder.standardizedFileURL.path == documentsDirectory.appendingPathComponent("Opened").standardizedFileURL.path { return "ANYfile" }
        return folder.lastPathComponent
    }

    private static func describe(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSCocoaErrorDomain {
            switch nsError.code {
            case NSFileNoSuchFileError, NSFileReadNoSuchFileError:
                return "The file was moved or deleted."
            case NSFileReadNoPermissionError, NSFileWriteNoPermissionError:
                return "ANYfile is not allowed to access this file. Open it again from Files."
            case NSFileWriteOutOfSpaceError:
                return "There is not enough storage to save the file."
            default:
                break
            }
        }
        return nsError.localizedDescription
    }
}

private enum AnyFileError: Error {
    case conflict
}

struct FileEntry: Codable {
    var id: String
    var name: String
    var folder: String?
    var path: String
    var bookmark: Data
    var added: Double
    var lastOpened: Double?
    var lastPage: Int?
    var pageCount: Int?
    var inApp: Bool?

    init(id: String, name: String, path: String, bookmark: Data, added: Double) {
        self.id = id
        self.name = name
        self.path = path
        self.bookmark = bookmark
        self.added = added
    }

    var json: JSObject {
        var object: JSObject = ["id": id, "name": name, "added": added, "inApp": inApp ?? false]
        if let folder { object["folder"] = folder }
        if let lastOpened { object["lastOpened"] = lastOpened }
        if let lastPage { object["lastPage"] = lastPage }
        if let pageCount { object["pageCount"] = pageCount }
        return object
    }
}

/// The library: which files the app may open, persisted as JSON in Application Support.
final class FileStore {
    private let lock = NSLock()
    private var entries: [FileEntry] = []
    private var fileURL: URL?

    func load(from url: URL) {
        lock.lock()
        defer { lock.unlock() }
        fileURL = url
        if let data = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode([FileEntry].self, from: data) {
            entries = decoded
        }
    }

    func all() -> [FileEntry] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    func get(_ id: String) -> FileEntry? {
        lock.lock()
        defer { lock.unlock() }
        return entries.first { $0.id == id }
    }

    func find(path: String) -> FileEntry? {
        lock.lock()
        defer { lock.unlock() }
        return entries.first { $0.path == path }
    }

    func put(_ entry: FileEntry) {
        lock.lock()
        defer { lock.unlock() }
        if let index = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[index] = entry
        } else {
            entries.append(entry)
        }
        persist()
    }

    func update(_ id: String, _ change: (inout FileEntry) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        change(&entries[index])
        persist()
    }

    func remove(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll { $0.id == id }
        persist()
    }

    /// Called with the lock held.
    private func persist() {
        guard let fileURL, let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
    }
}
