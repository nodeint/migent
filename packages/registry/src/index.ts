import { KERNEL_PLACEHOLDER } from '@nodeint/migent-kernel';

import { ensureRegistryHome, migentHomePath, registryHomePath } from './home.js';
import {
  callService,
  endpointFromHome,
  serveForeground,
  ServiceEndpoint,
  ServiceError,
  serviceStatus,
  startDetached,
  stop,
  StopResult,
} from './service.js';

export const REGISTRY_PLACEHOLDER = `registry:${KERNEL_PLACEHOLDER}`;

export {
  callService,
  endpointFromHome,
  ensureRegistryHome,
  migentHomePath,
  registryHomePath,
  serveForeground,
  ServiceEndpoint,
  ServiceError,
  serviceStatus,
  startDetached,
  stop,
  StopResult,
};
