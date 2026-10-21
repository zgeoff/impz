export const IMPD_USER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 } as const;
