export interface TerminalSource {
  readonly label: string;
  readonly open: (size: TerminalSize, signal: AbortSignal) => Promise<TerminalConnection>;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalConnection {
  readonly output: ReadableStream<Uint8Array>;
  readonly write: (data: string) => Promise<void>;
  readonly resize: (size: TerminalSize) => void;
  readonly close: () => void;
  readonly ended: Promise<TerminalEnd>;
}

export type TerminalEnd =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'error'; readonly message: string };
