import puppeteer, { Page } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';
import { generateText, generateReplyWithSearch, generateTweetFromNews, isTechRelated } from './llm';
import { QUOTE_SYSTEM_PROMPT } from './prompt';
import { isSimilarToRecentPosts, recordPostedText, hasInteractedWithUrl, recordInteractedUrl, getRecentPostedTexts } from './memory';

// Cache for the bot's username to prevent self-interaction
let myUsername: string | null = null;

// Helper function to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to download an image from the internet
async function downloadImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const tempDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Attempt to parse extensions or default to .jpg
    let ext = '.jpg';
    try {
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname;
      const parsedExt = path.extname(pathname);
      if (parsedExt && ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(parsedExt.toLowerCase())) {
        ext = parsedExt;
      }
    } catch { }

    const filePath = path.join(tempDir, `temp_image_${Date.now()}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err: any) {
    console.warn(`      ⚠️ Error downloading image:`, err.message || err);
    return null;
  }
}

// Helper to find the installation path of Google Chrome on Windows
function findChromePath(): string | undefined {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];

  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

// Helper function to programmatically update .env files
function updateEnvFile(key: string, value: string): void {
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `${key}=${value}\n`, 'utf8');
      return;
    }
    let content = fs.readFileSync(envPath, 'utf8');
    const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      if (!content.endsWith('\n') && content.length > 0) {
        content += '\n';
      }
      content += `${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err: any) {
    console.error(`⚠️ Error writing to .env:`, err.message || err);
  }
}

// Function to check if logged in
async function checkLoginStatus(page: Page): Promise<boolean> {
  const currentUrl = page.url();

  // If the URL explicitly contains '/home', we are highly likely logged in
  if (currentUrl.includes('/home')) {
    return true;
  }

  // Check for common elements only visible when logged in
  const loggedInElements = [
    'a[href="/home"]',
    '[data-testid="AppTabBar_Home_Link"]',
    '[data-testid="SideNav_AccountSidebar_Profile-Link"]',
    '[data-testid="SideNav_NewTweet_Button"]',
  ];

  for (const selector of loggedInElements) {
    try {
      const element = await page.$(selector);
      if (element) {
        return true;
      }
    } catch {
      // Ignore errors during checking individual selectors
    }
  }

  return false;
}

// Helper to get current logged in username
async function getCurrentUsername(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const selectors = [
        '[data-testid="SideNav_AccountSidebar_Profile-Link"]',
        'a[data-testid="AppTabBar_Profile_Link"]',
        '[data-testid="SideNav_UserCurrentUser_Button"]'
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          const href = el.getAttribute('href');
          if (href && href.startsWith('/')) {
            const parts = href.split('/').filter(Boolean);
            // Ignore common route path segments
            if (parts[0] && !['home', 'explore', 'notifications', 'messages', 'bookmarks', 'lists', 'compose'].includes(parts[0].toLowerCase())) {
              return parts[0];
            }
          }
          const text = el.textContent || '';
          const match = text.match(/@([A-Za-z0-9_]+)/);
          if (match && match[1]) {
            return match[1];
          }
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

// Scroll timeline feed to load tweets
async function scrollFeed(page: Page, targetCount: number): Promise<void> {
  let currentCount = (await page.$$('article[data-testid="tweet"]')).length;
  let attempts = 0;
  console.log(`      Scrolling timeline to fetch tweets...`);

  while (currentCount < targetCount && attempts < 10) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.5);
    });
    await delay(2000);
    currentCount = (await page.$$('article[data-testid="tweet"]')).length;
    attempts++;
  }
  console.log(`      Loaded ${currentCount} tweets on the timeline.`);
}

// Action: Post about latest AI/tech news
async function postAINews(page: Page): Promise<boolean> {
  console.log('   🔥 Action: Creating a new post based on latest AI/tech news...');

  const isHarsh = Math.random() < 0.70;
  console.log(`      Tone selection: ${isHarsh ? 'HARSH (70% probability)' : 'NORMAL (30% probability)'}`);

  // Generate the tweet using Exa search and LLM, checking for AI similarity
  let tweetContent = '';
  let imageUrls: string[] | undefined;
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    const recentPosts = getRecentPostedTexts(15);
    const result = await generateTweetFromNews(recentPosts, { isHarsh });
    tweetContent = result.text;
    imageUrls = result.imageUrls;

    const isDupOrSimilar = await isSimilarToRecentPosts(tweetContent);
    if (!isDupOrSimilar) {
      break;
    }
    console.log(`      ⚠️ Generated tweet is a duplicate or too similar to recent posts. Regenerating (attempt ${attempts + 1}/${maxAttempts})...`);
    attempts++;
  }
  console.log(`      Generated tweet content (length: ${tweetContent.length}):\n"${tweetContent}"`);

  let tempImagePath: string | null = null;
  if (imageUrls && imageUrls.length > 0) {
    console.log(`      Found candidate image URLs:`, imageUrls);
    for (const url of imageUrls) {
      console.log(`      Downloading image from: ${url}...`);
      tempImagePath = await downloadImage(url);
      if (tempImagePath) {
        console.log(`      Successfully downloaded image to: ${tempImagePath}`);
        break;
      } else {
        console.log(`      ⚠️ Failed to download image from: ${url}. Trying next candidate...`);
      }
    }
    if (!tempImagePath) {
      console.log(`      ⚠️ Could not download any of the candidate images. Proceeding with text-only post.`);
    }
  }

  try {
    // Open Composer directly
    console.log('      Opening tweet composer...');
    await page.goto('https://x.com/compose/post', { waitUntil: 'load', timeout: 30000 });
    await delay(4000);

    // If we have an image, upload it first
    if (tempImagePath) {
      try {
        console.log('      Uploading image...');
        const fileInputSelector = 'input[type="file"]';
        await page.waitForSelector(fileInputSelector, { timeout: 10000 });
        const inputElement = await page.$(fileInputSelector);
        if (inputElement) {
          await inputElement.uploadFile(tempImagePath);
          console.log('      Image uploaded. Waiting for preview to render...');
          await delay(5000);
        } else {
          console.warn('      ⚠️ File input element not found.');
        }
      } catch (uploadErr: any) {
        console.error('      ⚠️ Failed to upload image:', uploadErr.message || uploadErr);
      }
    }

    // Focus and type directly using fresh selectors
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    await page.click('[data-testid="tweetTextarea_0"]');
    await delay(1000);
    await page.keyboard.type(tweetContent, { delay: 50 });
    await delay(2000);

    // Click submit using selector
    await page.waitForSelector('[data-testid="tweetButton"]', { timeout: 5000 });
    await page.click('[data-testid="tweetButton"]');
    await delay(5000);
    console.log('   ✅ Tweet posted successfully!');
    recordPostedText(tweetContent);
    return true;
  } finally {
    // Clean up temporary image file
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      try {
        fs.unlinkSync(tempImagePath);
        console.log(`      Cleaned up temporary image file: ${tempImagePath}`);
      } catch (cleanupErr: any) {
        console.warn(`      ⚠️ Could not delete temporary image file:`, cleanupErr.message || cleanupErr);
      }
    }
  }
}

// Action: Reply to a tweet
async function replyToTweet(page: Page, tweetText: string, statusUrl: string): Promise<boolean> {
  console.log('   ✍️ Sub-Action: Replying to the selected tweet...');

  // Fail-safe check: do not reply if the current tweet detail page is our own tweet
  if (myUsername) {
    try {
      const currentUrl = page.url();
      const urlObj = new URL(currentUrl);
      const pathSegments = urlObj.pathname.split('/').filter(Boolean);
      const author = pathSegments[0];
      if (author && author.toLowerCase() === myUsername.toLowerCase()) {
        console.log(`      ⚠️ Skipped replying: Current page is our own tweet (${currentUrl})`);
        return false;
      }
    } catch (err: any) {
      console.warn('      ⚠️ Failed to parse current URL for author check in reply:', err.message || err);
    }
  }

  // Generate the reply and check for AI similarity
  let replyContent = '';
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    replyContent = await generateReplyWithSearch(tweetText);
    const isDupOrSimilar = await isSimilarToRecentPosts(replyContent);
    if (!isDupOrSimilar) {
      break;
    }
    console.log(`      ⚠️ Generated reply is a duplicate or too similar to recent posts. Regenerating (attempt ${attempts + 1}/${maxAttempts})...`);
    attempts++;
  }
  console.log(`      Generated reply:\n"${replyContent}"`);

  // Interact with composer text area using fresh selectors
  await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
  await page.click('[data-testid="tweetTextarea_0"]');
  await delay(1000);
  await page.keyboard.type(replyContent, { delay: 50 });
  await delay(2000);

  // Click submit
  await page.waitForSelector('[data-testid="tweetButtonInline"]', { timeout: 5000 });
  await page.click('[data-testid="tweetButtonInline"]');
  await delay(5000);
  console.log('   ✅ Reply posted successfully!');
  recordPostedText(replyContent);
  recordInteractedUrl(statusUrl);
  return true;
}

// Action: Repost (Retweet)
async function repostTweet(page: Page, statusUrl: string): Promise<boolean> {
  console.log('   🔄 Sub-Action: Reposting the selected tweet...');

  await page.waitForSelector('[data-testid="retweet"]', { timeout: 10000 });
  await page.click('[data-testid="retweet"]');
  await delay(1500);

  await page.waitForSelector('[data-testid="retweetConfirm"]', { timeout: 5000 });
  await page.click('[data-testid="retweetConfirm"]');
  await delay(4000);
  console.log('   ✅ Reposted successfully!');
  recordInteractedUrl(statusUrl);
  return true;
}

// Action: Quote Repost (Repost with thoughts)
async function quoteTweet(page: Page, tweetText: string, statusUrl: string): Promise<boolean> {
  console.log('   💬 Sub-Action: Quote-Reposting the selected tweet...');

  // Fail-safe check: do not quote-repost if the current tweet detail page is our own tweet
  if (myUsername) {
    try {
      const currentUrl = page.url();
      const urlObj = new URL(currentUrl);
      const pathSegments = urlObj.pathname.split('/').filter(Boolean);
      const author = pathSegments[0];
      if (author && author.toLowerCase() === myUsername.toLowerCase()) {
        console.log(`      ⚠️ Skipped quote-reposting: Current page is our own tweet (${currentUrl})`);
        return false;
      }
    } catch (err: any) {
      console.warn('      ⚠️ Failed to parse current URL for author check in quote:', err.message || err);
    }
  }

  // Generate quote commentary and check for AI similarity
  let commentary = '';
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    commentary = await generateText(
      `Write a short comment quote-tweeting this: "${tweetText}"`,
      QUOTE_SYSTEM_PROMPT
    );
    const isDupOrSimilar = await isSimilarToRecentPosts(commentary);
    if (!isDupOrSimilar) {
      break;
    }
    console.log(`      ⚠️ Generated commentary is a duplicate or too similar to recent posts. Regenerating (attempt ${attempts + 1}/${maxAttempts})...`);
    attempts++;
  }
  console.log(`      Generated quote thoughts:\n"${commentary}"`);

  await page.waitForSelector('[data-testid="retweet"], [data-testid="unretweet"]', { timeout: 10000 });
  await page.click('[data-testid="retweet"], [data-testid="unretweet"]');
  await delay(1500);

  // Wait for the dropdown menu items
  const quoteOptionSelector = '[role="menuitem"], [data-testid="QuoteTweet"], [data-testid="quote"]';
  await page.waitForSelector(quoteOptionSelector, { timeout: 5000 });

  // Click the quote option using evaluate to search by text/attribute
  const clickedQuoteOption = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [data-testid="QuoteTweet"], [data-testid="quote"]'));
    for (const item of items) {
      const text = (item.textContent || '').trim().toLowerCase();
      const testid = item.getAttribute('data-testid') || '';
      if (
        text.includes('quote') || 
        testid === 'QuoteTweet' || 
        testid === 'quote'
      ) {
        (item as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (!clickedQuoteOption) {
    console.log('      ⚠️ Evaluate search for quote option failed. Attempting direct click selector fallback...');
    try {
      await page.click('[data-testid="QuoteTweet"]');
    } catch {
      await page.click('[data-testid="quote"]');
    }
  }

  await delay(3000);

  // Wait for the composer (textarea) inside the modal dialog
  const textareaSelector = '[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0"]';
  await page.waitForSelector(textareaSelector, { timeout: 10000 });
  
  // Focus/Click the textarea, prioritizing the one in the modal dialog
  await page.evaluate(() => {
    const dialogTextarea = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]') as HTMLElement;
    if (dialogTextarea) {
      dialogTextarea.click();
      return;
    }
    const textareas = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]')) as HTMLElement[];
    if (textareas.length > 0) {
      textareas[textareas.length - 1]!.click();
    }
  });

  await delay(1000);
  await page.keyboard.type(commentary, { delay: 50 });
  await delay(2000);

  // Post quote by clicking the button, prioritizing the button inside the modal dialog
  const submitClicked = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const container = dialog || document;
    
    // Try data-testid="tweetButton"
    const btn1 = container.querySelector('[data-testid="tweetButton"]') as HTMLElement;
    if (btn1) {
      btn1.click();
      return true;
    }
    
    // Try data-testid="tweetButtonInline"
    const btn2 = container.querySelector('[data-testid="tweetButtonInline"]') as HTMLElement;
    if (btn2) {
      btn2.click();
      return true;
    }

    // Try text match (Post or Tweet)
    const buttons = Array.from(container.querySelectorAll('[role="button"], button')) as HTMLElement[];
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'post' || text === 'tweet') {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!submitClicked) {
    console.log('      ⚠️ Evaluate search for post button failed. Attempting direct click selector fallback...');
    await page.waitForSelector('[data-testid="tweetButton"]', { timeout: 5000 });
    await page.click('[data-testid="tweetButton"]');
  }

  await delay(5000);
  console.log('   ✅ Quote reposted successfully!');
  recordPostedText(commentary);
  recordInteractedUrl(statusUrl);
  return true;
}

// Action: Like a tweet
async function likeTweet(page: Page): Promise<boolean> {
  console.log('   ❤️ Sub-Action: Liking the selected tweet...');
  try {
    await page.waitForSelector('[data-testid="like"]', { timeout: 10000 });
    await page.click('[data-testid="like"]');
    await delay(3000);
    console.log('   ✅ Liked successfully!');
    return true;
  } catch (err: any) {
    console.log('      ⚠️ Could not click like button (or already liked):', err.message || err);
    return false;
  }
}


// Main Automation Runner
async function run() {
  // Check if testing mode (short intervals, 2 iterations) is enabled
  const isTestMode = process.argv.includes('--test') || process.argv.includes('--dry-run');

  console.log(`🚀 Starting Twitter/X automation... [Mode: ${isTestMode ? 'TEST (2 runs, quick delays)' : 'PRODUCTION (Indefinite autonomous loop)'}]`);

  const userDataDir = path.resolve('./user_data');
  console.log(`📁 Session directory: ${userDataDir}`);

  const chromePath = findChromePath();
  if (chromePath) {
    console.log(`🔍 Found local Google Chrome at: ${chromePath}`);
  } else {
    console.log('⚠️ Google Chrome installation not found. Falling back to default Chromium.');
  }

  let i = 1;
  while (true) {
    let browser: any = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: chromePath,
        userDataDir,
        defaultViewport: {
          width: 1280,
          height: 800,
        },
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      const pages = await browser.pages();
      const page = pages[0] || (await browser.newPage());

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Inject webdriver evasion
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      });

      // Set Twitter Session Cookie if available in environment
      const twitterAuthToken = process.env.TWITTER_AUTH_TOKEN;
      if (twitterAuthToken) {
        console.log('🔑 Injecting auth_token session cookie...');
        await page.setCookie({
          name: 'auth_token',
          value: twitterAuthToken,
          domain: '.x.com',
          path: '/',
          secure: true,
          httpOnly: true,
        });
      }

      console.log('🌐 Loading X/Twitter...');
      await page.goto('https://x.com/home', { waitUntil: 'load', timeout: 60000 });
      await delay(5000);

      // Initial Login Verification
      let loggedIn = await checkLoginStatus(page);
      if (!loggedIn) {
        console.log('⚠️ No active session detected.');
        console.log('👉 Please complete the login process manually in the opened browser window.');
        console.log('⏳ Watching browser window for successful login...');

        const startTime = Date.now();
        const timeoutMs = 5 * 60 * 1000;
        let lastMessageTime = 0;

        while (!loggedIn) {
          if (Date.now() - startTime > timeoutMs) {
            throw new Error('Timeout: User did not log in within 5 minutes.');
          }

          if (Date.now() - lastMessageTime > 10000) {
            console.log('   Waiting for manual login...');
            lastMessageTime = Date.now();
          }

          loggedIn = await checkLoginStatus(page);
          if (loggedIn) {
            console.log('🎉 Login detected! Finalizing session details...');
            await delay(5000);

            try {
              const cookies = await page.cookies();
              const authTokenCookie = cookies.find(c => c.name === 'auth_token');
              if (authTokenCookie && authTokenCookie.value) {
                console.log('💾 Saving new auth_token to .env...');
                updateEnvFile('TWITTER_AUTH_TOKEN', authTokenCookie.value);
                process.env.TWITTER_AUTH_TOKEN = authTokenCookie.value;
                console.log('✅ auth_token saved to .env!');
              }
            } catch (cookieErr: any) {
              console.warn('⚠️ Failed to save auth_token to .env:', cookieErr.message || cookieErr);
            }

            console.log('💾 Session successfully saved!');
            break;
          }
          await delay(2000);
        }
      } else {
        console.log('🎉 Session restored! Logged in successfully.');

        try {
          const cookies = await page.cookies();
          const authTokenCookie = cookies.find(c => c.name === 'auth_token');
          if (authTokenCookie && authTokenCookie.value && process.env.TWITTER_AUTH_TOKEN !== authTokenCookie.value) {
            console.log('💾 Syncing auth_token to .env...');
            updateEnvFile('TWITTER_AUTH_TOKEN', authTokenCookie.value);
            process.env.TWITTER_AUTH_TOKEN = authTokenCookie.value;
            console.log('✅ auth_token synced to .env!');
          }
        } catch (cookieErr: any) {
          console.warn('⚠️ Failed to sync auth_token to .env:', cookieErr.message || cookieErr);
        }
      }

      // Retrieve and cache current username
      myUsername = await getCurrentUsername(page);
      if (myUsername) {
        console.log(`👤 Logged in as: @${myUsername}`);
      } else {
        console.log('⚠️ Could not automatically detect logged in username.');
      }

      // --- Start Scheduling Loop ---
      while (true) {
        const iterStr = isTestMode ? `${i} of 2` : `${i}`;
        console.log(`\n========================================`);
        console.log(`⏰ ITERATION [${iterStr}] - Timestamp: ${new Date().toLocaleTimeString()}`);
        console.log(`========================================`);

        // Ensure we start from home page
        if (page.url() !== 'https://x.com/home' && !page.url().includes('https://x.com/home')) {
          console.log('🌐 Returning to home page...');
          await page.goto('https://x.com/home', { waitUntil: 'load', timeout: 30000 });
          await delay(5000);
        }

        // Roll a random action:
        // - 50% Quote Repost (repost with quote/thoughts)
        // - 50% Reply (comment)
        const isQuote = Math.random() < 0.50;
        let success = false;

        try {
          // Action: Interact with timeline tweet
          console.log(`   📰 Action: Interacting with a timeline tweet (${isQuote ? 'Quote Repost' : 'Reply'})...`);

          // Scroll feed to ensure 20+ tweets are loaded
          await scrollFeed(page, 22);

          // Extract all tweet text and status URLs inside the page execution context
          // This avoids passing ElementHandles that could become detached.
          const gatheredTweets = await page.evaluate(() => {
            const tweetElements = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            return tweetElements.map((el) => {
              const textEl = el.querySelector('[data-testid="tweetText"]');
              const text = textEl ? textEl.textContent || '' : '';

              const links = Array.from(el.querySelectorAll('a')) as HTMLAnchorElement[];
              const statusLink = links.find((link) => link.href.includes('/status/'));
              const url = statusLink ? statusLink.href : '';

              return { text, url };
            }).filter((t) => t.url !== '');
          });

          console.log(`      Total visible tweets gathered: ${gatheredTweets.length}`);

          if (!myUsername) {
            myUsername = await getCurrentUsername(page);
            if (myUsername) {
              console.log(`      👤 Detected username in timeline check: @${myUsername}`);
            }
          }

          // Filter out our own tweets and previously interacted tweets from timeline feed
          let filteredTweets = gatheredTweets.filter((t) => {
            // Check persistent history memory first
            if (hasInteractedWithUrl(t.url)) {
              console.log(`      Skipping previously interacted tweet: ${t.url}`);
              return false;
            }

            if (myUsername) {
              try {
                const urlObj = new URL(t.url);
                const pathSegments = urlObj.pathname.split('/').filter(Boolean);
                const author = pathSegments[0];
                if (author && author.toLowerCase() === myUsername.toLowerCase()) {
                  console.log(`      Skipping own tweet in timeline: ${t.url}`);
                  return false;
                }
              } catch {
                // Ignore URL parsing issues
              }
            }
            return true;
          });

          if (filteredTweets.length < 5) {
            console.log('      ⚠️ Too few tweets after filtering out own and interacted tweets. Skipping feed action in this iteration.');
            continue;
          }

          let targetIndex = -1;
          let selectedTweet: { text: string; url: string } | null = null;
          let attempts = 0;
          const maxAttempts = 5;

          // Shuffle indices between 5 and clamp(25, filteredTweets.length - 1) to search for a tech tweet
          const startIndex = Math.min(5, filteredTweets.length - 1);
          const endIndex = Math.min(25, filteredTweets.length - 1);

          const candidateIndices: number[] = [];
          for (let idx = startIndex; idx <= endIndex; idx++) {
            candidateIndices.push(idx);
          }
          // Shuffle
          for (let j = candidateIndices.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [candidateIndices[j], candidateIndices[k]] = [candidateIndices[k]!, candidateIndices[j]!];
          }

          console.log(`      Scanning candidates for a tech/AI related tweet...`);
          for (const candidateIdx of candidateIndices) {
            if (attempts >= maxAttempts) {
              console.log(`      Reached max attempts (${maxAttempts}) checking for tech/AI tweets.`);
              break;
            }

            const candidateTweet = filteredTweets[candidateIdx]!;
            attempts++;
            console.log(`      [Attempt ${attempts}] Checking candidate at index ${candidateIdx}...`);
            const isTech = await isTechRelated(candidateTweet.text);

            if (isTech) {
              targetIndex = candidateIdx;
              selectedTweet = candidateTweet;
              console.log(`      ✅ Found tech/AI related tweet at index ${candidateIdx}!`);
              break;
            } else {
              console.log(`      ❌ Candidate at index ${candidateIdx} is not tech/AI related.`);
            }
          }

          if (!selectedTweet) {
            console.log('      ⚠️ No tech/AI related tweets found in the candidate range. Skipping feed action in this iteration.');
            continue;
          }

          const tweetText = selectedTweet.text;
          const statusUrl = selectedTweet.url;

          console.log(`      Selected tweet at index ${targetIndex}...`);
          console.log(`      Found tweet content: "${tweetText.substring(0, 80).replace(/\n/g, ' ')}..."`);
          console.log(`      Navigating to tweet detail page: ${statusUrl}`);

          await page.goto(statusUrl, { waitUntil: 'load', timeout: 30000 });
          await delay(5000);

          // Sub-action: Like the tweet with a 50% chance
          const shouldAlsoLike = Math.random() < 0.50;
          if (shouldAlsoLike) {
            await likeTweet(page);
          }

          if (isQuote) {
            success = await quoteTweet(page, tweetText, statusUrl);
          } else {
            success = await replyToTweet(page, tweetText, statusUrl);
          }
        } catch (err: any) {
          console.error('   ❌ Error performing iteration action:', err.message || err);
        }

        console.log(`📢 Iteration ${i} complete. Success status: ${success ? 'YES' : 'NO'}`);

        // Check exit condition for test mode
        if (isTestMode && i >= 2) {
          console.log('\n🌟 All scheduled iterations completed successfully!');
          return;
        }

        // Calculate delay before the next action using JS random timer math
        let waitTimeSeconds = 0;
        if (isTestMode) {
          // In test mode, wait 15 seconds
          waitTimeSeconds = 15;
        } else {
          // Randomize wait time between 2 minutes (120s) and 4 minutes (240s)
          waitTimeSeconds = Math.floor(Math.random() * (240 - 120 + 1)) + 120;
        }

        console.log(`⏳ Waiting for ${waitTimeSeconds} seconds before next iteration...`);
        await delay(waitTimeSeconds * 1000);
        i++;
      }
    } catch (error: any) {
      console.error('❌ Error in scheduler run:', error.message || error);
      if (isTestMode) {
        console.log('🛑 Test mode failure, exiting.');
        return;
      }
      console.log('⏳ Waiting for 1 minute (60s) before auto-restarting the browser and automation...');
      await delay(60 * 1000);
    } finally {
      if (browser) {
        console.log('🔌 Closing browser...');
        try {
          await browser.close();
        } catch (closeErr: any) {
          console.warn('⚠️ Error closing browser:', closeErr.message || closeErr);
        }
      }
    }
  }
}

run();