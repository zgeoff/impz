export function createLogouts() {
  let controller = new AbortController();

  return {
    readSignal: (): AbortSignal => controller.signal,
    logOut: (): void => {
      controller.abort();

      controller = new AbortController();
    },
  };
}
