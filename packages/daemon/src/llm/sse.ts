/** One Server-Sent Events message (`event:` defaults to "message"). */
export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 * Feed decoded text in arbitrary chunks; complete messages come out. Handles LF, CRLF and
 * CR line endings (including a CRLF split across chunks), multi-line `data:`, comments and
 * a missing trailing blank line (`flush`).
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private event = '';

  push(text: string): SseMessage[] {
    this.buf += text;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = start; i < this.buf.length; i++) {
      const c = this.buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      // A trailing CR may be the first half of a CRLF that continues in the next chunk.
      if (c === 13 && i === this.buf.length - 1) break;
      this.line(this.buf.slice(start, i), out);
      if (c === 13 && this.buf.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** End of stream: dispatch whatever is pending. */
  flush(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buf.length > 0) {
      const rest = this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf;
      this.buf = '';
      this.line(rest, out);
    }
    this.line('', out);
    return out;
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === '') {
      if (this.data.length > 0) {
        out.push({ event: this.event || 'message', data: this.data.join('\n') });
      }
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    // `id` and `retry` are irrelevant for one-shot completions.
  }
}
