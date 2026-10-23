import type { AgentExecRequest, ExecStream } from '../../src/vm/agent-client/exec-stream';
import { startTestImpd } from '../start-test-impd';
import type { TestImpdOptions } from '../start-test-impd';
import { createBuilderImage } from './create-builder-image';

interface StubBuilderGuest {
  readonly guest: { readonly open: (request: AgentExecRequest) => Promise<ExecStream> };
}

export async function startBuilderImpd(
  stack: Readonly<AsyncDisposableStack>,
  builder: StubBuilderGuest,
  options: TestImpdOptions = {},
) {
  const harness = await startTestImpd(stack, {
    ...options,
    boundaries: {
      ...options.boundaries,
      agent: {
        ...options.boundaries?.agent,
        openBuilderExec: (_name, request) => builder.guest.open(request),
      },
    },
  });

  await createBuilderImage({
    db: harness.db,
    dataDir: harness.dataDir,
    ref: harness.config.build.image,
  });

  return harness;
}
