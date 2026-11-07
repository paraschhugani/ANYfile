// The native side of the app (ios/App/App/AnyFilePlugin.swift): file picking, the library,
// coordinated reads/writes, and Quick Look previews. Tests replace it with an in-memory fake (window.__ANYFILE_FAKE__).
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface LibraryFile {
    id: string;
    name: string;
    folder?: string;
    added: number;
    lastOpened?: number;
    lastPage?: number;
    pageCount?: number;
    /** A copy kept inside the app (opened from an app that could not share the original) */
    inApp?: boolean;
}

export interface ReadResult {
    /** Private copy of the file content, loadable through Capacitor.convertFileSrc */
    path: string;
    name: string;
    /** Modification time (ms) to pass back when writing: the write is refused if the file changed since */
    modified: number;
    size: number;
    writable: boolean;
}

export interface AnyFileNative {
    pickFiles(): Promise<{ files: LibraryFile[], failed: string[] }>;
    /** Shows the file with the system's Quick Look (images). */
    previewFile(options: { id: string }): Promise<void>;
    listFiles(): Promise<{ files: LibraryFile[] }>;
    updateFile(options: { id: string, lastOpened?: number, lastPage?: number, pageCount?: number }): Promise<void>;
    removeFile(options: { id: string }): Promise<void>;
    readFile(options: { id: string }): Promise<ReadResult>;
    writeBegin(): Promise<{ token: string }>;
    writeChunk(options: { token: string, data: string }): Promise<void>;
    writeCommit(options: { token: string, id: string, expectedModified?: number }): Promise<{ modified: number }>;
    writeAbort(options: { token: string }): Promise<void>;
    takeOpenedFile(): Promise<{ id: string | null }>;
    endBackgroundTask(): Promise<void>;
    getTestScript(): Promise<{ script: string | null }>;
    addListener(event: 'willResignActive' | 'fileOpened' | 'previewClosed', listener: () => void): Promise<PluginListenerHandle>;
}

declare global {
    interface Window {
        __ANYFILE_FAKE__?: AnyFileNative;
    }
}

const plugin = registerPlugin<AnyFileNative>('AnyFile');

export function native(): AnyFileNative {
    return window.__ANYFILE_FAKE__ ?? plugin;
}

export interface FileContent extends ReadResult {
    bytes: Uint8Array;
}

/** Reads the current content of a library file (downloading it from iCloud first when needed). */
export async function readFileBytes(id: string): Promise<FileContent> {
    const result = await native().readFile({ id });
    const response = await fetch(Capacitor.convertFileSrc(result.path));
    if (!response.ok) {
        throw new Error(`Could not load the file (${response.status}).`);
    }
    return { ...result, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** The bridge carries strings: send the bytes as base64 pieces of this size. */
const CHUNK_BYTES = 3 * 1024 * 1024;

/**
 * Replaces the file's content. Rejects with a 'conflict' error (see {@link isConflict}) when the file
 * changed after `expectedModified`, i.e. after it was read: the caller re-reads and applies again.
 */
export async function writeFileBytes(id: string, bytes: Uint8Array, expectedModified?: number): Promise<number> {
    const api = native();
    const { token } = await api.writeBegin();
    try {
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
            await api.writeChunk({ token, data: await toBase64(bytes.subarray(offset, offset + CHUNK_BYTES)) });
        }
    } catch (error) {
        void api.writeAbort({ token }).catch(() => undefined);
        throw error;
    }
    const { modified } = await api.writeCommit({ token, id, expectedModified });
    return modified;
}

export function isConflict(error: unknown): boolean {
    return (error as { code?: string })?.code === 'conflict';
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof (error as { message?: unknown })?.message === 'string') {
        return (error as { message: string }).message;
    }
    return String(error);
}

function toBase64(bytes: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
        reader.onerror = () => reject(reader.error ?? new Error('Could not encode the file.'));
        reader.readAsDataURL(new Blob([bytes as BlobPart]));
    });
}

/** The library entry of a file, or undefined if it is no longer in the library. */
export async function findLibraryFile(id: string): Promise<LibraryFile | undefined> {
    return (await native().listFiles()).files.find(file => file.id === id);
}
