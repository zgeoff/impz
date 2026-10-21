import type { EgressMode } from './egress-schema';

export interface EgressModeTraits {
  readonly isOpen: boolean;

  readonly needsRuleset: boolean;

  readonly isPublic: boolean;

  readonly hasAllowList: boolean;
}

export const EGRESS_MODE_TRAITS: Readonly<Record<EgressMode, EgressModeTraits>> = {
  open: { isOpen: true, needsRuleset: false, isPublic: false, hasAllowList: false },
  public: { isOpen: false, needsRuleset: true, isPublic: true, hasAllowList: false },
  box: { isOpen: false, needsRuleset: true, isPublic: false, hasAllowList: true },
  none: { isOpen: false, needsRuleset: true, isPublic: false, hasAllowList: false },
};
