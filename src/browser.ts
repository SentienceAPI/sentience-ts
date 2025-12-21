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

  constructor(
    private licenseKey?: string,
    private headless: boolean = false
  ) {}

  async start(): Promise<void> {
    // Get extension source path
    const repoRoot = path.resolve(__dirname, '../../..');
    const extensionSource = path.join(repoRoot, 'sentience-chrome');

    if (!fs.existsSync(extensionSource)) {
      throw new Error(
        `Extension not found at ${extensionSource}. ` +
        'Make sure sentience-chrome directory exists.'
      );
    }

    // Create temporary extension bundle
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentience-ext-'));
    this.extensionPath = tempDir;

    // Copy extension files
    const filesToCopy = [
      'manifest.json',
      'content.js',
      'background.js',
      'injected_api.js',
    ];

    for (const file of filesToCopy) {
      const src = path.join(extensionSource, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(tempDir, file));
      }
    }

    // Copy pkg directory (WASM)
    const pkgSource = path.join(extensionSource, 'pkg');
    if (fs.existsSync(pkgSource)) {
      const pkgDest = path.join(tempDir, 'pkg');
      fs.mkdirSync(pkgDest, { recursive: true });
      this.copyDirectory(pkgSource, pkgDest);
    }

    // Launch browser
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        `--load-extension=${tempDir.name}`,
        `--disable-extensions-except=${tempDir.name}`,
      ],
    });

    // Create context
    this.context = await this.browser.newContext({
      // Persistent context not needed for basic usage
    });

    // Create page
    this.page = await this.context.newPage();

    // Wait for extension
    await this.waitForExtension();
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

  private async waitForExtension(timeout: number = 10000): Promise<boolean> {
    if (!this.page) return false;

    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = await this.page.evaluate(() => {
          return (
            typeof (window as any).sentience !== 'undefined' &&
            typeof (window as any).sentience.snapshot === 'function'
          );
        });

        if (result) {
          return true;
        }
      } catch (e) {
        // Ignore errors during initialization
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('Browser not started. Call start() first.');
    }
    return this.page;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
    if (this.extensionPath && fs.existsSync(this.extensionPath)) {
      fs.rmSync(this.extensionPath, { recursive: true, force: true });
    }
  }
}

