import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

import { IMAGE_TOKEN_ESTIMATE, READ_FILE_CHAR_WARN_THRESHOLD, READ_FILE_TOKEN_CRITICAL_PCT, READ_FILE_TOKEN_WARN_PCT } from '../../constants';
import { countTextTokens } from '../../services/tokenizer';
import { noopToolOutputSink, type ToolOutputSink } from '../toolOutput';
import { resolveAgentPath } from '../workingDirectory';
import type { ToolCallResult } from '../toolRegistry';
import type { ToolSchema } from '../../tools/tools';

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB — warn when no range provided
const MAX_PAGES_PER_CALL = 50;

export const readPdfToolSchema: ToolSchema = {
    name: 'read_pdf',
    description: `Reads text content and optionally extracts embedded images from a PDF file. Returns extracted text with page markers. Use start_page/end_page to read specific page ranges.`,
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path to the PDF file, absolute or relative to the agent working directory. Supports ~/ paths.',
            },
            start_page: {
                type: 'number',
                description: 'First page to read (1-based). Defaults to 1.',
            },
            end_page: {
                type: 'number',
                description: 'Last page to read (inclusive). Defaults to start_page + 49 (max 50 pages per call).',
            },
            extract_images: {
                type: 'boolean',
                description: `When true and the model supports vision, extracts embedded images from the selected pages and attaches them. Defaults to false. Each image costs ~${IMAGE_TOKEN_ESTIMATE.toLocaleString()} tokens in context.`,
            },
        },
        required: ['path'],
    },
};

export interface ReadPdfToolArgs {
    path?: string;
    start_page?: number;
    end_page?: number;
    extract_images?: boolean;
}

export interface ReadPdfToolOptions {
    output?: ToolOutputSink;
    model?: string | undefined;
    numCtx?: number | undefined;
}

export class ReadPdfTool {
    private readonly output: ToolOutputSink;
    private readonly model: string | undefined;
    private readonly numCtx: number | undefined;

    constructor(options: ReadPdfToolOptions = {}) {
        this.output = options.output ?? noopToolOutputSink;
        this.model = options.model;
        this.numCtx = options.numCtx;
    }

    private log(message: string): void {
        this.output.writeLine(message);
    }

    async run(args: ReadPdfToolArgs, signal?: AbortSignal): Promise<ToolCallResult> {
        const rawPath = (args.path ?? '').trim();
        if (!rawPath) {
            return { content: '[read_pdf error: missing required argument "path".]' };
        }

        let absPath: string;
        try {
            absPath = resolveAgentPath(this.output, rawPath);
        } catch (error) {
            return { content: `[read_pdf error: invalid path: ${error instanceof Error ? error.message : String(error)}]` };
        }

        let fileStat;
        try {
            fileStat = await stat(absPath);
        } catch (error) {
            return { content: `[read_pdf error: unable to access file: ${error instanceof Error ? error.message : String(error)}]` };
        }

        if (!fileStat.isFile()) {
            return { content: '[read_pdf error: target path is not a regular file.]' };
        }

        const fileBytes = fileStat.size;
        const fileSizeMB = (fileBytes / 1_048_576).toFixed(1);

        // --- Zero-byte guard ---
        if (fileBytes === 0) {
            return { content: '[read_pdf error: file is empty (0 bytes).]' };
        }

        // --- Size guard: warn when no explicit page range is provided ---
        const hasExplicitRange = args.start_page !== undefined || args.end_page !== undefined;
        if (fileBytes > MAX_FILE_BYTES && !hasExplicitRange) {
            const metadataResult = [
                'read_pdf_result:',
                `  path: ${absPath}`,
                `  size: ${fileSizeMB} MB`,
                `  total_pages: unknown (file too large to scan)`,
                `  content_type: unknown`,
                '',
                `  ⚠️ This PDF is ${fileSizeMB} MB — larger than the ${(MAX_FILE_BYTES / 1_048_576)} MB threshold for automatic extraction.`,
                `  If you still want to read it, call read_pdf again with a specific page range, e.g.:`,
                `    read_pdf(path="${rawPath}", start_page=1, end_page=50)`,
            ].join('\n');

            return { content: metadataResult };
        }

        // --- Read the PDF buffer ---
        let buffer: Buffer;
        try {
            buffer = await readFile(absPath, { signal });
        } catch (error) {
            return { content: `[read_pdf error: failed to read file: ${error instanceof Error ? error.message : String(error)}]` };
        }

        // --- Open PDF and get metadata ---
        let parser: InstanceType<typeof PDFParse> | undefined;
        let totalPages: number;
        try {
            parser = new PDFParse({ data: buffer });
            const info = await parser.getInfo();
            totalPages = info.total;
            if (!Number.isFinite(totalPages) || totalPages < 0) {
                throw new Error('Invalid page count returned by parser');
            }
        } catch (error) {
            if (parser) {
                try { await parser.destroy(); } catch { /* ignore */ }
            }
            return { content: `[read_pdf error: failed to parse PDF: ${error instanceof Error ? error.message : String(error)}]` };
        }

        try {
            // --- Validate and clamp page range ---
            let startPage = args.start_page ?? 1;
            let endPage = args.end_page;

            // Integer validation
            if (!Number.isInteger(startPage)) {
                startPage = Math.max(1, Math.floor(startPage));
            }
            if (startPage < 1) {
                startPage = 1;
            }

            const explicitEndPage = args.end_page !== undefined;

            if (endPage === undefined) {
                endPage = Math.min(startPage + MAX_PAGES_PER_CALL - 1, totalPages);
            } else {
                if (!Number.isInteger(endPage)) {
                    endPage = Math.floor(endPage);
                }
                if (!Number.isFinite(endPage) || endPage > totalPages) {
                    endPage = totalPages;
                }
            }

            // Clamp page range to max 50
            if (endPage - startPage + 1 > MAX_PAGES_PER_CALL) {
                endPage = startPage + MAX_PAGES_PER_CALL - 1;
                if (endPage > totalPages) {
                    endPage = totalPages;
                }
            }

            if (startPage > totalPages) {
                return { content: `[read_pdf error: start_page ${startPage} exceeds total pages (${totalPages}).]` };
            }

            if (startPage > endPage) {
                return { content: `[read_pdf error: start_page (${startPage}) cannot be greater than end_page (${endPage}).]` };
            }

            const clampedNote = !explicitEndPage
                ? ''
                : (args.end_page! - startPage + 1 > MAX_PAGES_PER_CALL
                    ? `\n   ℹ️ Requested page range exceeded the 50-page limit and was clamped to ${startPage}–${endPage}.\n`
                    : '');

            // --- Abort guard before heavy extraction ---
            signal?.throwIfAborted();

            // --- Extract text for the requested page range ---
            let extractedText: string;
            let textPages: Array<{ num: number; text: string }> = [];
            try {
                const textResult = await parser.getText({ partial: range(startPage, endPage) });
                extractedText = typeof textResult.text === 'string' ? textResult.text : '';
                if (textResult.pages && Array.isArray(textResult.pages)) {
                    textPages = textResult.pages;
                }
            } catch (error) {
                return { content: `[read_pdf error: failed to extract text: ${error instanceof Error ? error.message : String(error)}]` };
            }

            // --- Check for empty/scanned PDF ---
            const isScanned = !extractedText || extractedText.trim().length === 0;
            const contentType = isScanned ? 'scanned / image-based' : 'digital text';

            // --- Token warning ---
            let tokenWarning = '';
            let textTokenEstimate = 0;
            if (this.model && this.numCtx && extractedText.length > 0) {
                try {
                    textTokenEstimate = countTextTokens(extractedText, this.model);
                } catch {
                    textTokenEstimate = 0;
                }

                if (textTokenEstimate > 0) {
                    const pct = (textTokenEstimate / this.numCtx) * 100;

                    if (pct >= READ_FILE_TOKEN_CRITICAL_PCT) {
                        tokenWarning =
                            `\n🚨  Token Warning: This PDF excerpt is approximately ${textTokenEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${this.numCtx.toLocaleString()}-token context window).\n` +
                            `⚠️  Reading this entire PDF into context is strongly discouraged. Use sub-agents to analyze it instead.\n` +
                            `💡  Sub-agents have isolated context and won't consume your working memory — send them the file path and ask them to answer your question.\n`;
                    } else if (pct >= READ_FILE_TOKEN_WARN_PCT) {
                        tokenWarning =
                            `\n⚠️  Token Notice: This PDF excerpt is approximately ${textTokenEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${this.numCtx.toLocaleString()}-token context window).\n` +
                            `💡  Consider using sub-agents to process large files — they have isolated context and won't consume your working memory.\n`;
                    }
                }
            } else if (this.model && extractedText.length > 0 && extractedText.length >= READ_FILE_CHAR_WARN_THRESHOLD) {
                // Fallback: model known but numCtx unknown — use accurate token counting.
                let tokenEstimate = 0;
                try {
                    tokenEstimate = countTextTokens(extractedText, this.model);
                } catch {
                    tokenEstimate = 0;
                }
                if (tokenEstimate > 0) {
                    tokenWarning =
                        `\n⚠️  Size Notice: This PDF excerpt is approximately ${tokenEstimate.toLocaleString()} tokens.\n` +
                        `💡  Context size is unknown, so a percentage check isn't available. Consider using sub-agents to process large files — they have isolated context and won't consume your working memory.\n`;
                }
            } else if (extractedText.length > 0 && extractedText.length >= READ_FILE_CHAR_WARN_THRESHOLD) {
                // Last resort: model and context size both unknown.
                // Estimate tokens using the ~4 chars/token heuristic.
                const roughTokenEstimate = Math.round(extractedText.length / 4);
                tokenWarning =
                    `\n⚠️  Size Notice: This PDF excerpt is ${extractedText.length.toLocaleString()} characters (roughly ~${roughTokenEstimate.toLocaleString()} tokens, estimated at ~4 chars/token).\n` +
                    `💡  Model/context size is unknown, so a precise token check isn't available. Consider using sub-agents to process large files — they have isolated context and won't consume your working memory.\n`;
            }

            // --- Image extraction ---
            let images: string[] | undefined;
            if (args.extract_images) {
                try {
                    signal?.throwIfAborted();
                    const imageResult = await parser.getImage({
                        partial: range(startPage, endPage),
                        imageBuffer: true,
                        imageDataUrl: false,
                    });
                    if (imageResult?.pages) {
                        const extractedImages: string[] = [];
                        for (const page of imageResult.pages) {
                            if (page.images && Array.isArray(page.images)) {
                                for (const img of page.images) {
                                    const data: Uint8Array | Buffer | ArrayBuffer | undefined = img.data;
                                    if (data && data.byteLength > 0) {
                                        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
                                        extractedImages.push(buf.toString('base64'));
                                    }
                                }
                            }
                        }
                        if (extractedImages.length > 0) {
                            images = extractedImages;
                        }
                    }

                    // Recompute token warning with image overhead
                    if (images && images.length > 0 && this.model && this.numCtx && textTokenEstimate > 0) {
                        const totalEstimate = textTokenEstimate + images.length * IMAGE_TOKEN_ESTIMATE;
                        const pct = (totalEstimate / this.numCtx) * 100;
                        if (pct >= READ_FILE_TOKEN_CRITICAL_PCT) {
                            tokenWarning =
                                `\n🚨  Token Warning: This PDF excerpt + ${images.length} image(s) is approximately ${totalEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${this.numCtx.toLocaleString()}-token context window).\n` +
                                `⚠️  Reading this entire PDF into context is strongly discouraged. Use sub-agents to analyze it instead.\n` +
                                `💡  Sub-agents have isolated context and won't consume your working memory — send them the file path and ask them to answer your question.\n`;
                        } else if (pct >= READ_FILE_TOKEN_WARN_PCT) {
                            tokenWarning =
                                `\n⚠️  Token Notice: This PDF excerpt + ${images.length} image(s) is approximately ${totalEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${this.numCtx.toLocaleString()}-token context window).\n` +
                                `💡  Consider using sub-agents to process large files — they have isolated context and won't consume your working memory.\n`;
                        }
                    }
                } catch (error) {
                    this.log(`read_pdf: image extraction failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            // --- Build page markers ---
            let pageContent: string;
            if (isScanned) {
                const pageWord = startPage === endPage ? 'page' : 'pages';
                pageContent = `(This PDF ${pageWord} contains no extractable text — it may be a scanned document.)`;
            } else if (startPage === endPage) {
                pageContent = `\n=== Page ${startPage} ===\n${extractedText.trimEnd()}`;
            } else if (textPages.length === endPage - startPage + 1) {
                // Reliable per-page split from textResult.pages
                const pageLines: string[] = [];
                for (const p of textPages) {
                    pageLines.push(`=== Page ${p.num} ===`);
                    pageLines.push(p.text.trimEnd());
                }
                pageContent = '\n' + pageLines.join('\n');
            } else {
                // Fallback: label the range
                pageContent = `\n=== Pages ${startPage}–${endPage} ===\n${extractedText.trimEnd()}`;
            }

            // --- "More pages" notice ---
            let morePagesNote = '';
            if (endPage < totalPages) {
                morePagesNote = `\n\nℹ️ This PDF has ${totalPages} total pages. You read pages ${startPage}–${endPage}.\n   Use start_page/end_page to read other sections.`;
            }

            const resultLines = [
                'read_pdf_result:',
                `  path: ${absPath}`,
                `  total_pages: ${totalPages}`,
                `  returned_pages: ${startPage === endPage ? String(startPage) : `${startPage}-${endPage}`}`,
                `  size: ${fileSizeMB} MB`,
                `  content_type: ${contentType}`,
                clampedNote,
                tokenWarning,
                pageContent,
                morePagesNote,
            ];

            const content = resultLines.filter(l => l.trim() !== '').join('\n');

            return images !== undefined && images.length > 0
                ? { content, images }
                : { content };
        } finally {
            try {
                await parser.destroy();
            } catch {
                // Best-effort cleanup
            }
        }
    }
}

/**
 * Returns an array of integers from `from` to `to` (inclusive).
 * Guards against negative or non-finite bounds.
 */
function range(from: number, to: number): number[] {
    if (from > to) return [];
    const start = Math.max(1, Math.floor(from));
    const end = Math.max(start, Math.floor(to));
    const result: number[] = [];
    for (let i = start; i <= end; i++) {
        result.push(i);
    }
    return result;
}

export function getToolPrompt(): string {
    const s = readPdfToolSchema;
    return (
        `12. ${s.name}(path, start_page?, end_page?, extract_images?)\n` +
        `   ${s.description}\n`
    );
}
