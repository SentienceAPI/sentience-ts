import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { defineTool, ToolRegistry } from '../src/tools/registry';
import { FileSandbox, registerFilesystemTools } from '../src/tools/filesystem';
import { registerDefaultTools } from '../src/tools/defaults';
import { ToolContext, UnsupportedCapabilityError } from '../src/tools/context';

describe('ToolRegistry', () => {
  it('validates and executes tools', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool<{ msg: string }, { msg: string }, null>({
        name: 'echo',
        description: 'Echo input',
        input: z.object({ msg: z.string() }),
        output: z.object({ msg: z.string() }),
        handler: async (_ctx, params) => ({ msg: params.msg }),
      })
    );

    const result = await registry.execute<{ msg: string }>('echo', { msg: 'hello' });
    expect(result.msg).toBe('hello');
  });
});

describe('Filesystem tools', () => {
  it('writes and reads from sandbox', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sentience-tools-'));
    const sandbox = new FileSandbox(tmpRoot);
    const registry = new ToolRegistry();
    registerFilesystemTools(registry, sandbox);

    await registry.execute('write_file', { path: 'note.txt', content: 'hi', overwrite: true });
    const result = await registry.execute<{ content: string }>('read_file', { path: 'note.txt' });
    expect(result.content).toBe('hi');
  });
});

describe('Permission tools', () => {
  it('grants permissions when supported', async () => {
    const registry = new ToolRegistry();
    const calls: Array<Record<string, any>> = [];
    const contextStub = {
      grantPermissions: (permissions: string[], origin?: string) => {
        calls.push({ kind: 'grant', permissions, origin });
        return Promise.resolve();
      },
      clearPermissions: () => Promise.resolve(),
      setGeolocation: () => Promise.resolve(),
    };

    class RuntimeStub {
      page = { context: () => contextStub };
      capabilities() {
        return {
          tabs: false,
          evaluate_js: false,
          downloads: false,
          filesystem_tools: false,
          keyboard: false,
          permissions: true,
        };
      }
      can(name: keyof ReturnType<RuntimeStub['capabilities']>) {
        return Boolean(this.capabilities()[name]);
      }
    }

    const ctx = new ToolContext(new RuntimeStub() as any);
    registerDefaultTools(registry, ctx);
    await registry.execute(
      'grant_permissions',
      { permissions: ['geolocation'], origin: 'https://x.com' },
      ctx
    );
    expect(calls).toEqual([
      { kind: 'grant', permissions: ['geolocation'], origin: 'https://x.com' },
    ]);
  });

  it('rejects permissions when unsupported', async () => {
    const registry = new ToolRegistry();

    class RuntimeStub {
      page = { context: () => null };
      capabilities() {
        return {
          tabs: false,
          evaluate_js: false,
          downloads: false,
          filesystem_tools: false,
          keyboard: false,
          permissions: false,
        };
      }
      can(name: keyof ReturnType<RuntimeStub['capabilities']>) {
        return Boolean(this.capabilities()[name]);
      }
    }

    const ctx = new ToolContext(new RuntimeStub() as any);
    registerDefaultTools(registry, ctx);
    await expect(
      registry.execute('grant_permissions', { permissions: ['geolocation'] }, ctx)
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});
