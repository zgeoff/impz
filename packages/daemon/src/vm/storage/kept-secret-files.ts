export interface KeptSecretFiles {
  readonly listKept: () => KeptSecretDirectory[];
  readonly removeKept: (name: string) => void;
}

interface KeptSecretDirectory {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;

  readonly createdAt: Date | null;
  readonly files: readonly string[];
}
