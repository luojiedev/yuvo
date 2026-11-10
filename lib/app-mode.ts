/** Public builds use the normal account and sync flow unless explicitly built as a demo. */
export const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
