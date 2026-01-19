import { AgentRuntime } from '../src/agent-runtime';
import { ActionExecutor } from '../src/utils/action-executor';
import { TraceSink } from '../src/tracing/sink';
import { Tracer } from '../src/tracing/tracer';
import { isChecked, isDisabled, isEnabled, valueEquals } from '../src/verification';
import { BBox, Element, Snapshot, VisualCues } from '../src/types';
import { MockPage } from './mocks/browser-mock';
import * as actionsModule from '../src/actions';

jest.mock('../src/actions');

class MockSink extends TraceSink {
  public events: any[] = [];
  emit(event: Record<string, any>): void {
    this.events.push(event);
  }
  async close(): Promise<void> {
    // no-op
  }
  getSinkType(): string {
    return 'MockSink';
  }
}

function makeElement(
  id: number,
  role: string,
  text: string | null,
  extras: Partial<Element> = {}
): Element {
  const cues: VisualCues = {
    is_primary: false,
    background_color_name: null,
    is_clickable: true,
  };
  return {
    id,
    role,
    text: text ?? undefined,
    importance: 10,
    bbox: { x: 0, y: 0, width: 100, height: 40 } as BBox,
    visual_cues: cues,
    ...extras,
  } as Element;
}

describe('AgentRuntime regression safety net', () => {
  it('v1 state assertions: enabled/disabled/checked/value', () => {
    const sink = new MockSink();
    const tracer = new Tracer('test-run', sink);
    const page = new MockPage('https://example.com') as any;

    const elements: Element[] = [
      makeElement(1, 'button', 'Submit', { disabled: false }),
      makeElement(2, 'checkbox', null, { checked: true }),
      makeElement(3, 'textbox', null, { value: 'hello', input_type: 'text' }),
      makeElement(4, 'button', 'Disabled', { disabled: true }),
    ];

    const snapshot: Snapshot = {
      status: 'success',
      url: 'https://example.com',
      elements,
      timestamp: 't1',
    };

    const browserLike = {
      snapshot: async () => snapshot,
    };

    const runtime = new AgentRuntime(browserLike as any, page as any, tracer);
    runtime.beginStep('Test');
    runtime.lastSnapshot = snapshot;

    expect(runtime.assert(isEnabled("text~'Submit'"), 'enabled')).toBe(true);
    expect(runtime.assert(isDisabled("text~'Disabled'"), 'disabled')).toBe(true);
    expect(runtime.assert(isChecked('role=checkbox'), 'checked')).toBe(true);
    expect(runtime.assert(valueEquals('role=textbox', 'hello'), 'value')).toBe(true);
  });

  it('v2 eventually retry loop succeeds on later snapshot', async () => {
    const sink = new MockSink();
    const tracer = new Tracer('test-run', sink);
    const page = new MockPage('https://example.com') as any;

    const snapshots: Snapshot[] = [
      { status: 'success', url: 'https://example.com', elements: [], timestamp: 't1' },
      { status: 'success', url: 'https://example.com', elements: [], timestamp: 't2' },
      { status: 'success', url: 'https://example.com/done', elements: [], timestamp: 't3' },
    ];

    const browserLike = {
      snapshot: async () => snapshots.shift() as Snapshot,
    };

    const runtime = new AgentRuntime(browserLike as any, page as any, tracer);
    runtime.beginStep('Test');

    const ok = await runtime
      .check(ctx => {
        const done = (ctx.url || '').endsWith('/done');
        return {
          passed: done,
          reason: done ? '' : 'not done',
          details: { reason_code: done ? 'ok' : 'no_match' },
        };
      }, 'eventually_done')
      .eventually({ timeoutMs: 2000, pollMs: 0 });

    expect(ok).toBe(true);
  });

  it('minConfidence gating yields snapshot_exhausted', async () => {
    const sink = new MockSink();
    const tracer = new Tracer('test-run', sink);
    const page = new MockPage('https://example.com') as any;

    const snapshots: Snapshot[] = [
      {
        status: 'success',
        url: 'https://example.com',
        elements: [],
        timestamp: 't1',
        diagnostics: { confidence: 0.1 } as any,
      },
      {
        status: 'success',
        url: 'https://example.com',
        elements: [],
        timestamp: 't2',
        diagnostics: { confidence: 0.1 } as any,
      },
    ];

    const browserLike = {
      snapshot: async () => snapshots.shift() as Snapshot,
    };

    const runtime = new AgentRuntime(browserLike as any, page as any, tracer);
    runtime.beginStep('Test');

    const ok = await runtime
      .check(() => ({ passed: true, reason: '', details: {} }), 'min_confidence')
      .eventually({
        timeoutMs: 2000,
        pollMs: 0,
        minConfidence: 0.7,
        maxSnapshotAttempts: 2,
      });

    expect(ok).toBe(false);
    const stepEnd = runtime.getAssertionsForStepEnd();
    expect((stepEnd.assertions[0] as any).details.reason_code).toBe('snapshot_exhausted');
  });

  it('golden: same snapshots/actions yield same outcome (no captcha)', async () => {
    const sink = new MockSink();
    const tracer = new Tracer('test-run', sink);
    const page = new MockPage('https://example.com') as any;

    const mockClick = actionsModule.click as jest.MockedFunction<typeof actionsModule.click>;
    const mockTypeText = actionsModule.typeText as jest.MockedFunction<
      typeof actionsModule.typeText
    >;
    mockClick.mockResolvedValue({
      success: true,
      duration_ms: 10,
      outcome: 'dom_updated',
      url_changed: false,
    });
    mockTypeText.mockResolvedValue({
      success: true,
      duration_ms: 10,
      outcome: 'dom_updated',
      url_changed: false,
    });

    const snap: Snapshot = {
      status: 'success',
      url: 'https://example.com',
      elements: [makeElement(1, 'button', 'Go'), makeElement(2, 'textbox', null)],
      timestamp: 't1',
    };

    const mockBrowser = {} as any;
    const executor = new ActionExecutor(mockBrowser, false);
    await executor.executeAction('CLICK(1)', snap);
    await executor.executeAction('TYPE(2, "hello")', snap);

    expect(mockClick).toHaveBeenCalledWith(mockBrowser, 1);
    expect(mockTypeText).toHaveBeenCalledWith(mockBrowser, 2, 'hello');

    const snapshots: Snapshot[] = [
      { status: 'success', url: 'https://example.com', elements: [], timestamp: 't1' },
      { status: 'success', url: 'https://example.com/after', elements: [], timestamp: 't2' },
      { status: 'success', url: 'https://example.com/done', elements: [], timestamp: 't3' },
    ];

    const browserLike = {
      snapshot: async () => snapshots.shift() as Snapshot,
    };

    const runtime = new AgentRuntime(browserLike as any, page as any, tracer);
    runtime.beginStep('Test');

    const ok = await runtime
      .check(ctx => {
        const done = (ctx.url || '').endsWith('/done');
        return { passed: done, reason: done ? '' : 'not done', details: {} };
      }, 'golden_flow')
      .eventually({ timeoutMs: 2000, pollMs: 0 });

    expect(ok).toBe(true);
  });
});
