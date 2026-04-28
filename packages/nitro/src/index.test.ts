import { STEP_QUEUE_TRIGGER, WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { describe, expect, it } from 'vitest';
import nitroModule from './index.js';

function createNitroStub({
  routing,
  meta,
  dev = false,
  preset = 'node-server',
  workflow = {},
  noExternals,
  vercel,
}: {
  routing: boolean;
  meta?: { version: string; majorVersion: number };
  dev?: boolean;
  preset?: string;
  workflow?: Record<string, unknown>;
  noExternals?: boolean | (string | RegExp)[];
  vercel?: { functionRules?: Record<string, unknown> };
}) {
  return {
    routing,
    ...(meta && { meta }),
    options: {
      alias: {},
      buildDir: '/tmp/.nitro',
      dev,
      externals: {},
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
      hook() {},
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

  it('enables sourcemaps for the v3 vercel deploy path', async () => {
    const nitro = createNitroStub({
      routing: true,
      meta: { version: '3.0.0', majorVersion: 3 },
      preset: 'vercel',
    });

    await nitroModule.setup(nitro);

    expect(nitro.options.sourcemap).toBe(true);
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
