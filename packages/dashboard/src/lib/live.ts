// impd's event stream refreshes views on each change; this clock catches what
// moves with no event, such as RAM in use, sessions and last activity
export const LIVE = { refetchInterval: 10_000 } as const;
export const SLOW = { refetchInterval: 10_000 } as const;
