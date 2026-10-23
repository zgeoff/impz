export interface ResourceDelta {
  readonly intervalMs: number;
  readonly cpuPercent: number;
  readonly cpuUsec: number;
  readonly throttledUsec: number;
  readonly netRxBytes: number;
  readonly netTxBytes: number;
}
