import type { NftRunner } from '../../src/network/egress/egress-firewall';

interface NftRun {
  readonly script: string;
  readonly accepted: boolean;
}

interface Refusal {
  readonly reason: string;
  readonly match: (script: string) => boolean;
  left: number;
}

interface Hold {
  readonly match: (script: string) => boolean;
  readonly reached: PromiseWithResolvers<string>;
  readonly released: PromiseWithResolvers<void>;
}

interface RefuseOptions {
  readonly reason: string;
  readonly match?: (script: string) => boolean;
  readonly times?: number;
}

// `nft -f` applies a script as one transaction, so a refused script changes
// nothing.
export function buildStubNft() {
  const scripts: string[] = [];
  const runs: NftRun[] = [];
  const refusals: Refusal[] = [];
  const holds: Hold[] = [];

  const runNft: NftRunner = async (script) => {
    const hold = holds.find((each) => each.match(script));

    if (hold !== undefined) {
      holds.splice(holds.indexOf(hold), 1);
      hold.reached.resolve(script);

      await hold.released.promise;
    }

    const refusal = refusals.find((each) => each.left > 0 && each.match(script));

    if (refusal !== undefined) {
      refusal.left -= 1;

      runs.push({ script, accepted: false });
      throw new Error(`nft exited 1: ${refusal.reason}`);
    }

    runs.push({ script, accepted: true });
    scripts.push(script);
  };

  return {
    runNft,
    scripts: scripts as readonly string[],
    runs: runs as readonly NftRun[],
    readTable: (): string | null =>
      scripts.findLast((script) => script.startsWith('table inet imp_egress {}\n')) ?? null,

    refuse: (options: Readonly<RefuseOptions>): void => {
      refusals.push({
        reason: options.reason,
        match: options.match ?? (() => true),
        left: options.times ?? Number.POSITIVE_INFINITY,
      });
    },

    accept: (): void => {
      refusals.length = 0;
    },

    hold: (match: (script: string) => boolean) => {
      const hold: Hold = {
        match,
        reached: Promise.withResolvers<string>(),
        released: Promise.withResolvers<void>(),
      };

      holds.push(hold);

      return {
        reached: hold.reached.promise,
        release: (): void => {
          hold.released.resolve();
        },
      };
    },
  };
}
