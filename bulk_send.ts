import puppeteer, { Browser } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';

// ============================================================
//  ✏️  YOUR MESSAGE
// ============================================================
const MESSAGE_TEXT = `This contact is scraped from Nitish founder labs, and this group is not affiliated with Founder Labs.


We are all focusing, and we share our knowledge. We explore new tech projects, especially for students. This is built for students by students. We also focus on AI automations, including Instagram Reels and other AI projects, and some AI free stuff.

Everyone is welcome to chat in this group.


The main purpose of this group is to learn from each other, share knowledge, and collaborate on technology-related ideas and projects.

If you are interested, join here: https://chat.whatsapp.com/Ll3I5snm0Z32PWh0xOLlQ8


This is an automated message. Sorry if it makes you uncomfortable.

`;
// ============================================================

const CONTACT_FILE = path.resolve('./contact.json');
const SENT_FILE = path.resolve('./sent_contacts.json');   // ✅ successfully sent
const FAILED_FILE = path.resolve('./failed_contacts.json'); // ❌ failed – retried on next run
const LOG_FILE = path.resolve('./bulk_send_log.json');   // 📝 full detailed log
const USER_DATA_DIR = path.resolve('./user_data_bulk');       // separate session dir

const DELAY_AFTER_SEND = 4000;
const BATCH_LIMIT = 30; // Max messages to send per run to avoid bans

// ─── helpers ────────────────────────────────────────────────
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

function readJson<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { }
  return fallback;
}

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Chrome path ─────────────────────────────────────────────
function findChromePath(): string | undefined {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  return candidates.find(p => p && fs.existsSync(p));
}

// ─── WhatsApp login helpers ───────────────────────────────────
async function isLoggedIn(browser: Browser): Promise<boolean> {
  const pages = await browser.pages();
  const page = pages[0];
  if (!page) return false;
  const selectors = [
    '[data-testid="chat-list-search"]',
    'input[placeholder*="Search"]',
    '[data-testid="chat-list"]',
    'div[contenteditable="true"][data-tab="3"]',
  ];
  for (const s of selectors) {
    try { if (await page.$(s)) return true; } catch { }
  }
  return false;
}

async function waitForLogin(browser: Browser, timeoutMs = 90000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isLoggedIn(browser)) return true;
    await delay(2000);
  }
  return false;
}

// ─── Send to one phone number ─────────────────────────────────
// Returns: 'sent' | 'failed' | 'not_on_wa'
async function sendToPhone(browser: Browser, phone: string, messageText: string): Promise<'sent' | 'failed' | 'not_on_wa'> {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  const url = `https://web.whatsapp.com/send?phone=${encodeURIComponent(cleanPhone)}&text=`;

  // Always get a fresh page reference
  const pages = await browser.pages();
  const page = pages[0];
  if (!page) return 'failed';

  console.log(`   🌐 Transitioning chat client-side to +${cleanPhone}...`);
  try {
    // Navigate without full page reload by using pushState + popstate
    await page.evaluate((cleanPhone) => {
      window.history.pushState(null, '', `/send?phone=${cleanPhone}`);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    }, cleanPhone);
    // Allow route transition to initiate
    await delay(2000);
  } catch (err: any) {
    console.log(`   ⚠️ Client-side routing failed: ${err.message || err}. Falling back to full page reload...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {
      // timeout on goto is ok, we'll check for the textbox below
      console.log(`   ⚠️ goto timeout, continuing to check page...`);
    }
  }

  // Wait up to 18s for message box OR "invalid number" indicator
  const msgBoxSelectors = [
    'div[contenteditable="true"][data-tab="10"]',
    'footer div[contenteditable="true"]',
    'div[title="Type a message"]',
  ];

  const deadline = Date.now() + 18000;
  let foundSelector: string | null = null;

  while (Date.now() < deadline) {
    // Get a fresh page ref each iteration
    const freshPages = await browser.pages();
    const fp = freshPages[0];
    if (!fp) {
      await delay(1000);
      continue;
    }

    // Check "not on WhatsApp" error
    const notOnWa = await fp.evaluate(() => {
      const t = document.body?.textContent || '';
      const hasError = t.includes('Phone number shared via url is invalid') ||
        t.includes('not registered on WhatsApp') ||
        t.includes('This phone number is not registered');

      if (hasError) {
        // Attempt to automatically dismiss the warning popup modal so it doesn't block subsequent actions
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const okButton = buttons.find(b => {
          const text = (b.textContent || '').trim().toUpperCase();
          return text === 'OK' || text === 'CLOSE' || text === 'DISMISS';
        });
        if (okButton) {
          (okButton as HTMLElement).click();
        }
      }
      return hasError;
    }).catch(() => false);
    if (notOnWa) return 'not_on_wa';

    for (const sel of msgBoxSelectors) {
      try {
        const el = await fp.$(sel);
        if (el) {
          const visible = await fp.evaluate(e => {
            const r = (e as Element).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }, el).catch(() => false);
          if (visible) {
            foundSelector = sel;
            break;
          }
        }
      } catch { }
    }
    if (foundSelector) break;
    await delay(1000);
  }

  if (!foundSelector) {
    console.log(`   ❌ Message box not found for ${phone}`);
    return 'failed';
  }

  // Type and send message — always use fresh page + re-query element right before use
  try {
    const fp2 = (await browser.pages())[0];
    if (!fp2) return 'failed';

    // Click the message box (re-query to avoid stale handle)
    await fp2.click(foundSelector);
    await delay(500);

    // Clear any pre-filled text from the URL
    await fp2.keyboard.down('Control');
    await fp2.keyboard.press('a');
    await fp2.keyboard.up('Control');
    await fp2.keyboard.press('Backspace');
    await delay(200);

    const lines = messageText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined) {
        await fp2.keyboard.type(line, { delay: 20 });
      }
      if (i < lines.length - 1) {
        await fp2.keyboard.down('Shift');
        await fp2.keyboard.press('Enter');
        await fp2.keyboard.up('Shift');
      }
    }
    await delay(600);
    await fp2.keyboard.press('Enter');
    await delay(DELAY_AFTER_SEND);
    return 'sent';
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`   ❌ Send error: ${message}`);
    return 'failed';
  }
}

// ─── MAIN ────────────────────────────────────────────────────
async function run() {
  // Load contact list
  const allContacts: Array<Record<string, unknown>> = readJson(CONTACT_FILE, []);
  console.log(`📋 Loaded ${allContacts.length} contacts from contact.json`);

  // Filter valid phone numbers
  const validContacts = allContacts.filter(c => {
    const p = ((c['phone number'] || c['formatted phone'] || c.formattedPhone) as string || '').trim();
    return p && p !== '***PRO***' && p.startsWith('+');
  });
  console.log(`📱 ${validContacts.length} contacts with real phone numbers`);

  // Load tracking files
  const sentPhones: string[] = readJson(SENT_FILE, []);
  const failedPhones: string[] = readJson(FAILED_FILE, []);
  const log: Array<Record<string, unknown>> = readJson(LOG_FILE, []);

  // Keep failedPhones in scope to avoid unused warning
  console.log(`❌ Previously failed: ${failedPhones.length} contacts (will retry)`);

  const sentSet = new Set(sentPhones.map(p => p.replace(/[\s\-\(\)]/g, '')));
  console.log(`✅ Already sent: ${sentSet.size} contacts (will skip)`);

  // Build queue: not yet sent
  let queue = validContacts.filter(c => {
    const p = ((c['phone number'] || c['formatted phone'] || c.formattedPhone) as string || '').trim();
    const cleanP = p.replace(/[\s\-\(\)]/g, '');
    return !sentSet.has(cleanP);
  });

  if (queue.length > BATCH_LIMIT) {
    console.log(`⚠️ Queue size (${queue.length}) exceeds daily safety limit. Limiting to first ${BATCH_LIMIT} contacts this run.`);
    queue = queue.slice(0, BATCH_LIMIT);
  }
  console.log(`🚀 Queue: ${queue.length} contacts to process\n`);

  if (queue.length === 0) {
    console.log('✅ All contacts already messaged! Delete sent_contacts.json to start fresh.');
    process.exit(0);
  }

  // Launch browser
  const chromePath = findChromePath();
  console.log(chromePath ? `🔍 Chrome: ${chromePath}` : '⚠️ Using bundled Chromium');

  // Copy existing WA session if bulk dir doesn't exist yet (so no QR needed)
  const watDataDir = path.resolve('./user_data_whatsapp');
  if (!fs.existsSync(USER_DATA_DIR) && fs.existsSync(watDataDir)) {
    console.log('📂 Copying WhatsApp session from user_data_whatsapp → user_data_bulk...');
    fs.cpSync(watDataDir, USER_DATA_DIR, { recursive: true });
    console.log('   Done!');
  }

  const browser: Browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log('🌐 Opening WhatsApp Web...');
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Login check
    let loggedIn = await isLoggedIn(browser);
    if (!loggedIn) {
      console.log('📲 Please scan the QR code in the browser window...');
      loggedIn = await waitForLogin(browser, 10 * 60 * 1000);
      if (!loggedIn) throw new Error('Timed out waiting for QR scan.');
    }
    console.log('🎉 Logged in! Starting bulk send...\n');
    await delay(3000);

    // ── Loop ─────────────────────────────────────────────────
    let sent = 0, failed = 0, notOnWa = 0;
    const newFailedPhones: string[] = [];

    for (let i = 0; i < queue.length; i++) {
      const contact = queue[i];
      const phone = ((contact?.['phone number'] || contact?.['formatted phone'] || contact?.formattedPhone) as string || '').trim();
      const name = (((contact?.['saved name'] || contact?.savedName) as string) || ((contact?.['public name'] || contact?.publicName) as string) || phone).trim();

      console.log(`[${i + 1}/${queue.length}] → ${name} (${phone})`);

      const personalizedMsg = `Hi ${name},\n\n${MESSAGE_TEXT}`;
      const result = await sendToPhone(browser, phone, personalizedMsg);

      const logEntry: Record<string, unknown> = {
        phone,
        name,
        status: result,
        timestamp: new Date().toISOString(),
      };
      log.push(logEntry);

      if (result === 'sent') {
        sentPhones.push(phone);
        // Remove from failed list if it was there before
        const fi = newFailedPhones.indexOf(phone);
        if (fi !== -1) newFailedPhones.splice(fi, 1);
        sent++;
        console.log(`   ✅ Sent!`);
      } else if (result === 'not_on_wa') {
        notOnWa++;
        console.log(`   ⚠️  Not on WhatsApp`);
        // treat as permanently skipped — add to sent so we don't retry forever
        sentPhones.push(phone);
      } else {
        failed++;
        newFailedPhones.push(phone);
        console.log(`   ❌ Failed — will retry next run`);
      }

      // Save state after EVERY contact (safe to interrupt)
      writeJson(SENT_FILE, sentPhones);
      writeJson(FAILED_FILE, newFailedPhones);
      writeJson(LOG_FILE, log);

      console.log(`   📊 ${sent} sent | ${failed} failed | ${notOnWa} not on WA | ${queue.length - i - 1} remaining`);

      if (i < queue.length - 1) {
        // Randomized delay between 25 and 60 seconds
        const nextDelay = Math.floor(Math.random() * (60000 - 25000 + 1)) + 25000;
        console.log(`   ⏳ Waiting ${(nextDelay / 1000).toFixed(1)}s...\n`);
        await delay(nextDelay);
      }
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🏆 DONE!`);
    console.log(`   ✅ Sent:           ${sent}`);
    console.log(`   ❌ Failed (retry): ${failed}`);
    console.log(`   ⚠️  Not on WA:     ${notOnWa}`);
    console.log(`\n📁 Files saved:`);
    console.log(`   ${SENT_FILE}`);
    console.log(`   ${FAILED_FILE}`);
    console.log(`   ${LOG_FILE}`);
    if (failed > 0) {
      console.log(`\n💡 Re-run the script to retry the ${failed} failed contacts.`);
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Fatal error:', message);
  } finally {
    console.log('\n🔌 Closing browser...');
    if (browser.connected) await browser.close();
    console.log('👋 Done!');
  }
}

run();
