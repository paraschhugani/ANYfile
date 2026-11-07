// Opening a library file in whatever shows it: a viewer page, or Quick Look for images.
import { formatOf, viewerUrl } from './formats';
import { findLibraryFile, native, type LibraryFile } from './native';

/**
 * Opens the file. `beforeLeave` runs before navigating away (e.g. saving the reading position).
 * Returns false when the app cannot show this kind of file.
 */
export async function openLibraryFile(file: Pick<LibraryFile, 'id' | 'name'>, beforeLeave?: () => Promise<void>): Promise<boolean> {
    const url = viewerUrl(file);
    if (url) {
        await beforeLeave?.();
        location.href = url;
        return true;
    }
    if (formatOf(file.name)?.kind === 'preview') {
        await native().previewFile({ id: file.id });
        return true;
    }
    return false;
}

/** Opens the file another app handed over ("Open in ANYfile"), if there is one. */
export async function openRequestedFile(currentId: string | null, beforeLeave?: () => Promise<void>): Promise<boolean> {
    const { id } = await native().takeOpenedFile();
    if (!id || id === currentId) {
        return false;
    }
    const file = await findLibraryFile(id);
    return file ? openLibraryFile(file, beforeLeave) : false;
}
