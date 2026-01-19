import { CaptchaHandler, CaptchaResolution } from './types';

type StrategyOptions = {
  message?: string;
  handledBy?: 'human' | 'customer_system' | 'unknown';
  timeoutMs?: number;
  pollMs?: number;
};

export function HumanHandoffSolver(options: StrategyOptions = {}): CaptchaHandler {
  return () => {
    const resolution: CaptchaResolution = {
      action: 'wait_until_cleared',
      message: options.message ?? 'Solve CAPTCHA in the live session, then resume.',
      handledBy: options.handledBy ?? 'human',
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    };
    return Promise.resolve(resolution);
  };
}

export function VisionSolver(options: StrategyOptions = {}): CaptchaHandler {
  return () => {
    const resolution: CaptchaResolution = {
      action: 'wait_until_cleared',
      message: options.message ?? 'Waiting for CAPTCHA to clear (vision verification).',
      handledBy: options.handledBy ?? 'customer_system',
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    };
    return Promise.resolve(resolution);
  };
}

export function ExternalSolver(
  resolver: (ctx: any) => Promise<void>,
  options: StrategyOptions = {}
): CaptchaHandler {
  return async ctx => {
    await resolver(ctx);
    const resolution: CaptchaResolution = {
      action: 'wait_until_cleared',
      message: options.message ?? 'External solver invoked; waiting for clearance.',
      handledBy: options.handledBy ?? 'customer_system',
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    };
    return resolution;
  };
}
