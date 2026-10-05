import { ConfigurationError } from "@migent/kernel";
import {
  ServiceError,
  ensureRegistryHome,
  registryHomePath,
  serveForeground,
  serviceStatus,
  startDetached,
  stop,
} from "@migent/registry";
import { printError } from "../display.js";

const DEFAULT_PORT = 47321;

export const serviceApi = {
  serveForeground,
  serviceStatus,
  startDetached,
  stop,
};

export async function runServiceStart(port: number | null, foreground: boolean): Promise<number> {
  const home = ensureRegistryHome();
  const chosen = port ?? DEFAULT_PORT;
  try {
    if (foreground) {
      await serviceApi.serveForeground(home, chosen);
      return 0;
    }
    const endpoint = await serviceApi.startDetached(home, chosen);
    process.stdout.write(`${endpoint.host}:${endpoint.port}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ServiceError) {
      printError(error.message);
      return 1;
    }
    throw error;
  }
}

export async function runServiceStop(): Promise<number> {
  const result = await serviceApi.stop(ensureRegistryHome());
  if (result.outcome === "error") {
    printError(result.message || "Registry service did not stop.");
    return 1;
  }
  return 0;
}

export async function runServiceStatus(asJson: boolean): Promise<number> {
  const report = await serviceApi.serviceStatus(registryHomePath());
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (report.state === "running") {
    process.stdout.write("running\n");
    process.stdout.write(`${String(report.host)}:${String(report.port)} pid=${String(report.pid)}\n`);
  } else {
    process.stdout.write("stopped\n");
  }
  return 0;
}

export function parsePort(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new ConfigurationError("--port must be an integer.");
  const port = Number(raw);
  if (port > 65535) throw new ConfigurationError("--port must be an integer.");
  return port;
}
