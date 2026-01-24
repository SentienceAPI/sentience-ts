# Sentience TypeScript SDK

> **A verification & control layer for AI agents that operate browsers**

Sentience is built for **AI agent developers** who already use Playwright / CDP / LangGraph and care about **flakiness, cost, determinism, evals, and debugging**.

Often described as _Jest for Browser AI Agents_ - but applied to end-to-end agent runs (not unit tests).

The core loop is:

> **Agent → Snapshot → Action → Verification → Artifact**

## What Sentience is

- A **verification-first runtime** (`AgentRuntime`) for browser agents
- Treats the browser as an adapter (Playwright / CDP); **`AgentRuntime` is the product**
- A **controlled perception** layer (semantic snapshots; pruning/limits; lowers token usage by filtering noise from what models see)
- A **debugging layer** (structured traces + failure artifacts)
- Enables **local LLM small models (3B-7B)** for browser automation (privacy, compliance, and cost control)
- Keeps vision models **optional** (use as a fallback when DOM/snapshot structure falls short, e.g. `<canvas>`)

## What Sentience is not

- Not a browser driver
- Not a Playwright replacement
- Not a vision-first agent framework

## Install

```bash
npm install sentienceapi
npx playwright install chromium
```

## Conceptual example (why this exists)

- Steps are **gated by verifiable UI assertions**
- If progress can’t be proven, the run **fails with evidence**
- This is how you make runs **reproducible** and **debuggable**, and how you run evals reliably

## Quickstart: a verification-first loop

```ts
import { SentienceBrowser, AgentRuntime } from 'sentienceapi';
import { JsonlTraceSink, Tracer } from 'sentienceapi';
import { exists, urlContains } from 'sentienceapi';
import type { Page } from 'playwright';

async function main(): Promise<void> {
  const tracer = new Tracer('demo', new JsonlTraceSink('trace.jsonl'));

  const browser = new SentienceBrowser();
  await browser.start();
  const page = browser.getPage();
  if (!page) throw new Error('no page');

  await page.goto('https://example.com');

  // AgentRuntime needs a snapshot provider; SentienceBrowser.snapshot() does not depend on Page,
  // so we wrap it to fit the runtime interface.
  const runtime = new AgentRuntime(
    { snapshot: async (_page: Page, options?: Record<string, any>) => browser.snapshot(options) },
    page,
    tracer
  );

  runtime.beginStep('Verify homepage');
  await runtime.snapshot({ limit: 60 });

  runtime.assert(urlContains('example.com'), 'on_domain', true);
  runtime.assert(exists('role=heading'), 'has_heading');

  runtime.assertDone(exists("text~'Example'"), 'task_complete');

  await browser.close();
}

void main();
```

## Capabilities (lifecycle guarantees)

### Controlled perception

- **Semantic snapshots** instead of raw DOM dumps
- **Pruning knobs** via `SnapshotOptions` (limit/filter)
- Snapshot diagnostics that help decide when “structure is insufficient”

### Constrained action space

- Action primitives operate on **stable IDs / rects** derived from snapshots
- Optional helpers for ordinality (“click the 3rd result”)

### Verified progress

- Predicates like `exists(...)`, `urlMatches(...)`, `isEnabled(...)`, `valueEquals(...)`
- Fluent assertion DSL via `expect(...)`
- Retrying verification via `runtime.check(...).eventually(...)`

### Explained failure

- JSONL trace events (`Tracer` + `JsonlTraceSink`)
- Optional failure artifact bundles (snapshots, diagnostics, step timelines, frames/clip)
- Deterministic failure semantics: when required assertions can’t be proven, the run fails with artifacts you can replay

### Framework interoperability

- Bring your own LLM and orchestration (LangGraph, custom loops)
- Register explicit LLM-callable tools with `ToolRegistry`

## ToolRegistry (LLM-callable tools)

```ts
import { ToolRegistry, registerDefaultTools } from 'sentienceapi';

const registry = new ToolRegistry();
registerDefaultTools(registry);
const toolsForLLM = registry.llmTools();
```

## Permissions (avoid Chrome permission bubbles)

Chrome permission prompts are outside the DOM and can be invisible to snapshots. Prefer setting a policy **before navigation**.

```ts
import { SentienceBrowser } from 'sentienceapi';
import type { PermissionPolicy } from 'sentienceapi';

const policy: PermissionPolicy = {
  default: 'clear',
  autoGrant: ['geolocation'],
  geolocation: { latitude: 37.77, longitude: -122.41, accuracy: 50 },
  origin: 'https://example.com',
};

// `permissionPolicy` is the last constructor argument; pass `keepAlive` right before it.
const browser = new SentienceBrowser(
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  false,
  policy
);
await browser.start();
```

If your backend supports it, you can also use ToolRegistry permission tools (`grant_permissions`, `clear_permissions`, `set_geolocation`) mid-run.

## Downloads (verification predicate)

```ts
import { downloadCompleted } from 'sentienceapi';

runtime.assert(downloadCompleted('report.csv'), 'download_ok', true);
```

## Debugging (fast)

- **Manual driver CLI**:

```bash
npx sentience driver --url https://example.com
```

- **Verification + artifacts + debugging with time-travel traces (Sentience Studio demo)**:

<video src="https://github.com/user-attachments/assets/7ffde43b-1074-4d70-bb83-2eb8d0469307" controls muted playsinline></video>

If the video tag doesn’t render in your GitHub README view, use this link: [`sentience-studio-demo.mp4`](https://github.com/user-attachments/assets/7ffde43b-1074-4d70-bb83-2eb8d0469307)

- **Sentience SDK Documentation**: https://www.sentienceapi.com/docs
