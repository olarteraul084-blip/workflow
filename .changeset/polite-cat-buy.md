---
"@workflow/builders": minor
"@workflow/nitro": patch
---

`@workflow/builders`: allow passing extra esbuild options merged into every bundle the builder produces (steps, intermediate workflow, final workflow wrapper, and webhook) via a new `esbuildOptions` config field.

`@workflow/nitro`: pass `sourcesContent: false` to the underlying builder so sources aren't duplicated — nitro re-bundles these outputs and inlines sourcemaps via `workflowSourcemapLoaderPlugin`.
