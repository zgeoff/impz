import type { Distro } from './distros';
import type { BootstrapArgs } from './parse-bootstrap-args';

type BootstrapLeg =
  | { readonly kind: 'distro'; readonly distro: Distro }
  | { readonly kind: 'device' }
  | { readonly kind: 'zfs' };

export function buildBootstrapPlan(args: BootstrapArgs): readonly BootstrapLeg[] {
  const legs = args.distros.flatMap((distro): BootstrapLeg[] =>
    distro === 'debian'
      ? [{ kind: 'distro', distro }, { kind: 'device' }]
      : [{ kind: 'distro', distro }],
  );

  return args.zfs ? [...legs, { kind: 'zfs' }] : legs;
}
