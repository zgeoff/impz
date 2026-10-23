export interface GrowRequest {
  readonly id: string;
  readonly name: string;

  // The plug plus the host kernel's struct pages for it.
  readonly mib: number;
}
