import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());

export async function readRpcInput(request: Readonly<Request>): Promise<unknown> {
  const body: unknown = await request.clone().json();

  return serializer.deserialize(body);
}
