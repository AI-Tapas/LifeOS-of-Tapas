import { existsSync } from 'node:fs';
const real = new Set(['@/lib/cron/runs', '@/lib/cron/guard', '@/lib/datetime']);
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    if (!real.has(specifier)) return {url: new URL('./cron-brief-stubs.ts', import.meta.url).href, shortCircuit:true};
    const url = new URL('../'+specifier.slice(2)+'.ts', import.meta.url);
    if (existsSync(url)) return { url: url.href, shortCircuit: true };
  }
  return next(specifier,context);
}
