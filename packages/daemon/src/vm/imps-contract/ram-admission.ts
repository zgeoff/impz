export interface AdmissionRequest {
  readonly id: string;
  readonly name: string | null;
  readonly reserveMib: number;
  readonly memoryMib: number;
  readonly maySleepImps?: boolean;
}

export interface RamAdmission {
  readonly admit: (request: AdmissionRequest) => Promise<void>;
  readonly release: (id: string) => void;
}
