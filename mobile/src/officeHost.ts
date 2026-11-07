// The app's counterpart of src/provider/compress/commonHandler.ts for the React viewers (Excel, Word,
// PowerPoint, EPUB, fonts, Parquet, ICNS): answers 'init' with the file, like the extension does.
// Viewing only for now: files open read-only and nothing is written back.
import { Capacitor } from '@capacitor/core';
import type { HostHandler } from './host';
import { errorMessage, native } from './native';
import { extensionOf } from './formats';

export interface OfficeHostHooks {
    onOpened?(name: string): void;
    onLoadError?(message: string): void;
}

export class OfficeHost {
    constructor(private readonly handler: HostHandler, readonly fileId: string, private readonly hooks: OfficeHostHooks = {}) {
        handler
            .on('init', () => { void this.open(); })
            // Read-only views should not save; answer anyway so a view never waits forever.
            .on('save', () => handler.emit('saveDone'))
            .on('saveAs', () => handler.emit('saveDone'))
            .on('openExternal', (url: unknown) => {
                if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
                    // Capacitor hands navigation to other sites to Safari.
                    window.open(url, '_blank');
                }
            });
    }

    private async open() {
        try {
            const file = await native().readFile({ id: this.fileId });
            this.hooks.onOpened?.(file.name);
            const extension = extensionOf(file.name);
            // Same payload as officeContent.ts: the view fetches `path` itself (no copy through the bridge).
            this.handler.emit('open', {
                path: Capacitor.convertFileSrc(file.path),
                ext: extension ? `.${extension}` : '',
                fileName: file.name,
                readOnly: true,
                documentCacheId: this.fileId,
            });
            void native().updateFile({ id: this.fileId, lastOpened: Date.now() }).catch(() => undefined);
        } catch (error) {
            this.hooks.onLoadError?.(errorMessage(error));
        }
    }
}
