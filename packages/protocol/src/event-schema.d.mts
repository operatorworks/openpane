// The pinned validator's Zod declarations require web globals. The ES-only public
// adapter validates opaque events without importing those globals into SDK clients.
export const EventSchema: {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: Error };
};
