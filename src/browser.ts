/**
 * Playwright browser harness with extension loading
 */

import { chromium, BrowserContext, Page, Browser } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export class SentienceBrowser {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private extensionPath: string | null = null;
  private userDataDir: string | null = null;
  private _apiKey?: string;
  private _apiUrl?: string;
  private headless: boolean;

  constructor(
    apiKey?: string,
    apiUrl?: string,
    headless: boolean = false
  ) {
    this._apiKey = apiKey;
    this.headless = headless;
    // Set default API URL if API key is provided
    if (apiKey && !apiUrl) {
      this._apiUrl = 'https://api.sentienceapi.com';
    } else {
      this._apiUrl = apiUrl;
    }
  }

  async start(): Promise<void> {
    // Get extension source path (relative to project root)
    // Handle both ts-node (src/) and compiled (dist/src/) cases
    let repoRoot: string;
    if (__dirname.includes('dist')) {
      // Compiled: dist/src/ -> go up 3 levels to project root (Sentience/)
      repoRoot = path.resolve(__dirname, '../../..');
    } else {
      // ts-node: src/ -> go up 2 levels to project root (Sentience/)
      repoRoot = path.resolve(__dirname, '../..');
    }
    const extensionSource = path.join(repoRoot, 'sentience-chrome');

    if (!fs.existsSync(extensionSource)) {
      throw new Error(
        `Extension not found at ${extensionSource}. ` +
        'Make sure sentience-chrome directory exists.'
      );
    }

    // Create temporary extension bundle
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentience-ext-'));
    this.extensionPath = tempDir; // tempDir is already a string

    // Copy extension files
    const filesToCopy = [
      'manifest.json',
      'content.js',
      'background.js',
      'injected_api.js',
    ];

    const missingFiles: string[] = [];
    for (const file of filesToCopy) {
      const src = path.join(extensionSource, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(tempDir, file));
      } else {
        missingFiles.push(file);
      }
    }

    if (missingFiles.length > 0) {
      throw new Error(
        `Missing required extension files: ${missingFiles.join(', ')}\n` +
        `Extension source: ${extensionSource}`
      );
    }

    // Copy pkg directory (WASM)
    const pkgSource = path.join(extensionSource, 'pkg');
    if (!fs.existsSync(pkgSource)) {
      throw new Error(
        `WASM package directory not found at ${pkgSource}\n` +
        'Make sure to build the extension: cd sentience-chrome && ./build.sh'
      );
    }
    
    // Verify WASM files exist
    const wasmJs = path.join(pkgSource, 'sentience_core.js');
    const wasmBinary = path.join(pkgSource, 'sentience_core_bg.wasm');
    if (!fs.existsSync(wasmJs) || !fs.existsSync(wasmBinary)) {
      throw new Error(
        `WASM files not found. Expected:\n` +
        `  - ${wasmJs}\n` +
        `  - ${wasmBinary}\n` +
        'Make sure to build the extension: cd sentience-chrome && ./build.sh'
      );
    }
    
    const pkgDest = path.join(tempDir, 'pkg');
    fs.mkdirSync(pkgDest, { recursive: true });
    this.copyDirectory(pkgSource, pkgDest);

    // Use launchPersistentContext for better extension support
    // Extensions load more reliably with persistent contexts
    const launchTimeout = 30000; // 30 seconds
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentience-profile-'));
    
    try {
      this.context = await Promise.race([
        chromium.launchPersistentContext(userDataDir, {
          headless: this.headless,
          args: [
            `--load-extension=${tempDir}`,
            `--disable-extensions-except=${tempDir}`,
          ],
          timeout: launchTimeout,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Browser launch timed out after ${launchTimeout}ms. Make sure Playwright browsers are installed: npx playwright install chromium`)), launchTimeout)
        ),
      ]);
    } catch (e: any) {
      // Clean up user data dir on failure
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw new Error(
        `Failed to launch browser: ${e.message}\n` +
        'Make sure Playwright browsers are installed: npx playwright install chromium'
      );
    }

    // Get first page or create new one
    const pages = this.context.pages();
    if (pages.length > 0) {
      this.page = pages[0];
    } else {
      this.page = await this.context.newPage();
    }
    
    // Store user data dir for cleanup
    this.userDataDir = userDataDir;

    // Navigate to a real page so extension can inject
    // Extension content scripts only run on actual pages (not about:blank)
    // Use a simple page that loads quickly
    await this.page.goto('https://example.com', {
      waitUntil: 'domcontentloaded',
      timeout: 15000, // 15 second timeout for navigation
    });

    // Give extension time to initialize (WASM loading is async)
    await this.page.waitForTimeout(1000);

    // Wait for extension to load
    if (!(await this.waitForExtension())) {
      // Extension might need more time, try waiting a bit longer
      await this.page.waitForTimeout(3000);
      
      // Try to get more diagnostic info
      let diagnosticInfo = '';
      try {
        diagnosticInfo = await this.page.evaluate(() => {
          const info: any = {
            sentience_defined: typeof (window as any).sentience !== 'undefined',
            registry_defined: typeof (window as any).sentience_registry !== 'undefined',
            snapshot_defined: typeof (window as any).sentience?.snapshot === 'function',
            wasm_loaded: !!(window as any).sentience?._wasmModule,
          };
          // Check console errors if possible
          if ((window as any).sentience) {
            info.sentience_keys = Object.keys((window as any).sentience);
          }
          return JSON.stringify(info, null, 2);
        });
      } catch (e) {
        diagnosticInfo = `Could not get diagnostic info: ${e}`;
      }
      
      if (!(await this.waitForExtension(10000))) {
        throw new Error(
          'Extension failed to load after navigation. Make sure:\n' +
          '1. Extension is built (cd sentience-chrome && ./build.sh)\n' +
          '2. All files are present (manifest.json, content.js, injected_api.js, pkg/)\n' +
          '3. Check browser console for errors\n' +
          `4. Extension path: ${tempDir}\n` +
          `5. Diagnostic info: ${diagnosticInfo}`
        );
      }
    }
  }

  private copyDirectory(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  private async waitForExtension(timeout: number = 20000): Promise<boolean> {
    if (!this.page) return false;

    const start = Date.now();
    let lastError: string | null = null;
    
    while (Date.now() - start < timeout) {
      try {
        const result = await this.page.evaluate(() => {
          // Check if sentience API exists
          if (typeof (window as any).sentience === 'undefined') {
            return { ready: false, reason: 'window.sentience not defined' };
          }
          // Check if snapshot function exists
          if (typeof (window as any).sentience.snapshot !== 'function') {
            return { ready: false, reason: 'snapshot function not available' };
          }
          // Check if WASM module is loaded
          if ((window as any).sentience_registry === undefined) {
            return { ready: false, reason: 'registry not initialized' };
          }
          // Check if WASM module itself is loaded
          const sentience = (window as any).sentience;
          if (!sentience._wasmModule || !sentience._wasmModule.analyze_page) {
            return { ready: false, reason: 'WASM module not loaded' };
          }
          return { ready: true };
        });

        if (result && (result as any).ready) {
          return true;
        }
        
        // Track the last error for debugging
        if (result && (result as any).reason) {
          lastError = (result as any).reason;
        }
      } catch (e: any) {
        lastError = `Evaluation error: ${e.message}`;
        // Continue waiting on errors
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Log the last error for debugging
    if (lastError) {
      console.warn(`Extension wait timeout. Last status: ${lastError}`);
    }
    
    return false;
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('Browser not started. Call start() first.');
    }
    return this.page;
  }

  // Expose API configuration (read-only)
  getApiKey(): string | undefined {
    return this._apiKey;
  }

  getApiUrl(): string | undefined {
    return this._apiUrl;
  }

  async close(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    
    // Close context first (this also closes the browser for persistent contexts)
    if (this.context) {
      cleanup.push(
        this.context.close().catch(() => {
          // Ignore errors during cleanup
        })
      );
      this.context = null;
    }
    
    // Close browser if it exists (for non-persistent contexts)
    if (this.browser) {
      cleanup.push(
        this.browser.close().catch(() => {
          // Ignore errors during cleanup
        })
      );
      this.browser = null;
    }
    
    // Wait for all cleanup to complete
    await Promise.all(cleanup);
    
    // Clean up extension directory
    if (this.extensionPath && fs.existsSync(this.extensionPath)) {
      try {
        fs.rmSync(this.extensionPath, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
      this.extensionPath = null;
    }
    
    // Clean up user data directory
    if (this.userDataDir && fs.existsSync(this.userDataDir)) {
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
      this.userDataDir = null;
    }
    
    this.page = null;
  }
}

