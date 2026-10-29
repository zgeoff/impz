export interface AdmissionRequest {
  readonly id: string;
  readonly name: string | null;
  readonly reserveMib: number;
  readonly memoryMib: number;

  // the memory a guest on 2 MiB pages may take from the host's hugetlb pool
  readonly hugePagesMib?: number;
  readonly maySleepImps?: boolean;
}

export interface RamAdmission {
  readonly admit: (request: AdmissionRequest) => Promise<void>;
  readonly release: (id: string) => void;
}
