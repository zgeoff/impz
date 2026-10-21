import { sessionCollection } from '../mocks/db/session-collection';
import { readTokenId, tokenCollection } from '../mocks/db/token-collection';

type TokenRow = Awaited<ReturnType<typeof tokenCollection.create>>;

interface DashboardSessionInput {
  readonly token?: TokenRow;
}

export async function createDashboardSession(input: Readonly<DashboardSessionInput> = {}) {
  const token = await readToken(input.token);
  const session = await sessionCollection.create({ tokenId: readTokenId(token.secret) });

  return { token, session };
}

async function readToken(token: TokenRow | undefined): Promise<TokenRow> {
  if (token !== undefined) {
    return token;
  }

  const created = await tokenCollection.create({});

  return created;
}
