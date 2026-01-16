/**
 * Tests for backend actions
 */

import {
  click,
  typeText,
  scroll,
  scrollToElement,
  waitForStable,
  ClickTarget,
} from '../../src/backends/actions';
import { BrowserBackend } from '../../src/backends/protocol';

describe('backends/actions', () => {
  let mockBackend: jest.Mocked<BrowserBackend>;

  beforeEach(() => {
    mockBackend = {
      refreshPageInfo: jest.fn().mockResolvedValue({
        width: 1920,
        height: 1080,
        scrollX: 0,
        scrollY: 0,
      }),
      eval: jest.fn().mockResolvedValue(null),
      call: jest.fn().mockResolvedValue(null),
      getLayoutMetrics: jest.fn().mockResolvedValue({
        viewportX: 0,
        viewportY: 0,
        viewportWidth: 1920,
        viewportHeight: 1080,
        contentWidth: 1920,
        contentHeight: 5000,
        deviceScaleFactor: 1.0,
      }),
      screenshotPng: jest.fn().mockResolvedValue('base64data'),
      mouseMove: jest.fn().mockResolvedValue(undefined),
      mouseClick: jest.fn().mockResolvedValue(undefined),
      wheel: jest.fn().mockResolvedValue(undefined),
      typeText: jest.fn().mockResolvedValue(undefined),
      waitReadyState: jest.fn().mockResolvedValue(undefined),
      getUrl: jest.fn().mockResolvedValue('https://example.com'),
    };
  });

  describe('click', () => {
    it('should click at tuple coordinates', async () => {
      const result = await click(mockBackend, [100, 200]);

      expect(mockBackend.mouseMove).toHaveBeenCalledWith(100, 200);
      expect(mockBackend.mouseClick).toHaveBeenCalledWith(100, 200, 'left', 1);
      expect(result.success).toBe(true);
      expect(result.outcome).toBe('dom_updated');
    });

    it('should click at BBox center', async () => {
      const bbox = { x: 100, y: 100, width: 50, height: 30 };
      const result = await click(mockBackend, bbox);

      // Center should be (125, 115)
      expect(mockBackend.mouseMove).toHaveBeenCalledWith(125, 115);
      expect(mockBackend.mouseClick).toHaveBeenCalledWith(125, 115, 'left', 1);
      expect(result.success).toBe(true);
    });

    it('should click at object coordinates', async () => {
      const result = await click(mockBackend, { x: 200, y: 300 });

      expect(mockBackend.mouseMove).toHaveBeenCalledWith(200, 300);
      expect(mockBackend.mouseClick).toHaveBeenCalledWith(200, 300, 'left', 1);
      expect(result.success).toBe(true);
    });

    it('should support double-click', async () => {
      const result = await click(mockBackend, [100, 200], 'left', 2);

      expect(mockBackend.mouseClick).toHaveBeenCalledWith(100, 200, 'left', 2);
      expect(result.success).toBe(true);
    });

    it('should support right-click', async () => {
      const result = await click(mockBackend, [100, 200], 'right');

      expect(mockBackend.mouseClick).toHaveBeenCalledWith(100, 200, 'right', 1);
      expect(result.success).toBe(true);
    });

    it('should skip mouse move when moveFirst is false', async () => {
      const result = await click(mockBackend, [100, 200], 'left', 1, false);

      expect(mockBackend.mouseMove).not.toHaveBeenCalled();
      expect(mockBackend.mouseClick).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should return error result on failure', async () => {
      mockBackend.mouseClick.mockRejectedValue(new Error('Click failed'));

      const result = await click(mockBackend, [100, 200]);

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('error');
      expect(result.error?.code).toBe('click_failed');
      expect(result.error?.reason).toContain('Click failed');
    });

    it('should support human-like cursor movement policy (opt-in)', async () => {
      const result = await click(mockBackend, [100, 200], 'left', 1, true, {
        mode: 'human',
        steps: 6,
        durationMs: 0,
        pauseBeforeClickMs: 0,
        jitterPx: 0,
        overshootPx: 0,
        seed: 123,
      });

      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();
      expect(result.cursor?.mode).toBe('human');
      // Multiple moves (not just one)
      expect(mockBackend.mouseMove.mock.calls.length).toBeGreaterThan(1);
      // Final click should still happen at the target coordinates
      expect(mockBackend.mouseClick).toHaveBeenCalledWith(100, 200, 'left', 1);
    });
  });

  describe('typeText', () => {
    it('should type text without target', async () => {
      const result = await typeText(mockBackend, 'Hello World');

      expect(mockBackend.mouseClick).not.toHaveBeenCalled();
      expect(mockBackend.typeText).toHaveBeenCalledWith('Hello World');
      expect(result.success).toBe(true);
    });

    it('should click target before typing', async () => {
      const result = await typeText(mockBackend, 'Hello', [100, 200]);

      expect(mockBackend.mouseClick).toHaveBeenCalledWith(100, 200);
      expect(mockBackend.typeText).toHaveBeenCalledWith('Hello');
      expect(result.success).toBe(true);
    });

    it('should clear before typing when clearFirst is true', async () => {
      const result = await typeText(mockBackend, 'New text', [100, 200], true);

      expect(mockBackend.eval).toHaveBeenCalledWith("document.execCommand('selectAll')");
      expect(mockBackend.typeText).toHaveBeenCalledWith('New text');
      expect(result.success).toBe(true);
    });

    it('should return error result on failure', async () => {
      mockBackend.typeText.mockRejectedValue(new Error('Type failed'));

      const result = await typeText(mockBackend, 'Hello');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('type_failed');
    });
  });

  describe('scroll', () => {
    it('should scroll without target', async () => {
      const result = await scroll(mockBackend, 300);

      expect(mockBackend.wheel).toHaveBeenCalledWith(300, undefined, undefined);
      expect(result.success).toBe(true);
    });

    it('should scroll at target position', async () => {
      const result = await scroll(mockBackend, 300, [500, 400]);

      expect(mockBackend.wheel).toHaveBeenCalledWith(300, 500, 400);
      expect(result.success).toBe(true);
    });

    it('should scroll up with negative deltaY', async () => {
      const result = await scroll(mockBackend, -500);

      expect(mockBackend.wheel).toHaveBeenCalledWith(-500, undefined, undefined);
      expect(result.success).toBe(true);
    });

    it('should return error result on failure', async () => {
      mockBackend.wheel.mockRejectedValue(new Error('Scroll failed'));

      const result = await scroll(mockBackend, 300);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('scroll_failed');
    });
  });

  describe('scrollToElement', () => {
    it('should scroll element into view', async () => {
      mockBackend.eval.mockResolvedValue(true);

      const result = await scrollToElement(mockBackend, 42);

      expect(mockBackend.eval).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail when element not found', async () => {
      mockBackend.eval.mockResolvedValue(false);

      const result = await scrollToElement(mockBackend, 42);

      expect(result.success).toBe(false);
      expect(result.error?.reason).toContain('Element not found');
    });

    it('should support smooth scrolling', async () => {
      mockBackend.eval.mockResolvedValue(true);

      const result = await scrollToElement(mockBackend, 42, 'smooth');

      expect(mockBackend.eval).toHaveBeenCalledWith(expect.stringContaining("behavior: 'smooth'"));
      expect(result.success).toBe(true);
    });

    it('should support different block alignments', async () => {
      mockBackend.eval.mockResolvedValue(true);

      const result = await scrollToElement(mockBackend, 42, 'instant', 'start');

      expect(mockBackend.eval).toHaveBeenCalledWith(expect.stringContaining("block: 'start'"));
      expect(result.success).toBe(true);
    });
  });

  describe('waitForStable', () => {
    it('should wait for complete state', async () => {
      const result = await waitForStable(mockBackend, 'complete');

      expect(mockBackend.waitReadyState).toHaveBeenCalledWith('complete', 10000);
      expect(result.success).toBe(true);
    });

    it('should wait for interactive state', async () => {
      const result = await waitForStable(mockBackend, 'interactive');

      expect(mockBackend.waitReadyState).toHaveBeenCalledWith('interactive', 10000);
      expect(result.success).toBe(true);
    });

    it('should use custom timeout', async () => {
      const result = await waitForStable(mockBackend, 'complete', 5000);

      expect(mockBackend.waitReadyState).toHaveBeenCalledWith('complete', 5000);
      expect(result.success).toBe(true);
    });

    it('should return timeout error', async () => {
      mockBackend.waitReadyState.mockRejectedValue(new Error('Timed out waiting'));

      const result = await waitForStable(mockBackend, 'complete', 100);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('timeout');
    });

    it('should return wait_failed error for other failures', async () => {
      mockBackend.waitReadyState.mockRejectedValue(new Error('Network error'));

      const result = await waitForStable(mockBackend, 'complete');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('wait_failed');
    });
  });
});
