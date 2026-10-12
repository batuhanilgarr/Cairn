// The CLI never shows dialogs.
export const open = async (_opts?: unknown): Promise<string | null> => null;
export const save = async (_opts?: unknown): Promise<string | null> => null;
