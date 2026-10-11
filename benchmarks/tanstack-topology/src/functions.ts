import { createServerFn } from '@tanstack/react-start';
export const alpha = createServerFn({ method: 'GET' }).handler(
  async () => 'alpha-public',
);
export const beta = createServerFn({ method: 'GET' }).handler(
  async () => 'beta-public',
);
export const gamma = createServerFn({ method: 'GET' }).handler(
  async () => 'gamma-public',
);
