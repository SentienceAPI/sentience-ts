/**
 * CloudTraceSink - Enterprise Cloud Upload
 *
 * Implements "Local Write, Batch Upload" pattern for cloud tracing
 *
 * PRODUCTION HARDENING:
 * - Uses persistent cache directory (~/.sentience/traces/pending/) to survive crashes
 * - Supports non-blocking close() to avoid hanging user scripts
 * - Preserves traces locally on upload failure
 */

import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { TraceSink } from './sink';
import { ScreenshotMetadata } from '../types';

/**
 * Optional logger interface for SDK users
 */
export interface SentienceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Get persistent cache directory for traces
 * Uses ~/.sentience/traces/pending/ (survives process crashes)
 */
function getPersistentCacheDir(): string {
  const homeDir = os.homedir();
  const cacheDir = path.join(homeDir, '.sentience', 'traces', 'pending');

  // Create directory if it doesn't exist
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  return cacheDir;
}

/**
 * CloudTraceSink writes trace events to a local temp file,
 * then uploads the complete trace to cloud storage on close()
 *
 * Architecture:
 * 1. **Local Buffer**: Writes to temp file (zero latency, non-blocking)
 * 2. **Pre-signed URL**: Uses secure pre-signed PUT URL from backend API
 * 3. **Batch Upload**: Uploads complete file on close() or at intervals
 * 4. **Zero Credential Exposure**: Never embeds cloud credentials in SDK
 *
 * This design ensures:
 * - Fast agent performance (microseconds per emit, not milliseconds)
 * - Security (credentials stay on backend)
 * - Reliability (network issues don't crash the agent)
 *
 * Example:
 *   const sink = new CloudTraceSink(uploadUrl);
 *   const tracer = new Tracer(runId, sink);
 *   tracer.emitRunStart('SentienceAgent');
 *   await tracer.close(); // Uploads to cloud
 */
export class CloudTraceSink extends TraceSink {
  private uploadUrl: string;
  private tempFilePath: string;
  private runId: string;
  private writeStream: fs.WriteStream | null = null;
  private closed: boolean = false;
  private apiKey?: string;
  private apiUrl: string;
  private logger?: SentienceLogger;

  // File size tracking
  private traceFileSizeBytes: number = 0;
  private screenshotTotalSizeBytes: number = 0;

  // Screenshot storage directory
  private screenshotDir: string;
  
  // Screenshot metadata tracking (sequence -> ScreenshotMetadata)
  private screenshotMetadata: Map<number, ScreenshotMetadata> = new Map();
  
  // Upload success flag
  private uploadSuccessful: boolean = false;

  /**
   * Create a new CloudTraceSink
   *
   * @param uploadUrl - Pre-signed PUT URL from Sentience API
   * @param runId - Run ID for persistent cache naming
   * @param apiKey - Sentience API key for calling /v1/traces/complete
   * @param apiUrl - Sentience API base URL (default: https://api.sentienceapi.com)
   * @param logger - Optional logger instance for logging file sizes and errors
   */
  constructor(
    uploadUrl: string,
    runId?: string,
    apiKey?: string,
    apiUrl?: string,
    logger?: SentienceLogger
  ) {
    super();
    this.uploadUrl = uploadUrl;
    this.runId = runId || `trace-${Date.now()}`;
    this.apiKey = apiKey;
    this.apiUrl = apiUrl || 'https://api.sentienceapi.com';
    this.logger = logger;

    // PRODUCTION FIX: Use persistent cache directory instead of /tmp
    // This ensures traces survive process crashes!
    const cacheDir = getPersistentCacheDir();
    this.tempFilePath = path.join(cacheDir, `${this.runId}.jsonl`);

    // Screenshot storage directory
    this.screenshotDir = path.join(cacheDir, `${this.runId}_screenshots`);
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }

    try {
      // Open file in append mode
      this.writeStream = fs.createWriteStream(this.tempFilePath, {
        flags: 'a',
        encoding: 'utf-8',
        autoClose: true,
      });

      // Handle stream errors (suppress if closed)
      this.writeStream.on('error', (error) => {
        if (!this.closed) {
          console.error('[CloudTraceSink] Stream error:', error);
        }
      });
    } catch (error) {
      console.error('[CloudTraceSink] Failed to initialize sink:', error);
      this.writeStream = null;
    }
  }

  /**
   * Emit a trace event to local temp file (fast, non-blocking)
   *
   * @param event - Event dictionary from TraceEvent
   */
  emit(event: Record<string, any>): void {
    if (this.closed) {
      throw new Error('CloudTraceSink is closed');
    }

    if (!this.writeStream) {
      console.error('[CloudTraceSink] Write stream not available');
      return;
    }

    try {
      const jsonStr = JSON.stringify(event);
      this.writeStream.write(jsonStr + '\n');
    } catch (error) {
      console.error('[CloudTraceSink] Write error:', error);
    }
  }

  /**
   * Upload data to cloud using Node's built-in https module
   */
  private async _uploadToCloud(data: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.uploadUrl);
      const protocol = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/x-gzip',
          'Content-Encoding': 'gzip',
          'Content-Length': data.length,
        },
        timeout: 60000, // 1 minute timeout
      };

      const req = protocol.request(options, (res) => {
        // Consume response data (even if we don't use it)
        res.on('data', () => {});
        res.on('end', () => {
          resolve(res.statusCode || 500);
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Upload timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Upload buffered trace to cloud via pre-signed URL
   *
   * @param blocking - If false, upload happens in background (default: true)
   *
   * PRODUCTION FIX: Non-blocking mode prevents hanging user scripts
   * on slow uploads (Risk #2 from production hardening plan)
   */
  async close(blocking: boolean = true): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    // Non-blocking mode: fire-and-forget background upload
    if (!blocking) {
      // Close the write stream synchronously
      if (this.writeStream && !this.writeStream.destroyed) {
        this.writeStream.end();
      }

      // Upload in background (don't await)
      this._doUpload().catch((error) => {
        console.error(`❌ [Sentience] Background upload failed: ${error.message}`);
        console.error(`   Local trace preserved at: ${this.tempFilePath}`);
      });

      console.log('📤 [Sentience] Trace upload started in background');
      return;
    }

    // Blocking mode: wait for upload to complete
    await this._doUpload();
  }

  /**
   * Internal upload logic (called by both blocking and non-blocking close)
   */
  private async _doUpload(): Promise<void> {

    try {
      // 1. Close write stream
      if (this.writeStream && !this.writeStream.destroyed) {
        const stream = this.writeStream;
        stream.removeAllListeners('error');

        await new Promise<void>((resolve) => {
          stream.end(() => {
            resolve();
          });
        });
      }

      // 2. Generate index after closing file
      this.generateIndex();

      // 2. Read and compress trace data (using async operations)
      try {
        await fsPromises.access(this.tempFilePath);
      } catch {
        console.warn('[CloudTraceSink] Temp file does not exist, skipping upload');
        return;
      }

      const traceData = await fsPromises.readFile(this.tempFilePath);
      const compressedData = zlib.gzipSync(traceData);

      // Measure trace file size (NEW)
      this.traceFileSizeBytes = compressedData.length;

      // Log file sizes if logger is provided (NEW)
      if (this.logger) {
        this.logger.info(
          `Trace file size: ${(this.traceFileSizeBytes / 1024 / 1024).toFixed(2)} MB`
        );
        this.logger.info(
          `Screenshot total: ${(this.screenshotTotalSizeBytes / 1024 / 1024).toFixed(2)} MB`
        );
      }

      // 3. Upload to cloud via pre-signed URL
      console.log(
        `📤 [Sentience] Uploading trace to cloud (${compressedData.length} bytes)...`
      );

      const statusCode = await this._uploadToCloud(compressedData);

      if (statusCode === 200) {
        this.uploadSuccessful = true;
        console.log('✅ [Sentience] Trace uploaded successfully');

        // Upload screenshots after trace upload succeeds
        if (this.screenshotMetadata.size > 0) {
          console.log(`📸 [Sentience] Uploading ${this.screenshotMetadata.size} screenshots...`);
          await this._uploadScreenshots();
        }

        // Upload trace index file
        await this._uploadIndex();

        // Call /v1/traces/complete to report file sizes
        await this._completeTrace();

        // 4. Delete files on success
        await this._cleanupFiles();
      } else {
        this.uploadSuccessful = false;
        console.error(`❌ [Sentience] Upload failed: HTTP ${statusCode}`);
        console.error(`   Local trace preserved at: ${this.tempFilePath}`);
      }
    } catch (error: any) {
      console.error(`❌ [Sentience] Error uploading trace: ${error.message}`);
      console.error(`   Local trace preserved at: ${this.tempFilePath}`);
      // Don't throw - preserve trace locally even if upload fails
    }
  }

  /**
   * Call /v1/traces/complete to report file sizes to gateway.
   *
   * This is a best-effort call - failures are logged but don't affect upload success.
   */
  private async _completeTrace(): Promise<void> {
    if (!this.apiKey) {
      // No API key - skip complete call
      return;
    }

    return new Promise((resolve) => {
      const url = new URL(`${this.apiUrl}/v1/traces/complete`);
      const protocol = url.protocol === 'https:' ? https : http;

      const body = JSON.stringify({
        run_id: this.runId,
        stats: {
          trace_file_size_bytes: this.traceFileSizeBytes,
          screenshot_total_size_bytes: this.screenshotTotalSizeBytes,
          screenshot_count: this.screenshotMetadata.size,
        },
      });

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 10000, // 10 second timeout
      };

      const req = protocol.request(options, (res) => {
        // Consume response data
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 200) {
            this.logger?.info('Trace completion reported to gateway');
          } else {
            this.logger?.warn(
              `Failed to report trace completion: HTTP ${res.statusCode}`
            );
          }
          resolve();
        });
      });

      req.on('error', (error) => {
        // Best-effort - log but don't fail
        this.logger?.warn(`Error reporting trace completion: ${error.message}`);
        resolve();
      });

      req.on('timeout', () => {
        req.destroy();
        this.logger?.warn('Trace completion request timeout');
        resolve();
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Generate trace index file (automatic on close)
   */
  private generateIndex(): void {
    try {
      const { writeTraceIndex } = require('./indexer');
      writeTraceIndex(this.tempFilePath);
    } catch (error: any) {
      // Non-fatal: log but don't crash
      console.log(`⚠️  Failed to generate trace index: ${error.message}`);
    }
  }

  /**
   * Upload trace index file to cloud storage.
   *
   * Called after successful trace upload to provide fast timeline rendering.
   * The index file enables O(1) step lookups without parsing the entire trace.
   */
  private async _uploadIndex(): Promise<void> {
    // Construct index file path (same as trace file with .index.json extension)
    const indexPath = this.tempFilePath.replace('.jsonl', '.index.json');

    try {
      // Check if index file exists
      await fsPromises.access(indexPath);
    } catch {
      this.logger?.warn('Index file not found, skipping index upload');
      return;
    }

    try {
      // Request index upload URL from API
      if (!this.apiKey) {
        this.logger?.info('No API key provided, skipping index upload');
        return;
      }

      const uploadUrlResponse = await this._requestIndexUploadUrl();
      if (!uploadUrlResponse) {
        return;
      }

      // Read and compress index file
      const indexData = await fsPromises.readFile(indexPath);
      const compressedIndex = zlib.gzipSync(indexData);
      const indexSize = compressedIndex.length;

      this.logger?.info(`Index file size: ${(indexSize / 1024).toFixed(2)} KB`);

      console.log(`📤 [Sentience] Uploading trace index (${indexSize} bytes)...`);

      // Upload index to cloud storage
      const statusCode = await this._uploadIndexToCloud(uploadUrlResponse, compressedIndex);

      if (statusCode === 200) {
        console.log('✅ [Sentience] Trace index uploaded successfully');

        // Delete local index file after successful upload
        try {
          await fsPromises.unlink(indexPath);
        } catch {
          // Ignore cleanup errors
        }
      } else {
        this.logger?.warn(`Index upload failed: HTTP ${statusCode}`);
        console.log(`⚠️  [Sentience] Index upload failed: HTTP ${statusCode}`);
      }
    } catch (error: any) {
      // Non-fatal: log but don't crash
      this.logger?.warn(`Error uploading trace index: ${error.message}`);
      console.log(`⚠️  [Sentience] Error uploading trace index: ${error.message}`);
    }
  }

  /**
   * Request index upload URL from Sentience API
   */
  private async _requestIndexUploadUrl(): Promise<string | null> {
    return new Promise((resolve) => {
      const url = new URL(`${this.apiUrl}/v1/traces/index_upload`);
      const protocol = url.protocol === 'https:' ? https : http;

      const body = JSON.stringify({ run_id: this.runId });

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 10000,
      };

      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              resolve(response.upload_url || null);
            } catch {
              this.logger?.warn('Failed to parse index upload URL response');
              resolve(null);
            }
          } else {
            this.logger?.warn(`Failed to get index upload URL: HTTP ${res.statusCode}`);
            resolve(null);
          }
        });
      });

      req.on('error', (error) => {
        this.logger?.warn(`Error requesting index upload URL: ${error.message}`);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        this.logger?.warn('Index upload URL request timeout');
        resolve(null);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Upload index data to cloud using pre-signed URL
   */
  private async _uploadIndexToCloud(uploadUrl: string, data: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      const protocol = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': data.length,
        },
        timeout: 30000, // 30 second timeout
      };

      const req = protocol.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve(res.statusCode || 500);
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Index upload timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Store screenshot locally during execution.
   * 
   * Called by agent when screenshot is captured.
   * Fast, non-blocking operation (~1-5ms per screenshot).
   * 
   * @param sequence - Screenshot sequence number (1, 2, 3, ...)
   * @param screenshotData - Base64-encoded data URL from snapshot
   * @param format - Image format ("jpeg" or "png")
   * @param stepId - Optional step ID for trace event association
   */
  storeScreenshot(
    sequence: number,
    screenshotData: string,
    format: 'png' | 'jpeg',
    stepId?: string | null
  ): void {
    if (this.closed) {
      throw new Error('CloudTraceSink is closed');
    }

    try {
      // Extract base64 string from data URL
      // Format: "data:image/jpeg;base64,{base64_string}"
      let base64String: string;
      if (screenshotData.includes(',')) {
        base64String = screenshotData.split(',', 2)[1];
      } else {
        base64String = screenshotData; // Already base64, no prefix
      }

      // Decode base64 to image bytes
      const imageBytes = Buffer.from(base64String, 'base64');
      const imageSize = imageBytes.length;

      // Save to file
      const filename = `step_${sequence.toString().padStart(4, '0')}.${format}`;
      const filepath = path.join(this.screenshotDir, filename);

      fs.writeFileSync(filepath, imageBytes);

      // Track metadata using concrete type
      const metadata: ScreenshotMetadata = {
        sequence,
        format,
        sizeBytes: imageSize,
        stepId: stepId || null,
        filepath,
      };
      this.screenshotMetadata.set(sequence, metadata);

      // Update total size
      this.screenshotTotalSizeBytes += imageSize;

      if (this.logger) {
        this.logger.info(
          `Screenshot ${sequence} stored: ${(imageSize / 1024).toFixed(1)} KB (${format})`
        );
      }
    } catch (error: any) {
      // Log error but don't crash agent
      if (this.logger) {
        this.logger.error(`Failed to store screenshot ${sequence}: ${error.message}`);
      } else {
        console.error(`⚠️  [Sentience] Failed to store screenshot ${sequence}: ${error.message}`);
      }
    }
  }

  /**
   * Request pre-signed upload URLs for screenshots from gateway.
   * 
   * @param sequences - List of screenshot sequence numbers
   * @returns Map of sequence number to upload URL
   */
  private async _requestScreenshotUrls(sequences: number[]): Promise<Map<number, string>> {
    if (!this.apiKey || sequences.length === 0) {
      return new Map();
    }

    return new Promise((resolve) => {
      const url = new URL(`${this.apiUrl}/v1/screenshots/init`);
      const protocol = url.protocol === 'https:' ? https : http;

      const body = JSON.stringify({
        run_id: this.runId,
        sequences,
      });

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 10000, // 10 second timeout
      };

      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              const uploadUrls = response.upload_urls || {};
              const urlMap = new Map<number, string>();
              
              // Gateway returns sequences as strings in JSON, convert to int keys
              for (const [seqStr, url] of Object.entries(uploadUrls)) {
                urlMap.set(parseInt(seqStr, 10), url as string);
              }
              
              resolve(urlMap);
            } catch {
              this.logger?.warn('Failed to parse screenshot upload URLs response');
              resolve(new Map());
            }
          } else {
            this.logger?.warn(`Failed to get screenshot URLs: HTTP ${res.statusCode}`);
            resolve(new Map());
          }
        });
      });

      req.on('error', (error) => {
        this.logger?.warn(`Error requesting screenshot URLs: ${error.message}`);
        resolve(new Map());
      });

      req.on('timeout', () => {
        req.destroy();
        this.logger?.warn('Screenshot URLs request timeout');
        resolve(new Map());
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Upload all screenshots to cloud via pre-signed URLs.
   * 
   * Steps:
   * 1. Request pre-signed URLs from gateway (/v1/screenshots/init)
   * 2. Upload screenshots in parallel (10 concurrent workers)
   * 3. Track upload progress
   * 4. Handle failures gracefully
   */
  private async _uploadScreenshots(): Promise<void> {
    if (this.screenshotMetadata.size === 0) {
      return; // No screenshots to upload
    }

    // 1. Request pre-signed URLs from gateway
    const sequences = Array.from(this.screenshotMetadata.keys()).sort((a, b) => a - b);
    const uploadUrls = await this._requestScreenshotUrls(sequences);

    if (uploadUrls.size === 0) {
      console.log('⚠️  [Sentience] No screenshot upload URLs received, skipping upload');
      return;
    }

    // 2. Upload screenshots in parallel
    const uploadPromises: Promise<boolean>[] = [];

    for (const [seq, url] of uploadUrls.entries()) {
      const metadata = this.screenshotMetadata.get(seq);
      if (!metadata) {
        continue;
      }

      const uploadPromise = this._uploadSingleScreenshot(seq, url, metadata);
      uploadPromises.push(uploadPromise);
    }

    // Wait for all uploads (max 10 concurrent)
    const results = await Promise.allSettled(uploadPromises.slice(0, 10));
    
    // Process remaining uploads in batches of 10
    for (let i = 10; i < uploadPromises.length; i += 10) {
      const batch = uploadPromises.slice(i, i + 10);
      const batchResults = await Promise.allSettled(batch);
      results.push(...batchResults);
    }

    // Count successes and failures
    let uploadedCount = 0;
    const failedSequences: number[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        uploadedCount++;
      } else {
        failedSequences.push(sequences[i]);
      }
    }

    // 3. Report results
    const totalCount = uploadUrls.size;
    if (uploadedCount === totalCount) {
      console.log(`✅ [Sentience] All ${totalCount} screenshots uploaded successfully`);
    } else {
      console.log(`⚠️  [Sentience] Uploaded ${uploadedCount}/${totalCount} screenshots`);
      if (failedSequences.length > 0) {
        console.log(`   Failed sequences: ${failedSequences.join(', ')}`);
        console.log(`   Failed screenshots remain at: ${this.screenshotDir}`);
      }
    }
  }

  /**
   * Upload a single screenshot to pre-signed URL.
   * 
   * @param sequence - Screenshot sequence number
   * @param uploadUrl - Pre-signed upload URL
   * @param metadata - Screenshot metadata
   * @returns True if upload successful, false otherwise
   */
  private async _uploadSingleScreenshot(
    sequence: number,
    uploadUrl: string,
    metadata: ScreenshotMetadata
  ): Promise<boolean> {
    try {
      // Read image bytes from file
      const imageBytes = await fsPromises.readFile(metadata.filepath);

      // Upload to pre-signed URL
      const statusCode = await this._uploadScreenshotToCloud(uploadUrl, imageBytes, metadata.format);

      if (statusCode === 200) {
        return true;
      } else {
        this.logger?.warn(`Screenshot ${sequence} upload failed: HTTP ${statusCode}`);
        return false;
      }
    } catch (error: any) {
      this.logger?.warn(`Screenshot ${sequence} upload error: ${error.message}`);
      return false;
    }
  }

  /**
   * Upload screenshot data to cloud using pre-signed URL
   */
  private async _uploadScreenshotToCloud(
    uploadUrl: string,
    data: Buffer,
    format: 'png' | 'jpeg'
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      const protocol = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Content-Type': `image/${format}`,
          'Content-Length': data.length,
        },
        timeout: 30000, // 30 second timeout per screenshot
      };

      const req = protocol.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve(res.statusCode || 500);
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Screenshot upload timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Delete local files after successful upload.
   */
  private async _cleanupFiles(): Promise<void> {
    // Delete trace file
    try {
      if (fs.existsSync(this.tempFilePath)) {
        await fsPromises.unlink(this.tempFilePath);
      }
    } catch {
      // Ignore cleanup errors
    }

    // Delete screenshot files and directory
    if (fs.existsSync(this.screenshotDir) && this.uploadSuccessful) {
      try {
        // Delete all screenshot files
        const files = await fsPromises.readdir(this.screenshotDir);
        for (const file of files) {
          if (file.startsWith('step_') && (file.endsWith('.jpeg') || file.endsWith('.png'))) {
            await fsPromises.unlink(path.join(this.screenshotDir, file));
          }
        }

        // Delete directory if empty
        try {
          await fsPromises.rmdir(this.screenshotDir);
        } catch {
          // Directory not empty (some uploads failed)
        }
      } catch (error: any) {
        this.logger?.warn(`Failed to cleanup screenshots: ${error.message}`);
      }
    }
  }

  /**
   * Get unique identifier for this sink
   */
  getSinkType(): string {
    return `CloudTraceSink(${this.uploadUrl.substring(0, 50)}...)`;
  }
}
