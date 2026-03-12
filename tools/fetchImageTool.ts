import axios from 'axios';
import { readFile } from 'fs/promises';
import path from 'path';
import { DEFAULT_USER_AGENT } from './htmlExtractor.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 15_000;

const EXTENSION_TO_MIME: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
};

const SUPPORTED_MIME_TYPES = new Set(Object.values(EXTENSION_TO_MIME));

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

    const contentType = (response.headers['content-type'] as string | undefined)
        ?.split(';')[0]
        ?.trim() ?? '';

    if (!SUPPORTED_MIME_TYPES.has(contentType)) {
        throw new Error(`Unsupported content type "${contentType}". Expected an image MIME type (jpeg, png, gif, webp, bmp).`);
    }

    const buffer = Buffer.from(response.data);
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${(buffer.length / 1_048_576).toFixed(1)} MB). Limit is 10 MB.`);
    }

    return {
        base64: buffer.toString('base64'),
        mimeType: contentType,
        sizeKb: Math.round(buffer.length / 1024),
        label: url,
    };
}

async function fetchLocalImage(filePath: string): Promise<FetchedImage> {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = EXTENSION_TO_MIME[ext];

    if (!mimeType) {
        const supported = Object.keys(EXTENSION_TO_MIME).join(', ');
        throw new Error(`Unsupported file extension "${ext}". Supported: ${supported}`);
    }

    const buffer = await readFile(filePath);

    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${(buffer.length / 1_048_576).toFixed(1)} MB). Limit is 10 MB.`);
    }

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
        '   - Supported formats: JPEG, PNG, GIF, WebP, BMP. Maximum size: 10 MB.\n\n'
    );
}
