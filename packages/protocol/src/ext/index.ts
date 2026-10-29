/**
 * Per-track protocol extensions (spec 20261029 §2.1). Each file owns its domain schemas,
 * methods and events; `api.ts` and `events.ts` spread them in.
 */
export * from './attention';
export * from './cost';
export * from './home';
export * from './outputs';
export * from './schedule';
export * from './spawn';
export * from './supervisor';
