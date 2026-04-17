import { describe, expect, it } from 'vitest';
import nitroModule from './index.js';

function createNitroStub({
  routing,
  meta,
}: {
  routing: boolean;
  meta?: { version: string; majorVersion: number };
}) {
  return {
    routing,
    ...(meta && { meta }),
    options: {
      alias: {},
      buildDir: '/tmp/.nitro',
      dev: false,
      externals: {},
      handlers: [],
      preset: 'node-server',
      rootDir: '/tmp/project',
      typescript: {},
      virtual: {},
      workflow: {},
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
});
