/**
 * Day 2 Example: Verify extension bridge is loaded
 */

import { SentienceBrowser } from '../src';

async function main() {
  const browser = new SentienceBrowser(undefined, false);
  
  try {
    await browser.start();
    
    // Check if extension API is available
    const bridgeOk = await browser.getPage().evaluate(
      () => typeof (window as any).sentience !== 'undefined'
    );
    
    console.log(`bridge_ok=${bridgeOk}`);
    
    if (bridgeOk) {
      console.log('✅ Extension loaded successfully!');
    } else {
      console.log('❌ Extension not loaded');
    }
  } finally {
    await browser.close();
  }
}

main().catch(console.error);

