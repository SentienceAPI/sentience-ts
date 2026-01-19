import fs from 'fs';
import os from 'os';
import path from 'path';

export type PersistMode = 'onFail' | 'always';

export interface FailureArtifactsOptions {
  bufferSeconds?: number;
  captureOnAction?: boolean;
  fps?: number;
  persistMode?: PersistMode;
  outputDir?: string;
  onBeforePersist?: ((ctx: RedactionContext) => RedactionResult) | null;
  redactSnapshotValues?: boolean;
}

interface FrameRecord {
  ts: number;
  fileName: string;
  filePath: string;
}

export interface RedactionContext {
  runId: string;
  reason: string | null;
  status: 'failure' | 'success';
  snapshot: any;
  diagnostics: any;
  framePaths: string[];
  metadata: Record<string, any>;
}

export interface RedactionResult {
  snapshot?: any;
  diagnostics?: any;
  framePaths?: string[];
  dropFrames?: boolean;
}

async function writeJsonAtomic(filePath: string, data: any): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmpPath, filePath);
}

function redactSnapshotDefaults(payload: any): any {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const elements = Array.isArray(payload.elements) ? payload.elements : null;
  if (!elements) {
    return payload;
  }
  const redactedElements = elements.map((el: any) => {
    if (!el || typeof el !== 'object') return el;
    const inputType = String(el.input_type || '').toLowerCase();
    if (['password', 'email', 'tel'].includes(inputType) && 'value' in el) {
      return { ...el, value: null, value_redacted: true };
    }
    return el;
  });
  return { ...payload, elements: redactedElements };
}

export class FailureArtifactBuffer {
  private runId: string;
  private options: Required<FailureArtifactsOptions>;
  private frames: FrameRecord[] = [];
  private steps: Record<string, any>[] = [];
  private persisted = false;
  private timeNow: () => number;
  private tempDir: string;
  private framesDir: string;

  constructor(
    runId: string,
    options: FailureArtifactsOptions = {},
    timeNow: () => number = () => Date.now()
  ) {
    this.runId = runId;
    this.options = {
      bufferSeconds: options.bufferSeconds ?? 15,
      captureOnAction: options.captureOnAction ?? true,
      fps: options.fps ?? 0,
      persistMode: options.persistMode ?? 'onFail',
      outputDir: options.outputDir ?? '.sentience/artifacts',
      onBeforePersist: options.onBeforePersist ?? null,
      redactSnapshotValues: options.redactSnapshotValues ?? true,
    };
    this.timeNow = timeNow;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentience-artifacts-'));
    this.framesDir = path.join(this.tempDir, 'frames');
    fs.mkdirSync(this.framesDir, { recursive: true });
  }

  getOptions(): Required<FailureArtifactsOptions> {
    return this.options;
  }

  recordStep(action: string, stepId: string | null, stepIndex: number, url?: string): void {
    this.steps.push({
      ts: this.timeNow(),
      action,
      step_id: stepId,
      step_index: stepIndex,
      url,
    });
  }

  async addFrame(image: Buffer, fmt: 'jpeg' | 'png' = 'jpeg'): Promise<void> {
    const ts = this.timeNow();
    const fileName = `frame_${ts}.${fmt}`;
    const filePath = path.join(this.framesDir, fileName);
    await fs.promises.writeFile(filePath, image);
    this.frames.push({ ts, fileName, filePath });
    this.prune();
  }

  frameCount(): number {
    return this.frames.length;
  }

  private prune(): void {
    const cutoff = this.timeNow() - this.options.bufferSeconds * 1000;
    const keep: FrameRecord[] = [];
    for (const frame of this.frames) {
      if (frame.ts >= cutoff) {
        keep.push(frame);
      } else {
        try {
          fs.unlinkSync(frame.filePath);
        } catch {
          // ignore
        }
      }
    }
    this.frames = keep;
  }

  async persist(
    reason: string | null,
    status: 'failure' | 'success',
    snapshot?: any,
    diagnostics?: any,
    metadata?: Record<string, any>
  ): Promise<string | null> {
    if (this.persisted) {
      return null;
    }

    const outDir = this.options.outputDir;
    await fs.promises.mkdir(outDir, { recursive: true });
    const ts = this.timeNow();
    const runDir = path.join(outDir, `${this.runId}-${ts}`);
    const framesOut = path.join(runDir, 'frames');
    await fs.promises.mkdir(framesOut, { recursive: true });

    for (const frame of this.frames) {
      await fs.promises.copyFile(frame.filePath, path.join(framesOut, frame.fileName));
    }

    await writeJsonAtomic(path.join(runDir, 'steps.json'), this.steps);

    let snapshotPayload = snapshot;
    if (snapshotPayload && this.options.redactSnapshotValues) {
      snapshotPayload = redactSnapshotDefaults(snapshotPayload);
    }

    let diagnosticsPayload = diagnostics;
    let framePaths = this.frames.map(frame => frame.filePath);
    let dropFrames = false;

    if (this.options.onBeforePersist) {
      try {
        const result = this.options.onBeforePersist({
          runId: this.runId,
          reason,
          status,
          snapshot: snapshotPayload,
          diagnostics: diagnosticsPayload,
          framePaths,
          metadata: metadata ?? {},
        });
        if (result.snapshot !== undefined) {
          snapshotPayload = result.snapshot;
        }
        if (result.diagnostics !== undefined) {
          diagnosticsPayload = result.diagnostics;
        }
        if (result.framePaths) {
          framePaths = result.framePaths;
        }
        dropFrames = Boolean(result.dropFrames);
      } catch {
        dropFrames = true;
      }
    }

    if (!dropFrames) {
      for (const framePath of framePaths) {
        if (!fs.existsSync(framePath)) {
          continue;
        }
        const fileName = path.basename(framePath);
        await fs.promises.copyFile(framePath, path.join(framesOut, fileName));
      }
    }

    let snapshotWritten = false;
    if (snapshotPayload) {
      await writeJsonAtomic(path.join(runDir, 'snapshot.json'), snapshotPayload);
      snapshotWritten = true;
    }

    let diagnosticsWritten = false;
    if (diagnosticsPayload) {
      await writeJsonAtomic(path.join(runDir, 'diagnostics.json'), diagnosticsPayload);
      diagnosticsWritten = true;
    }

    const manifest = {
      run_id: this.runId,
      created_at_ms: ts,
      status,
      reason,
      buffer_seconds: this.options.bufferSeconds,
      frame_count: dropFrames ? 0 : framePaths.length,
      frames: dropFrames ? [] : framePaths.map(p => ({ file: path.basename(p), ts: null })),
      snapshot: snapshotWritten ? 'snapshot.json' : null,
      diagnostics: diagnosticsWritten ? 'diagnostics.json' : null,
      metadata: metadata ?? {},
      frames_redacted: !dropFrames && Boolean(this.options.onBeforePersist),
      frames_dropped: dropFrames,
    };
    await writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest);

    this.persisted = true;
    return runDir;
  }

  async cleanup(): Promise<void> {
    await fs.promises.rm(this.tempDir, { recursive: true, force: true });
  }
}
