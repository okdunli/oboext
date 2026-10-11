// A compiler error shaped for its reader - who is as often an AI agent as a human.

export interface RoseErrorInfo {
  code: string;
  file?: string;
  line?: number;
  message: string;
  hint?: string;
}

export class RoseError extends Error {
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
  readonly hint?: string;

  constructor(code: string, message: string, opts: { file?: string; line?: number; hint?: string } = {}) {
    super(message);
    this.name = 'RoseError';
    this.code = code;
    this.file = opts.file;
    this.line = opts.line;
    this.hint = opts.hint;
  }

  info(): RoseErrorInfo {
    const info = { code: this.code } as RoseErrorInfo;
    if (this.file !== undefined) info.file = this.file;
    if (this.line !== undefined) info.line = this.line;
    info.message = this.message;
    if (this.hint !== undefined) info.hint = this.hint;
    return info;
  }
}

/** The 1-based line of `index` inside `src`. */
export function lineOf(src: string, index: number): number {
  let line = 1;
  const end = Math.min(index, src.length);
  for (let i = 0; i < end; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

// The line of a regex match inside `src` - undefined when there is no match (the position is optional on a match array).
export function lineAt(src: string, match?: RegExpMatchArray | null): number | undefined {
  return match && match.index !== undefined ? lineOf(src, match.index) : undefined;
}

/** Shape any thrown value into the info object the --json envelope prints. */
export function errorInfo(err: unknown): RoseErrorInfo {
  if (err instanceof RoseError) return err.info();
  return { code: 'E-UNKNOWN', message: err instanceof Error ? err.message : String(err) };
}
