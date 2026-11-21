import { createStubBin } from '@zgeoff/testing/bin';
import type { StubBin } from '@zgeoff/testing/bin';

export interface ZfsStubOptions {
  readonly create?: 'fails';
}

export function createStubZfs(stubs: string, options: Readonly<ZfsStubOptions> = {}): StubBin {
  const onCreate = options.create === 'fails' ? 'echo "cannot create dataset" >&2; exit 1' : ':';

  return createStubBin(stubs, 'zfs', {
    script: `#!/bin/bash\ncase "$1" in
  version) printf 'zfs-2.3.4-1\\nzfs-kmod-2.3.4-1\\n' ;;
  create) ${onCreate} ;;
esac`,
  });
}
