export function readInBackground<T>(source: Readonly<AsyncIterable<T>>) {
  const items: T[] = [];

  const read = async (): Promise<unknown> => {
    try {
      for await (const item of source) {
        items.push(item);
      }

      return null;
    } catch (error) {
      return error;
    }
  };

  return { items, ended: read() };
}
