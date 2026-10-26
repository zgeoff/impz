import * as z from 'zod';

export const DistroSchema = z.enum(['debian', 'ubuntu24', 'ubuntu26']);

export type Distro = z.infer<typeof DistroSchema>;

interface DistroImage {
  readonly base: string;
  readonly extra: string;
}

// Vultr's Ubuntu images ship ufw enabled; the test does the same.
export const DISTROS: Readonly<Record<Distro, DistroImage>> = {
  debian: { base: 'debian:trixie', extra: '' },
  ubuntu24: { base: 'ubuntu:24.04', extra: 'ufw' },
  ubuntu26: { base: 'ubuntu:26.04', extra: 'ufw' },
};
