import { invoke } from "@tauri-apps/api/core";
import type { ResponseData } from "./types";

let network: Record<string, unknown> = {};

/** Settings > Network, merged into every outgoing request (including OAuth token calls and spec downloads). */
export const setNetwork = (n: Record<string, unknown>) => {
  network = n;
};

export const sendRaw = (spec: Record<string, unknown>) =>
  invoke<ResponseData>("send_request", { spec: { ...spec, network: { ...network, ...(spec.network as object | undefined) } } });

export const currentNetwork = () => network;
