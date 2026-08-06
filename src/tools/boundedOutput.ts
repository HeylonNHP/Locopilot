import { StringDecoder } from 'node:string_decoder';

import { RUN_COMMAND_OUTPUT_MAX_BYTES } from '@/constants';

const TAIL_RESERVE_BYTES = 4 * 1024;

/**
 * Bounds captured command output while still draining the child process. A
 * small tail is retained so trailing errors and the cwd probe remain visible.
 */
export class BoundedOutput {
  private readonly decoder = new StringDecoder('utf8');
  private readonly head: string[] = [];
  private readonly tail: string[] = [];
  private readonly headLimit = Math.max(1, RUN_COMMAND_OUTPUT_MAX_BYTES - TAIL_RESERVE_BYTES);
  private headBytes = 0;
  private tailBytes = 0;
  private finished = false;
  truncated = false;

  append(chunk: Buffer): void {
    if (this.finished) return;
    this.retain(this.decoder.write(chunk));
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.retain(this.decoder.end());
  }

  text(): string {
    return this.head.join('') + this.tail.join('');
  }

  replaceText(text: string): void {
    this.head.length = 0;
    this.tail.length = 0;
    this.head.push(text);
    this.headBytes = Buffer.byteLength(text, 'utf8');
    this.tailBytes = 0;
  }

  private retain(decoded: string): void {
    for (const character of decoded) {
      const characterBytes = Buffer.byteLength(character, 'utf8');
      if (!this.truncated && this.headBytes + characterBytes <= this.headLimit) {
        this.head.push(character);
        this.headBytes += characterBytes;
        continue;
      }

      // Keep only a bounded suffix after the head fills. This preserves the
      // shell's trailing cwd marker and the most recent error diagnostics.
      this.truncated = true;
      this.tail.push(character);
      this.tailBytes += characterBytes;
      while (this.tailBytes > TAIL_RESERVE_BYTES && this.tail.length > 0) {
        const removed = this.tail.shift() as string;
        this.tailBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }
  }
}
