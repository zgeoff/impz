export interface DiskRoom {
  readonly withRoom: <T>(bytes: number, task: () => Promise<T>) => Promise<T>;
}
