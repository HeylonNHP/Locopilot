import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const MAX_INLINE_CHARS = 50_000;
const MAX_PDF_PAGES = 50;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 });
  }

  const fileEntry = formData.get('file');
  const filenameEntry = formData.get('filename');

  if (!(fileEntry instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
  }

  const filename = typeof filenameEntry === 'string' && filenameEntry.trim().length > 0
    ? filenameEntry.trim()
    : fileEntry.name;

  // Sanitize filename: allow only safe characters to prevent path traversal.
  // Replace anything that isn't alphanumeric, dot, hyphen, or underscore.
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');

  // Enforce a reasonable server-side size limit (500 MB) to avoid OOM.
  const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
  if (fileEntry.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File exceeds the 500 MB server limit' }, { status: 413 });
  }

  const buffer = Buffer.from(await fileEntry.arrayBuffer());

  // Save to a UUID-keyed temp directory so the LLM can reference the path later
  const tempDir = join(tmpdir(), `locopilot-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, safeFilename);
  await writeFile(tempPath, buffer);

  const isPdf = fileEntry.type === 'application/pdf'
    || safeFilename.toLowerCase().endsWith('.pdf');

  if (isPdf) {
    return handlePdf(buffer, tempPath);
  }

  // Large text file: return first MAX_INLINE_CHARS chars
  const text = buffer.toString('utf8');
  const truncated = text.length > MAX_INLINE_CHARS;
  return NextResponse.json({
    text: truncated ? text.slice(0, MAX_INLINE_CHARS) : text,
    totalChars: text.length,
    tempPath,
    truncated,
  });
}

async function handlePdf(buffer: Buffer, tempPath: string): Promise<NextResponse> {
  let parser: InstanceType<typeof PDFParse> | undefined;
  let totalPages: number;

  try {
    parser = new PDFParse({ data: buffer });
    const info = await parser.getInfo();
    totalPages = typeof info?.total === 'number' && Number.isFinite(info.total) ? info.total : 0;
  } catch (err) {
    if (parser) {
      try { await parser.destroy(); } catch { /* ignore */ }
    }
    return NextResponse.json(
      { error: `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 },
    );
  }

  const endPage = Math.min(totalPages, MAX_PDF_PAGES);
  const truncated = totalPages > MAX_PDF_PAGES;

  let text = '';
  try {
    const textResult = await parser.getText({ partial: range(1, endPage) });
    const rawText = typeof textResult.text === 'string' ? textResult.text : '';

    // If per-page data is available, format with page markers (mirrors readPdfTool)
    if (textResult.pages && Array.isArray(textResult.pages) && textResult.pages.length > 0) {
      const lines: string[] = [];
      for (const page of textResult.pages as Array<{ num?: number; pageIndex?: number; text: string }>) {
        const pageNum = page.num ?? (page.pageIndex !== undefined ? page.pageIndex + 1 : '?');
        lines.push(`=== Page ${pageNum} ===`);
        lines.push(page.text ?? '');
      }
      text = lines.join('\n');
    } else {
      text = rawText;
    }
  } catch (err) {
    try { await parser.destroy(); } catch { /* ignore */ }
    return NextResponse.json(
      { error: `Failed to extract PDF text: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 },
    );
  }

  try { await parser.destroy(); } catch { /* ignore */ }

  return NextResponse.json({ text, pageCount: totalPages, tempPath, truncated });
}

function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i++) result.push(i);
  return result;
}
