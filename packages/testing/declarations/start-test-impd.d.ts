// the declaration build reads this in place of stand-in/start-test-impd.ts, whose own types no
// declaration file can spell; it shows what src/start-test-impd.ts reads
export interface StandInImpd {
  readonly url: string;
  readonly dataDir: string;
  readonly fake: { readonly agent: { version: string } };
  readonly tickers: { readonly fire: (label: string) => Promise<void> };
  readonly createTestImage: (name: string) => Promise<unknown>;
}

export interface StandInOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly onLog?: (message: string) => void;
}

export function startTestImpd(
  stack: AsyncDisposableStack,
  options?: StandInOptions,
): Promise<StandInImpd>;
