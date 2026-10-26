export function registerRemoval(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  keep: boolean,
  remove: () => Promise<void>,
): void {
  if (!keep) {
    stack.defer(remove);
  }
}
