import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { STEP_QUEUE_TRIGGER, WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import type { Nitro, NitroModule, RollupConfig } from 'nitro/types';
import { join } from 'pathe';
import { LocalBuilder, VercelBuilder } from './builders.js';
import type { ModuleOptions } from './types';

export type { ModuleOptions };

/**
 * Detect whether the Nitro instance is v2.
 * Newer Nitro releases (both v2 and v3) expose `nitro.meta.majorVersion`.
 * Fall back to checking `nitro.routing` (only present in v3+) for older
 * Nitro v2 versions that don't have `majorVersion` yet (e.g. Nuxt users
 * on an older nitropack).
 */
function isNitroV2(nitro: Nitro): boolean {
  const majorVersion = (nitro as any).meta?.majorVersion;
  if (majorVersion != null) {
    return majorVersion === 2;
  }
  return !nitro.routing;
}

/**
 * Rollup plugin that surfaces the inline source maps embedded in the
 * pre-built workflow bundles (steps.mjs, workflows.mjs) to rollup's load
 * pipeline. Rollup does not consume `//# sourceMappingURL=data:...` comments
 * from input files by default, so without this the final Nitro output map
 * only references nitro wrappers + node_modules and error stack traces point
 * at the bundled output rather than the original user `.ts` sources.
 */
function workflowSourcemapLoaderPlugin(workflowBuildDir: string) {
  const INLINE_MAP_RE =
    /\/\/# sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)\s*$/;
  return {
    name: 'workflow:sourcemap-loader',
    load: {
      filter: {
        id: `${workflowBuildDir}/*.mjs`,
      },
      handler(id: string) {
        if (!id.startsWith(workflowBuildDir) || !id.endsWith('.mjs'))
          return null;
        const code = readFileSync(id, 'utf8');
        const match = code.match(INLINE_MAP_RE);
        if (!match) return code;
        try {
          const map = JSON.parse(
            Buffer.from(match[1], 'base64').toString('utf8')
          );
          return { code: code.slice(0, match.index), map };
        } catch {
          return code;
        }
      },
    },
  };
}

export default {
  name: 'workflow/nitro',
  async setup(nitro: Nitro) {
    const isVercelDeploy =
      !nitro.options.dev && nitro.options.preset === 'vercel';

    // Pre-built workflow bundles directory - must be excluded from re-transformation
    const workflowBuildDir = join(nitro.options.buildDir, 'workflow');

    // Add transform plugin at the BEGINNING to run before other transforms
    // (especially before class property transforms that rename classes like _ClassName)
    nitro.hooks.hook('rollup:before', (_nitro: Nitro, config: RollupConfig) => {
      (config.plugins as Array<unknown>).unshift(
        workflowTransformPlugin({
          // Exclude pre-built workflow bundles from re-transformation
          // These are already processed and re-processing causes issues like
          // undefined class references when Nitro's bundler renames variables
          exclude: [workflowBuildDir],
        }),
        workflowSourcemapLoaderPlugin(workflowBuildDir)
      );
    });

    // NOTE: Temporary workaround for debug unenv mock
    if (!nitro.options.workflow?._vite) {
      nitro.options.alias['debug'] ??= 'debug';
    }

    if (nitro.options.dev) {
      const workflowBuildGlob = `${join(nitro.options.buildDir, 'workflow')}/**`;
      nitro.options.watchOptions ||= {};
      const existingIgnored = nitro.options.watchOptions.ignored;
      if (!existingIgnored) {
        nitro.options.watchOptions.ignored = [workflowBuildGlob];
      } else if (Array.isArray(existingIgnored)) {
        nitro.options.watchOptions.ignored = [
          ...existingIgnored,
          workflowBuildGlob,
        ];
      } else {
        nitro.options.watchOptions.ignored = [
          existingIgnored,
          workflowBuildGlob,
        ];
      }
    }

    // In dev mode, force workflow SDK packages to be bundled into
    // Nitro's server rather than externalized. This ensures the SWC
    // transform plugin (registered above in `rollup:before`) processes
    // files containing workflow patterns — notably
    // `@workflow/core/dist/runtime/run.js` — and emits the classId
    // registration IIFEs needed for serde serialization. Without this,
    // the plain tsc-compiled `Run` class gets loaded via a `file://`
    // external import, has no `classId` property, and serialization
    // fails with "must have a static classId property" when a step
    // returns a `Run` instance.
    //
    // We route this through Nitro's own `noExternals` config rather
    // than a Rollup `resolveId` hook because Nitro's externalization
    // pipeline runs downstream of rollup plugin hooks — any
    // `external: false` returned from a plugin gets silently overridden
    // to a `file://` URL import in the emitted dev bundle.
    if (nitro.options.dev) {
      const additions: (string | RegExp)[] = ['workflow', /^@workflow\//];
      const existing = nitro.options.noExternals;
      if (existing === true) {
        // already bundling everything — nothing to do
      } else if (Array.isArray(existing)) {
        existing.push(...additions);
      } else {
        // covers undefined, null, and `false` (which would otherwise prevent
        // bundling of workflow packages and break dev mode)
        nitro.options.noExternals = additions;
      }
    }

    // Add tsConfig plugin
    if (nitro.options.workflow?.typescriptPlugin) {
      nitro.options.typescript.tsConfig ||= {};
      nitro.options.typescript.tsConfig.compilerOptions ||= {};
      nitro.options.typescript.tsConfig.compilerOptions.plugins ||= [];
      nitro.options.typescript.tsConfig.compilerOptions.plugins.push({
        name: 'workflow',
      });
    }

    // Nitro v2 Vercel deploy: use legacy VercelBuilder approach
    if (isVercelDeploy && isNitroV2(nitro)) {
      nitro.hooks.hook('compiled', async () => {
        await new VercelBuilder(nitro).build();
      });
      return;
    }

    // Nitro v3+ Vercel deploy: configure function rules for workflow routes (queue triggers, maxDuration).
    if (isVercelDeploy) {
      // Enable sourcemaps so rollup chains inline sourcemaps from step bundles
      // through to the output, preserving original file names in error stacks.
      // `??=` so an explicit user opt-out (`sourcemap: false` in nuxt/nitro
      // config) wins — they'll just lose remapped stack traces.
      nitro.options.sourcemap ??= true;

      nitro.options.vercel ??= {};
      nitro.options.vercel.functionRules ??= {};

      const runtime = nitro.options.workflow?.runtime;
      const rules = nitro.options.vercel.functionRules;

      // Merge with any user-defined rules at the same paths so explicit
      // user config (e.g. memory) is preserved while we own the queue
      // trigger / maxDuration fields.
      const stepPath = '/.well-known/workflow/v1/step';
      rules[stepPath] = {
        ...rules[stepPath],
        ...(runtime && { runtime }),
        maxDuration: 'max',
        experimentalTriggers: [STEP_QUEUE_TRIGGER],
      };

      const flowPath = '/.well-known/workflow/v1/flow';
      rules[flowPath] = {
        ...rules[flowPath],
        ...(runtime && { runtime }),
        maxDuration: 'max',
        experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
      };

      if (runtime) {
        const webhookPath = '/.well-known/workflow/v1/webhook/**';
        rules[webhookPath] = { ...rules[webhookPath], runtime };
      }
    }

    // Generate workflow bundles (used by virtual handlers below)
    const builder = new LocalBuilder(nitro);
    let isInitialBuild = true;

    nitro.hooks.hook('build:before', async () => {
      await builder.build();

      // For prod: write the manifest handler file with inlined content
      // now that the builder has generated the manifest. Rollup will
      // bundle this file into the compiled output.
      if (!nitro.options.dev && process.env.WORKFLOW_PUBLIC_MANIFEST === '1') {
        writeManifestHandler(nitro);
      }
    });

    // Allows for HMR - but skip the first dev:reload since build:before already ran
    if (nitro.options.dev) {
      nitro.hooks.hook('dev:reload', async () => {
        if (isInitialBuild) {
          isInitialBuild = false;
          return;
        }
        try {
          await builder.build();
        } catch (error) {
          // During dev, files may be added/removed while the builder
          // is rebuilding (e.g., during test cleanup). Log the error
          // but don't crash — the next file change will trigger
          // another rebuild with the correct file list.
          console.warn('Warning: Workflow rebuild failed:', error);
        }
      });
    }

    // Register workflow routes as handlers
    addVirtualHandler(
      nitro,
      '/.well-known/workflow/v1/webhook/:token',
      'workflow/webhook.mjs'
    );

    addVirtualHandler(
      nitro,
      '/.well-known/workflow/v1/step',
      'workflow/steps.mjs'
    );

    addVirtualHandler(
      nitro,
      '/.well-known/workflow/v1/flow',
      'workflow/workflows.mjs'
    );

    // Expose manifest as a public HTTP route when WORKFLOW_PUBLIC_MANIFEST=1
    if (process.env.WORKFLOW_PUBLIC_MANIFEST === '1') {
      // Write a placeholder handler file so rollup can resolve the path
      // during prod compilation. It will be overwritten with the real
      // manifest content by writeManifestHandler() in build:before.
      if (!nitro.options.dev) {
        const dir = join(nitro.options.buildDir, 'workflow');
        mkdirSync(dir, { recursive: true });
        const handlerPath = join(dir, 'manifest-handler.mjs');
        writeFileSync(
          handlerPath,
          'export default async () => new Response("Manifest not found", { status: 404 });\n'
        );
      }
      addManifestHandler(nitro);
    }
  },
} satisfies NitroModule;

function addVirtualHandler(nitro: Nitro, route: string, buildPath: string) {
  nitro.options.handlers.push({
    route,
    handler: `#${buildPath}`,
  });
  const handlerImportPath = JSON.stringify(
    join(nitro.options.buildDir, buildPath)
  );

  if (nitro.options.dev) {
    // Dev mode: load generated workflow bundles from disk at request time.
    // This keeps `.nitro/workflow/*.mjs` out of Nitro's own bundle graph,
    // which avoids rebuild loops and stale dependency graphs during HMR.
    // Cache-bust by file mtime so each successful rebuild loads fresh code.
    if (isNitroV2(nitro)) {
      nitro.options.virtual[`#${buildPath}`] = /* js */ `
      import { fromWebHandler } from "h3";
      import { statSync } from "node:fs";
      import { pathToFileURL } from "node:url";

      const handlerPath = ${handlerImportPath};
      let currentVersion = "";
      let currentImportPath = "";

      async function loadPOST() {
        const version = String(statSync(handlerPath).mtimeMs);
        if (version !== currentVersion) {
          currentVersion = version;
          currentImportPath = pathToFileURL(handlerPath).href + "?t=" + version;
        }
        return (await import(currentImportPath)).POST;
      }

      export default fromWebHandler(async (request, context) => {
        const POST = await loadPOST();
        return POST(request, context);
      });
    `;
    } else {
      nitro.options.virtual[`#${buildPath}`] = /* js */ `
      import { statSync } from "node:fs";
      import { pathToFileURL } from "node:url";

      const handlerPath = ${handlerImportPath};
      let currentVersion = "";
      let currentImportPath = "";

      async function loadPOST() {
        const version = String(statSync(handlerPath).mtimeMs);
        if (version !== currentVersion) {
          currentVersion = version;
          currentImportPath = pathToFileURL(handlerPath).href + "?t=" + version;
        }
        return (await import(currentImportPath)).POST;
      }

      export default async ({ req }) => {
        try {
          const POST = await loadPOST();
          return await POST(req);
        } catch (error) {
          console.error('Handler error:', error);
          return new Response('Internal Server Error', { status: 500 });
        }
      };
    `;
    }
    return;
  }

  // Keep a bare import alongside `POST`: in Nuxt + Nitro production builds
  // using `@workflow/nuxt`, importing only `POST` could drop the generated
  // step bundle's top-level registrations, so the handler loaded but steps
  // were missing at runtime.

  if (isNitroV2(nitro)) {
    // Nitro v2 (legacy)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    import ${handlerImportPath};
    import { fromWebHandler } from "h3";
    import { POST } from ${handlerImportPath};
    export default fromWebHandler(POST);
  `;
  } else {
    // Nitro v3+ (native web handlers)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    import ${handlerImportPath};
    import { POST } from ${handlerImportPath};
    export default async ({ req }) => {
      try {
        return await POST(req);
      } catch (error) {
        console.error('Handler error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    };
  `;
  }
}

const MANIFEST_VIRTUAL_ID = '#workflow/manifest-handler';

function addManifestHandler(nitro: Nitro) {
  const route = '/.well-known/workflow/v1/manifest.json';
  const manifestPath = join(nitro.options.buildDir, 'workflow/manifest.json');
  const handlerPath = join(
    nitro.options.buildDir,
    'workflow/manifest-handler.mjs'
  );

  if (nitro.options.dev) {
    // Dev mode: use a virtual handler that reads the manifest from disk at
    // request time. The absolute path is valid because we're on the build machine.
    nitro.options.handlers.push({ route, handler: MANIFEST_VIRTUAL_ID });
    nitro.options.virtual[MANIFEST_VIRTUAL_ID] = isNitroV2(nitro)
      ? /* js */ `
      import { fromWebHandler } from "h3";
      import { readFileSync } from "node:fs";
      function GET() {
        try {
          const manifest = readFileSync(${JSON.stringify(manifestPath)}, "utf-8");
          return new Response(manifest, {
            headers: { "content-type": "application/json" },
          });
        } catch {
          return new Response("Manifest not found", { status: 404 });
        }
      }
      export default fromWebHandler(GET);
    `
      : /* js */ `
      import { readFileSync } from "node:fs";
      export default async () => {
        try {
          const manifest = readFileSync(${JSON.stringify(manifestPath)}, "utf-8");
          return new Response(manifest, {
            headers: { "content-type": "application/json" },
          });
        } catch {
          return new Response("Manifest not found", { status: 404 });
        }
      };
    `;
  } else {
    // Prod mode: register a physical handler file that will be written by
    // writeManifestHandler() after the builder generates the manifest.
    // This file is bundled by rollup into the compiled output.
    nitro.options.handlers.push({ route, handler: handlerPath });
  }
}

/**
 * Writes a physical manifest handler file with the manifest content inlined.
 * Must be called after the builder generates the manifest (during build:before)
 * and before Nitro compiles the bundle with rollup.
 */
function writeManifestHandler(nitro: Nitro) {
  const manifestPath = join(nitro.options.buildDir, 'workflow/manifest.json');
  const handlerPath = join(
    nitro.options.buildDir,
    'workflow/manifest-handler.mjs'
  );
  const dir = join(nitro.options.buildDir, 'workflow');
  mkdirSync(dir, { recursive: true });

  try {
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    JSON.parse(manifestContent); // validate

    const handlerCode = isNitroV2(nitro)
      ? `import { fromWebHandler } from "h3";
const manifest = ${JSON.stringify(manifestContent)};
export default fromWebHandler(() => new Response(manifest, {
  headers: { "content-type": "application/json" },
}));
`
      : `const manifest = ${JSON.stringify(manifestContent)};
export default async () => new Response(manifest, {
  headers: { "content-type": "application/json" },
});
`;
    writeFileSync(handlerPath, handlerCode);
  } catch {
    // Write a 404 fallback handler
    const fallback = isNitroV2(nitro)
      ? `import { fromWebHandler } from "h3";
export default fromWebHandler(() => new Response("Manifest not found", { status: 404 }));
`
      : `export default async () => new Response("Manifest not found", { status: 404 });
`;
    writeFileSync(handlerPath, fallback);
  }
}
