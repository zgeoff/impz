import { HttpResponse, http } from 'msw';

export interface StubTokenAnswer {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly expires_in?: number;
}

interface StubTokenRequest {
  readonly contentType: string | null;
  readonly accept: string | null;
  readonly body: string;
  readonly refreshToken: string | null;
}

export function createStubBrokerTokenEndpoint(tokenUrl: string) {
  const answers = new Map<string, StubTokenAnswer[]>();

  const requests: StubTokenRequest[] = [];

  const handler = http.post(tokenUrl, async (info) => {
    const request = info.request;
    const contentType = request.headers.get('content-type');

    const body = await request.text();

    const refreshToken =
      contentType === 'application/json'
        ? readJsonRefreshToken(body)
        : new URLSearchParams(body).get('refresh_token');

    requests.push({ contentType, accept: request.headers.get('accept'), body, refreshToken });

    const answer = answers.get(refreshToken ?? '')?.shift();

    if (answer === undefined) {
      return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    }

    return HttpResponse.json(answer);
  });

  return {
    handler,
    requests,
    issue: (refreshToken: string, answer: StubTokenAnswer): void => {
      answers.set(refreshToken, [...(answers.get(refreshToken) ?? []), answer]);
    },
  };
}

function readJsonRefreshToken(body: string): string | null {
  const parsed: unknown = JSON.parse(body);

  if (typeof parsed === 'object' && parsed !== null && 'refresh_token' in parsed) {
    return typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null;
  }

  return null;
}
