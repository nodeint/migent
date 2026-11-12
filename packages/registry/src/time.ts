import { MS_PER_SECOND } from '@nodeint/migent-kernel';

import { NS_PER_SECOND } from './constants.js';
export function monotonic(): number {
  return Number(process.hrtime.bigint()) / NS_PER_SECOND;
}

export function sleep(seconds: number): Promise<void> {
  const ms = Math.max(0, seconds * MS_PER_SECOND);
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
