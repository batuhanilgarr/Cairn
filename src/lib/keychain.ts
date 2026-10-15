import { invoke } from "@tauri-apps/api/core";

/**
 * Secret values can live in the macOS Keychain instead of the git-ignored `.cairn/secrets.yaml`.
 * In the file, a secret kept in the Keychain is written as the marker `keychain:`; the value sits under the
 * service "Cairn" and an account that names the collection folder, the environment file and the variable.
 */
export const KEYCHAIN_MARKER = "keychain:";
export type SecretStore = "file" | "keychain";

/** Where new and changed secret values go. Set from Settings; the CLI never writes secrets. */
export const secretStore: { current: SecretStore } = { current: "file" };

/** The app sets this to hear about Keychain trouble (a value that couldn't be saved is kept in the file instead). */
export const keychainEvents: { onError: ((message: string) => void) | null } = { onError: null };

export const secretAccount = (root: string, envFile: string, key: string) => `${root}|${envFile.split("/").pop()}|${key}`;

export const keychainAvailable = () => invoke<boolean>("secret_available").catch(() => false);
export const keychainGet = (account: string) => invoke<string | null>("secret_get", { account });
export const keychainSet = (account: string, value: string) => invoke<void>("secret_set", { account, value });
export const keychainDelete = (account: string) => invoke<void>("secret_delete", { account });
