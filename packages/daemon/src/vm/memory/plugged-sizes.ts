export interface PluggedSizes {
  readonly read: (impId: string) => number | undefined;
  readonly write: (impId: string, mib: number | null) => void;
}

export function createPluggedSizes(): PluggedSizes {
  const sizes = new Map<string, number>();

  return {
    read: (impId) => sizes.get(impId),
    write: (impId, mib) => {
      if (mib === null) {
        sizes.delete(impId);
      } else {
        sizes.set(impId, mib);
      }
    },
  };
}
