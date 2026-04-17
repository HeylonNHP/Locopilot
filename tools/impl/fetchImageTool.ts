import axios from 'axios';
import { readFile } from 'fs/promises';
import imageType from 'image-type';
import { DEFAULT_USER_AGENT } from '../web/htmlExtractor.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 15_000;

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

    async run(args: FetchImageToolArgs): Promise<FetchImageResult> {
        const source = (args.source ?? '').trim();

        if (!source) {
            return { content: '[fetch_image error: missing required argument "source".]' };
        }

        this.progress(`Fetch image: loading ${source}...`);

        try {
            let image: FetchedImage;

            if (source.startsWith('http://') || source.startsWith('https://')) {
                image = await fetchRemoteImage(source, this.timeoutMs);
            } else {
                const filePath = source.startsWith('file://') ? source.slice(7) : source;
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
    return (
        '5. fetch_image(source)\n' +
        '   Fetch an image from a URL or local file path and attach it to the conversation.\n' +
        '   Use this when you need to see or analyse an image. The image will be visible to you\n' +
        '   after the tool call completes. Only works with vision-capable models (e.g. llava, llama3.2-vision, gemma3).\n' +
        '   - For web images: provide a full http or https URL.\n' +
        '   - For local files: provide an absolute file path (e.g. /home/user/photo.jpg or C:\\Users\\user\\photo.jpg).\n' +
        '   - Supported formats: JPEG, PNG, GIF, WebP, BMP. Maximum size: 10 MB.\n' +
        '   - The tool verifies the actual image content by inspecting the file\'s magic bytes,\n' +
        '     so it will reject HTML error pages even if they have an image URL or extension.\n\n'
    );
}
