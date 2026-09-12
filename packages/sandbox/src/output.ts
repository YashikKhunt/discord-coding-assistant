/**
 * Keeps the first and last `maxBytes / 2` of a stream. Test and install logs put
 * the useful parts (the command, the failure summary) at the very start and end.
 */
export class HeadTailBuffer {
  readonly #half: number;
  #head = "";
  #tail = "";
  #dropped = 0;

  constructor(maxBytes: number) {
    this.#half = Math.floor(maxBytes / 2);
  }

  push(chunk: string): void {
    if (this.#head.length < this.#half) {
      const room = this.#half - this.#head.length;
      this.#head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.#tail += chunk;
    if (this.#tail.length > this.#half) {
      const excess = this.#tail.length - this.#half;
      this.#dropped += excess;
      this.#tail = this.#tail.slice(excess);
    }
  }

  toString(): string {
    if (this.#dropped === 0) return this.#head + this.#tail;
    return `${this.#head}\n… [${this.#dropped} bytes truncated] …\n${this.#tail}`;
  }
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars + 1)}`;
}
