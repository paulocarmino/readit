import { genericAdapter } from './generic/index.js';
import { redditAdapter } from './reddit/index.js';
import { AdapterRegistry } from './registry.js';

/**
 * All adapters. To support a new site: create `src/adapters/<site>/index.ts` with
 * `defineAdapter({...})` and add it to this list. Order = priority; generic is the fallback.
 */
export const registry = new AdapterRegistry([redditAdapter], genericAdapter);
