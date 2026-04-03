import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { applySwcTransformMock } = vi.hoisted(() => ({
  applySwcTransformMock: vi.fn(),
}));

vi.mock('./apply-swc-transform.js', () => ({
  applySwcTransform: applySwcTransformMock,
}));

import {
  createDiscoverEntriesPlugin,
  importParents,
} from './discover-entries-esbuild-plugin.js';

const realTmpdir = realpathSync(tmpdir());

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('createDiscoverEntriesPlugin projectRoot', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-discover-plugin-'));
    importParents.clear();
    applySwcTransformMock.mockReset();
    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );
  });

  afterEach(() => {
    importParents.clear();
    rmSync(testRoot, { recursive: true, force: true });
  });

  function setupFixture() {
    const appRoot = join(testRoot, 'apps', 'chat');
    const packageRoot = join(testRoot, 'packages', 'vade');
    const workflowFile = join(
      packageRoot,
      'src',
      'internal',
      'message',
      'workflow',
      'handle-message.ts'
    );

    writeFile(
      workflowFile,
      `export async function handleMessageWorkflow(message) {
  "use workflow";

  return message;
}
`
    );

    return {
      appRoot,
      packageRoot,
      workflowFile,
    };
  }

  it('uses the explicit projectRoot during discovery transforms', async () => {
    const fixture = setupFixture();
    const normalizedWorkflowFile = normalizeSlashes(fixture.workflowFile);
    const state = {
      discoveredSteps: [],
      discoveredWorkflows: [],
      discoveredSerdeFiles: [],
    };

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [createDiscoverEntriesPlugin(state, fixture.appRoot)],
    });

    expect(result.errors).toHaveLength(0);
    expect(state.discoveredWorkflows).toEqual([normalizedWorkflowFile]);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      normalizedWorkflowFile,
      expect.stringContaining('"use workflow"'),
      false,
      normalizedWorkflowFile,
      fixture.appRoot
    );
  });

  it('tracks extensionless relative imports in the import graph', async () => {
    const workflowFile = join(
      testRoot,
      'server',
      'workflows',
      'my-workflow.ts'
    );
    const constantsFile = join(testRoot, 'shared', 'constants.ts');
    const helpersFile = join(testRoot, 'shared', 'helpers.ts');

    writeFile(helpersFile, `export const HELLO = "world";`);
    writeFile(
      constantsFile,
      `import { HELLO } from './helpers';\nexport const MSG = HELLO;`
    );
    writeFile(
      workflowFile,
      `import { MSG } from '../../shared/constants';\nexport function myWorkflow() {\n  "use workflow";\n  return MSG;\n}`
    );

    const state = {
      discoveredSteps: [] as string[],
      discoveredWorkflows: [] as string[],
      discoveredSerdeFiles: [] as string[],
    };

    await esbuild.build({
      entryPoints: [workflowFile],
      absWorkingDir: testRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      plugins: [createDiscoverEntriesPlugin(state, testRoot)],
    });

    const normalizedWorkflow = normalizeSlashes(workflowFile);
    const normalizedConstants = normalizeSlashes(constantsFile);
    const normalizedHelpers = normalizeSlashes(helpersFile);

    // my-workflow.ts -> shared/constants.ts (extensionless import)
    const workflowChildren = importParents.get(normalizedWorkflow);
    expect(workflowChildren).toBeDefined();
    expect(workflowChildren!.has(normalizedConstants)).toBe(true);

    // shared/constants.ts -> shared/helpers.ts (extensionless import)
    const constantsChildren = importParents.get(normalizedConstants);
    expect(constantsChildren).toBeDefined();
    expect(constantsChildren!.has(normalizedHelpers)).toBe(true);
  });

  it('defaults discovery transforms to absWorkingDir when projectRoot is omitted', async () => {
    const fixture = setupFixture();
    const normalizedWorkflowFile = normalizeSlashes(fixture.workflowFile);
    const state = {
      discoveredSteps: [],
      discoveredWorkflows: [],
      discoveredSerdeFiles: [],
    };

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [createDiscoverEntriesPlugin(state)],
    });

    expect(result.errors).toHaveLength(0);
    expect(state.discoveredWorkflows).toEqual([normalizedWorkflowFile]);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      normalizedWorkflowFile,
      expect.stringContaining('"use workflow"'),
      false,
      normalizedWorkflowFile,
      fixture.packageRoot
    );
  });
});
