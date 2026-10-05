import { KERNEL_PLACEHOLDER } from "@migent/kernel";
import { migentHomePath, ensureRegistryHome, registryHomePath } from "./home.js";
import {
  ServiceEndpoint,
  ServiceError,
  StopResult,
  callService,
  endpointFromHome,
  serveForeground,
  serviceStatus,
  startDetached,
  stop,
} from "./service.js";

export const REGISTRY_PLACEHOLDER = `registry:${KERNEL_PLACEHOLDER}`;

export {
  ServiceEndpoint,
  ServiceError,
  StopResult,
  migentHomePath,
  callService,
  endpointFromHome,
  ensureRegistryHome,
  registryHomePath,
  serveForeground,
  serviceStatus,
  startDetached,
  stop,
};
