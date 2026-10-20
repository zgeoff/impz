// what the deny-list check reads, and whether it was missing at the last one
export interface DenyListCheck {
  readonly hasPublic: boolean;
  readonly hostAddresses: readonly string[];
  readonly wasMissing: boolean;
  readonly log: (message: string) => void;
}

// The Docker host's own networks, missing for a public imp: logged once
// each time one appears with IMP_HOST_ADDRESSES empty, whatever
// IMP_EGRESS_DENY holds (it always holds IMP_PUBLIC_IP). True while missing.
export function isDenyListed(check: DenyListCheck): boolean {
  const isMissing = check.hasPublic && check.hostAddresses.length === 0;

  if (isMissing && !check.wasMissing) {
    check.log(
      "impd: egress: WARNING: a public imp exists and IMP_HOST_ADDRESSES is empty, so only IMP_EGRESS_DENY keeps it from the Docker host's own addresses and networks; the systemd unit and the NixOS module fill it at each start, compose does not (docs/architecture/network/egress.md#public)",
    );
  }

  return isMissing;
}
