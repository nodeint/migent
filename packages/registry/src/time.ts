export function monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

export function sleep(seconds: number): Promise<void> {
  const ms = Math.max(0, seconds * 1000);
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
