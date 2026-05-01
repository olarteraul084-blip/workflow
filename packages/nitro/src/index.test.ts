import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEP_QUEUE_TRIGGER, WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builders.js';
import nitroModule from './index.js';

function createNitroStub({
  routing,
  meta,
  dev = false,
  preset = 'node-server',
  workflow = {},
  noExternals,
  externals,
  vercel,
  buildDir = '/tmp/.nitro',
}: {
  routing: boolean;
  meta?: { version: string; majorVersion: number };
  dev?: boolean;
  preset?: string;
  workflow?: Record<string, unknown>;
  noExternals?: boolean | (string | RegExp)[];
  externals?: {
    external?: Array<string | RegExp | ((id: string) => boolean)>;
  };
  vercel?: { functionRules?: Record<string, unknown> };
  buildDir?: string;
}) {
  const hooks: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    routing,
    ...(meta && { meta }),
    options: {
      alias: {},
      buildDir,
      dev,
      externals: externals ?? {},
      handlers: [],
      preset,
      rootDir: '/tmp/project',
      typescript: {},
      virtual: {},
      workflow,
      ...(noExternals !== undefined && { noExternals }),
      ...(vercel && { vercel }),
    },
    hooks: {
      hook(name: string, cb: (...args: any[]) => any) {
        (hooks[name] ??= []).push(cb);
      },
      _hooks: hooks,
    },
  } as any;
}

describe('@workflow/nitro virtual handlers', () => {
  it('preserves side effects from generated step modules in Nitro v2 handlers', async () => {
    const nitro = createNitroStub({ routing: false });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).toContain('import "/tmp/.nitro/workflow/steps.mjs";');
    expect(source).toContain(
      'import { POST } from "/tmp/.nitro/workflow/steps.mjs";'
    );
  });

  it('preserves side effects from generated step modules in Nitro v3 handlers', async () => {
    const nitro = createNitroStub({ routing: true });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).toContain('import "/tmp/.nitro/workflow/steps.mjs";');
    expect(source).toContain(
      'import { POST } from "/tmp/.nitro/workflow/steps.mjs";'
    );
  });

  it('uses meta.majorVersion to detect Nitro v2 when available', async () => {
    const nitro = createNitroStub({
      routing: false,
      meta: { version: '2.11.0', majorVersion: 2 },
    });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).toContain('fromWebHandler');
  });

  it('uses meta.majorVersion to detect Nitro v3 when available', async () => {
    const nitro = createNitroStub({
      routing: true,
      meta: { version: '3.0.0', majorVersion: 3 },
    });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).not.toContain('fromWebHandler');
    expect(source).toContain('export default async');
  });

  it('prefers meta.majorVersion over routing property', async () => {
    // Simulate a hypothetical case where routing is truthy but majorVersion says v2
    const nitro = createNitroStub({
      routing: true,
      meta: { version: '2.11.0', majorVersion: 2 },
    });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).toContain('fromWebHandler');
  });

  it('prefers meta.majorVersion over routing in dev-mode handlers', async () => {
    // Dev mode with v3 routing but v2 majorVersion — should still emit v2
    // dev handler (with fromWebHandler).
    const nitro = createNitroStub({
      routing: true,
      meta: { version: '2.11.0', majorVersion: 2 },
      dev: true,
    });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).toContain('fromWebHandler');
  });
});

describe('@workflow/nitro v3 Vercel deploy', () => {
  it('populates functionRules for step/flow with maxDuration max and queue triggers', async () => {
    const nitro = createNitroStub({
      routing: true,
      meta: { version: '3.0.0', majorVersion: 3 },
      preset: 'vercel',
    });

    await nitroModule.setup(nitro);

    const rules = nitro.options.vercel?.functionRules;
    expect(rules).toBeDefined();
    expect(rules['/.well-known/workflow/v1/step']).toEqual({
      maxDuration: 'max',
      experimentalTriggers: [STEP_QUEUE_TRIGGER],
    });
    expect(rules['/.well-known/workflow/v1/flow']).toEqual({
      maxDuration: 'max',
      experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
    });
    expect(rules['/.well-known/workflow/v1/webhook/**']).toBeUndefined();
    // sourcemap is opt-in: the module never flips it automatically. Users
    // enable it in their own nitro/nuxt config and nitro's vercel preset
    // then auto-sets `shouldAddSourcemapSupport: true`.
    expect(nitro.options.sourcemap).toBeUndefined();
  });

  it('adds runtime to step/flow/webhook rules when workflow.runtime is configured', async () => {
    const nitro = createNitroStub({
      routing: true,
      meta: { version: '3.0.0', majorVersion: 3 },
      preset: 'vercel',
      workflow: { runtime: 'nodejs22.x' },
    });

    await nitroModule.setup(nitro);

    const rules = nitro.options.vercel.functionRules;
    expect(rules['/.well-known/workflow/v1/step'].runtime).toBe('nodejs22.x');
    expect(rules['/.well-known/workflow/v1/flow'].runtime).toBe('nodejs22.x');
    expect(rules['/.well-known/workflow/v1/webhook/**']).toEqual({
      runtime: 'nodejs22.x',
    });
  });

  it('merges with user-defined functionRules at workflow paths', async () => {
    const nitro = createNitroStub({
      routing: true,
      meta: { version: '3.0.0', majorVersion: 3 },
      preset: 'vercel',
      vercel: {
        functionRules: {
          '/.well-known/workflow/v1/step': { memory: 1024 } as any,
          '/.well-known/workflow/v1/flow': { memory: 512 } as any,
        },
      },
    });

    await nitroModule.setup(nitro);

    const rules = nitro.options.vercel.functionRules;
    expect(rules['/.well-known/workflow/v1/step']).toMatchObject({
      memory: 1024,
      maxDuration: 'max',
      experimentalTriggers: [STEP_QUEUE_TRIGGER],
    });
    expect(rules['/.well-known/workflow/v1/flow']).toMatchObject({
      memory: 512,
      maxDuration: 'max',
      experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
    });
  });

  it('does not configure functionRules for the v2 vercel deploy path', async () => {
    const nitro = createNitroStub({
      routing: false,
      meta: { version: '2.11.0', majorVersion: 2 },
      preset: 'vercel',
    });

    await nitroModule.setup(nitro);

    expect(nitro.options.vercel).toBeUndefined();
    expect(nitro.options.sourcemap).toBeUndefined();
  });
});

describe('@workflow/nitro dev noExternals', () => {
  it('initializes noExternals as an array when missing', async () => {
    const nitro = createNitroStub({ routing: true, dev: true });

    await nitroModule.setup(nitro);

    expect(Array.isArray(nitro.options.noExternals)).toBe(true);
    expect(nitro.options.noExternals).toContain('workflow');
  });

  it('appends to an existing noExternals array', async () => {
    const nitro = createNitroStub({
      routing: true,
      dev: true,
      noExternals: ['existing-pkg'],
    });

    await nitroModule.setup(nitro);

    expect(nitro.options.noExternals).toEqual([
      'existing-pkg',
      'workflow',
      /^@workflow\//,
    ]);
  });

  it('leaves noExternals untouched when set to true', async () => {
    const nitro = createNitroStub({
      routing: true,
      dev: true,
      noExternals: true,
    });

    await expect(nitroModule.setup(nitro)).resolves.not.toThrow();

    expect(nitro.options.noExternals).toBe(true);
  });

  it('replaces noExternals when set to false', async () => {
    const nitro = createNitroStub({
      routing: true,
      dev: true,
      noExternals: false,
    });

    await expect(nitroModule.setup(nitro)).resolves.not.toThrow();

    expect(nitro.options.noExternals).toEqual(['workflow', /^@workflow\//]);
  });
});

describe('@workflow/nitro workflowSourcemapLoaderPlugin', () => {
  let tmpRoot: string;
  let buildDir: string;
  let workflowDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'wf-nitro-test-'));
    buildDir = join(tmpRoot, '.nitro');
    workflowDir = join(buildDir, 'workflow');
    mkdirSync(workflowDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function getPlugin() {
    const nitro = createNitroStub({ routing: true, buildDir });
    await nitroModule.setup(nitro);
    const callbacks = nitro.hooks._hooks['rollup:before'] ?? [];
    const config: { plugins: any[] } = { plugins: [] };
    for (const cb of callbacks) {
      cb(nitro, config);
    }
    const plugin = config.plugins.find(
      (p) => p?.name === 'workflow:sourcemap-loader'
    );
    if (!plugin) throw new Error('plugin not registered');
    return plugin;
  }

  it('returns { code, map } for an esbuild-style inline sourcemap', async () => {
    const plugin = await getPlugin();
    const map = {
      version: 3,
      sources: ['users.ts'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: ['export const x = 1;\n'],
    };
    const encoded = Buffer.from(JSON.stringify(map)).toString('base64');
    const code = `export const x = 1;\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
    const file = join(workflowDir, 'steps.mjs');
    writeFileSync(file, code);

    const result = plugin.load.handler(file);

    expect(result).toEqual({
      code: 'export const x = 1;\n',
      map,
    });
  });

  it('returns the raw code when there is no inline sourcemap', async () => {
    const plugin = await getPlugin();
    const code = 'export const x = 1;\n';
    const file = join(workflowDir, 'workflows.mjs');
    writeFileSync(file, code);

    const result = plugin.load.handler(file);

    expect(result).toBe(code);
  });

  it('falls through to raw code when the inline map is malformed base64', async () => {
    const plugin = await getPlugin();
    const code = `export const x = 1;\n//# sourceMappingURL=data:application/json;base64,not-valid-json!!\n`;
    const file = join(workflowDir, 'steps.mjs');
    writeFileSync(file, code);

    const result = plugin.load.handler(file);

    expect(result).toBe(code);
  });

  it('returns null for files outside the workflow build directory', async () => {
    const plugin = await getPlugin();
    const result = plugin.load.handler('/some/other/dir/file.mjs');
    expect(result).toBeNull();
  });

  it('returns null for non-.mjs files', async () => {
    const plugin = await getPlugin();
    const result = plugin.load.handler(join(workflowDir, 'steps.js'));
    expect(result).toBeNull();
  });
});

describe('@workflow/nitro externals forwarding', () => {
  for (const [label, Builder] of [
    ['VercelBuilder', VercelBuilder],
    ['LocalBuilder', LocalBuilder],
  ] as const) {
    describe(label, () => {
      it('does not forward anything when nitro externals are empty', () => {
        const nitro = createNitroStub({ routing: true });
        const builder = new Builder(nitro) as any;
        expect(builder.config.externalPackages).not.toContain('fsevents');
      });

      it('forwards string entries from nitro.options.externals.external', () => {
        const nitro = createNitroStub({
          routing: true,
          externals: { external: ['fsevents', 'pg'] },
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.externalPackages).toEqual(
          expect.arrayContaining(['fsevents', 'pg'])
        );
      });

      it('skips RegExp and function entries', () => {
        const nitro = createNitroStub({
          routing: true,
          externals: {
            external: [/pkg/, () => true, 'fsevents'],
          },
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.externalPackages).toContain('fsevents');
        expect(
          builder.config.externalPackages.some(
            (e: unknown) => typeof e !== 'string'
          )
        ).toBe(false);
      });

      it('forwards nothing when all entries are non-strings', () => {
        const nitro = createNitroStub({
          routing: true,
          externals: { external: [/pkg/, () => true] },
        });
        const builder = new Builder(nitro) as any;
        expect(
          builder.config.externalPackages.some(
            (e: unknown) => typeof e !== 'string'
          )
        ).toBe(false);
      });
    });
  }
});
