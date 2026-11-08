import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { SetupServerApi } from 'msw/node';
import { githubActionsHandlers } from './github-actions-api';

// Only fetch is intercepted: node:http clients such as acme-client talk to
// loopback servers the suites start, and no suite mocks one.
// oxlint-disable-next-line no-deprecated -- setupServer takes no interceptor list; its successor is experimental
export const server = new SetupServerApi([...githubActionsHandlers], [new FetchInterceptor()]);
