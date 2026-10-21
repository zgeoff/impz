export function buildStubRoomCheck(options: Readonly<{ passes: number; error: Error }>) {
  const asked: number[] = [];

  const requireRoom = (bytes: number): Promise<void> => {
    asked.push(bytes);

    return asked.length > options.passes ? Promise.reject(options.error) : Promise.resolve();
  };

  return { requireRoom, asked };
}
