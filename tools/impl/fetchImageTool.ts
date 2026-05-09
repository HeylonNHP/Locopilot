import type { ToolSchema } from '../../tools/tools';

export const fetchImageToolSchema: ToolSchema = {
    name: 'fetch_image',
    description: 'Fetches an image from a URL or local file path and attaches it to the conversation. Only use with vision-capable models. Supported formats: JPEG, PNG, GIF, WebP, BMP. Maximum size: 10 MB.',
    parameters: {
        type: 'object',
        properties: {
            source: { type: 'string', description: 'A full http/https URL (e.g. https://example.com/photo.jpg) or an absolute local file path (e.g. /home/user/photo.png or C:\\Users\\user\\photo.png).' },
        },
        required: ['source'],
    },
};


const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 15_000;

import axios from 'axios';
import { readFile } from 'fs/promises';
import imageType from 'image-type';
import { fileURLToPath } from 'node:url';
import { DEFAULT_USER_AGENT } from '../web/htmlExtractor';

/**
 * Detects the actual image format from the file's magic bytes using the `image-type` library.
 * Returns the detected MIME type, or throws if the bytes don't match
 * any supported image format. This guards against files that have an
 * image extension or Content-Type but are actually HTML/text (e.g. a
 * server returning an error page with a .png URL).
 */
async function detectMimeTypeFromBytes(buf: Buffer): Promise<string> {
    if (buf.length < 4) throw new Error('File is too small to be a valid image.');

    const type = await imageType(buf);

    if (type && type.mime.startsWith('image/')) {
        return type.mime;
    }

    throw new Error(
        'File content does not match any supported image format. ' +
        'The URL or path may point to an HTML page or other non-image resource.'
    );
}

export interface FetchImageToolArgs {
    source?: string;
}

export interface FetchImageToolOptions {
    timeoutMs?: number;
    onProgress?: (message: string) => void;
}

interface FetchedImage {
    base64: string;
    mimeType: string;
    sizeKb: number;
    label: string;
}

async function fetchRemoteImage(url: string, timeoutMs: number): Promise<FetchedImage> {
    const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxContentLength: MAX_IMAGE_BYTES,
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
    });

    const buffer = Buffer.from(response.data);
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${(buffer.length / 1_048_576).toFixed(1)} MB). Limit is 10 MB.`);
    }

    const mimeType = await detectMimeTypeFromBytes(buffer);

    return {
        base64: buffer.toString('base64'),
        mimeType,
        sizeKb: Math.round(buffer.length / 1024),
        label: url,
    };
}

function normalizeLocalImagePath(source: string): string {
    try {
        const url = new URL(source);
        if (url.protocol === 'file:') {
            return fileURLToPath(url);
        }
    } catch {
        // Not a valid URL; treat source as a filesystem path.
    }

    return source;
}

async function fetchLocalImage(filePath: string): Promise<FetchedImage> {
    const buffer = await readFile(filePath);

    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${(buffer.length / 1_048_576).toFixed(1)} MB). Limit is 10 MB.`);
    }

    const mimeType = await detectMimeTypeFromBytes(buffer);

    return {
        base64: buffer.toString('base64'),
        mimeType,
        sizeKb: Math.round(buffer.length / 1024),
        label: filePath,
    };
}

export interface FetchImageResult {
    content: string;
    images?: string[];
}

export class FetchImageTool {
    private readonly timeoutMs: number;
    private readonly onProgress: ((message: string) => void) | undefined;

    constructor(options: FetchImageToolOptions = {}) {
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.onProgress = options.onProgress;
    }

    async run(args: FetchImageToolArgs, signal?: AbortSignal): Promise<FetchImageResult> {
        const source = (args.source ?? '').trim();

        if (!source) {
            return { content: '[fetch_image error: missing required argument "source".]' };
        }

        this.progress(`Fetch image: loading ${source}...`);

        try {
            let image: FetchedImage;

            if (/^https?:\/\//i.test(source)) {
                image = await fetchRemoteImage(source, this.timeoutMs);
            } else {
                const filePath = normalizeLocalImagePath(source);
                image = await fetchLocalImage(filePath);
            }

            this.progress('Fetch image: completed.');

            return {
                content: `fetch_image_result:\nsource: ${image.label}\nsize: ${image.sizeKb} KB (${image.mimeType})\nThe image has been attached and is now visible to you.`,
                images: [image.base64],
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                content: `fetch_image_result:\nsource: ${source}\nerror: ${reason}`,
            };
        }
    }

    private progress(message: string): void {
        this.onProgress?.(message);
    }
}

export function getToolPrompt(): string {
    const s = fetchImageToolSchema;
    return (
        `5. ${s.name}(source)\n` +
        `   ${s.description}\n`
    );
}
