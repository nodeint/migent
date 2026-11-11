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
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_CREATED,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  MAX_PORT,
} from './constants.js';
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
