// Entry point for the vendored browser bundle. Re-exports only what the
// console actually uses, so esbuild can drop the rest.
export { default } from '@anthropic-ai/sdk';
