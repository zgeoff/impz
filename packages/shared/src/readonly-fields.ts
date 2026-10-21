export type ReadonlyFields<T> = { readonly [Key in keyof T]: ToReadonly<T[Key]> };

type ToReadonly<T> = T extends readonly (infer Item)[]
  ? readonly Item[]
  : T extends object
    ? Readonly<T>
    : T;
