const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const TFL_URL = "https://tfl.gov.uk/tube-dlr-overground/status";
const PREVIOUS_DISRUPTIONS_FILE = "previous_disruptions.json";

async function checkStatus() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ],
  });
  
  const page = await browser.newPage();
  
  // Set a longer default timeout for all operations
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  // Set viewport to a larger size
  await page.setViewport({ width: 1920, height: 1080 });
  
  // Enable request interception to monitor network activity
  await page.setRequestInterception(true);
  let pendingRequests = 0;
  
  page.on('request', request => {
    pendingRequests++;
    request.continue();
  });
  
  page.on('response', response => {
    pendingRequests--;
  });
  
  // Navigate to the page with increased timeout
  console.log("Navigating to TfL status page...");
  await page.goto(TFL_URL, { 
    waitUntil: "networkidle0",
    timeout: 60000
  });
  
  // Wait for network to be idle
  console.log("Waiting for network to be idle...");
  await page.waitForFunction(() => {
    return window.performance.getEntriesByType('resource')
      .every(resource => resource.responseEnd > 0);
  }, { timeout: 60000 });
  
  // Wait an additional 5 seconds to ensure the page is fully loaded
  console.log("Additional wait for page stability...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Accept Cookies if present
  const cookieBanner = await page.$("#cb-cookiebanner");
  if (cookieBanner) {
    const acceptButton = await page.$("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll");
    if (acceptButton) {
      await acceptButton.click();
      console.log("Cookie Policy Accepted");
    }
  }
  
  // Wait to ensure the page is fully rendered
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Refresh the page without any gradient overlay from the cookie policy
  console.log("Refreshing page...");
  await page.reload({ waitUntil: "networkidle0" });
  console.log("Page Refreshed");

  // Wait to ensure the page is fully rendered without the cookie policy
  console.log("Waiting for page stability after refresh...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Debug: Log the page content to see what's actually loaded
  const pageContent = await page.content();
  console.log("Page content length:", pageContent.length);
  
  // Take a screenshot of the current state
  await page.screenshot({ path: "before-layout-check.png" });
  console.log("Saved initial state screenshot as before-layout-check.png");
  
  // Try to find the disruptions list using both possible selectors
  let disruptedLines = [];
  let newLayout;
  try {
    // First try the new layout
    console.log("Attempting to find new layout...");
    
    // Wait for any of these elements to appear
    await Promise.race([
      page.waitForSelector(".disruptions-list", { timeout: 20000, visible: true }),
      page.waitForSelector("#tfl-status-tube", { timeout: 20000, visible: true }),
      page.waitForSelector("#rainbow-list-tube-dlr-overground-elizabeth-line-tram", { timeout: 20000, visible: true })
    ]);
    
    // Additional wait to ensure dynamic content is loaded
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check which layout we found
    const newLayoutElement = await page.$(".disruptions-list");
    if (newLayoutElement) {
      newLayout = true;
      console.log("Found new layout");
      disruptedLines = await page.evaluate(async () => {
        const lines = [];
        const accordions = document.querySelectorAll(".disruptions-list [data-testid='headles-accordion-root-testid']");
        console.log(`Found ${accordions.length} accordions in new layout`);
        
        for (const item of accordions) {
          const lineName = item.querySelector("[data-testid='accordion-name']")?.innerText.trim();
          const status = item.querySelector("[data-testid='line-status']")?.innerText.trim();
          
          if (lineName && status) {
            // Click the arrow to expand the details
            const trigger = item.querySelector(".CustomAccordion_triggerWrapper__kvoYn");
            if (trigger) {
              trigger.click();
              // Wait for the content to load
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Get the details from the panel
            const details = item.querySelector(".CustomAccordion_panel__vp6GJ")?.innerText.trim();
            
            lines.push({
              lineName,
              status,
              details: details || "No additional details available"
            });
          }
        }
        return Array.from(new Map(lines.map(line => [line.lineName, line])).values());
      });
    } else {
      throw new Error("New layout element not found after waiting");
    }
  } catch (error) {
    console.log("New layout not found, trying old layout = Error:", error.message);
    // If new layout fails, try the old layout
    try {
      console.log("Attempting to find old layout...");
      await page.waitForSelector("#rainbow-list-tube-dlr-overground-elizabeth-line-tram ul.rainbow-list > li.rainbow-list-item", { timeout: 20000 });
      newLayout = false;
      console.log("Found old layout");
      // Take screenshot of collapsed list before expanding any lines
      const section = await page.$("#rainbow-list-tube-dlr-overground-elizabeth-line-tram > ul");
      if (section) {
        await section.screenshot({ path: "disruptions.png" });
        console.log("Screenshot saved: disruptions.png");
      } else {
        await page.screenshot({ path: "disruptions.png" });
        console.log("Section not found, saved full page screenshot as disruptions.png");
      }
      // Extract details for each line by expanding one at a time (only for expandable lines)
      disruptedLines = [];
      const lineSelectors = await page.$$eval(
        "#rainbow-list-tube-dlr-overground-elizabeth-line-tram ul.rainbow-list > li.rainbow-list-item",
        items => items
          .map((item, idx) => {
            const btn = item.querySelector('.rainbow-list-link[role=button]');
            return btn ? `#rainbow-list-tube-dlr-overground-elizabeth-line-tram ul.rainbow-list > li.rainbow-list-item:nth-child(${idx + 1}) .rainbow-list-link[role=button]` : null;
          })
          .filter(Boolean)
      );
      for (const selector of lineSelectors) {
        // Expand the line
        await page.click(selector);
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait for content to load
        // Extract details for this line
        const lineData = await page.evaluate(sel => {
          const item = document.querySelector(sel)?.closest("li.rainbow-list-item");
          if (!item) return null;
          const lineName = item.querySelector(".service-name > span")?.innerText.trim();
          const status = item.querySelector(".disruption-summary > span")?.innerText.trim();
          let details = status;
          const expanded = item.querySelector(".rainbow-list-content[aria-labelledby]");
          if (expanded && expanded.offsetParent !== null) {
            const detailP = expanded.querySelector(".section p");
            if (detailP) details = detailP.innerText.trim();
          }
          if (lineName && status) {
            return { lineName, status, details: details || "No additional details available" };
          }
          return null;
        }, selector);
        if (lineData) disruptedLines.push(lineData);
        // Collapse the line (by clicking again)
        await page.click(selector);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      // No need to reload the page for screenshot anymore
      await page.waitForSelector("#rainbow-list-tube-dlr-overground-elizabeth-line-tram ul.rainbow-list > li.rainbow-list-item", { timeout: 5000 });
    } catch (error) {
      console.error("Failed to find either layout. Error:", error.message);
      await page.screenshot({ path: "error-layout.png" });
      console.log("Saved error screenshot as error-layout.png");
      throw new Error("Could not find disruptions list in either layout");
    }
  }
  
  console.log(`Found ${disruptedLines.length} total disrupted lines`);
  
  const affectedLines = disruptedLines.filter(line => 
    !["Good service", "Information", "Closure"].includes(line.status)
  );
  
  console.log(`Found ${affectedLines.length} affected lines after filtering`);
  
  if (affectedLines.length === 0) {
    console.log("No major disruptions.");
    await browser.close();
    
    // Send a message to Slack indicating no disruptions
    await sendNoDisruptionsMessage();
    return;
  }
  
  // Take screenshot of the correct element
  let screenshotTarget = newLayout
    ? "#tfl-status-tube"
    : "#rainbow-list-tube-dlr-overground-elizabeth-line-tram > ul";
  const section = await page.$(screenshotTarget);
  if (section) {
    await section.screenshot({ path: "disruptions.png" });
    console.log("Screenshot saved: disruptions.png");
  } else {
    // fallback to full page screenshot if section not found
    await page.screenshot({ path: "disruptions.png" });
    console.log("Section not found, saved full page screenshot as disruptions.png");
  }
  
  // Save JSON data
  fs.writeFileSync("disruptions.json", JSON.stringify(affectedLines, null, 2));
  console.log("Disruptions saved to disruptions.json");
  
  await browser.close();
  
  // Check if there are changes compared to previous disruptions
  const hasChanges = await checkForChanges(affectedLines);
  
  // Only send alert if there are changes
  if (hasChanges) {
    await sendAlertWithScreenshot(hasChanges === "update");
  } else {
    console.log("No changes in disruptions since last check. Skipping Slack notification.");
    // Optionally, you can send a log or a minimal notification here if needed
  }
  
  // Save current disruptions as previous for next comparison
  fs.writeFileSync(PREVIOUS_DISRUPTIONS_FILE, JSON.stringify(affectedLines, null, 2));
  console.log("Previous disruptions saved for future comparison");
}

async function checkForChanges(currentDisruptions) {
  try {
    // Check if previous disruptions file exists
    if (!fs.existsSync(PREVIOUS_DISRUPTIONS_FILE)) {
      console.log("No previous disruptions file found. This is the first run.");
      return "new";
    }
    
    // Read previous disruptions
    const previousDisruptions = JSON.parse(fs.readFileSync(PREVIOUS_DISRUPTIONS_FILE));
    
    // Compare current and previous disruptions
    if (JSON.stringify(currentDisruptions) === JSON.stringify(previousDisruptions)) {
      return false; // No changes
    }
    
    // Check if this is an update (some lines are the same, some are different)
    const currentLines = new Set(currentDisruptions.map(line => line.lineName));
    const previousLines = new Set(previousDisruptions.map(line => line.lineName));
    
    // If there are any lines in common, this is an update
    const hasCommonLines = [...currentLines].some(line => previousLines.has(line));
    
    return hasCommonLines ? "update" : "new";
  } catch (error) {
    console.error("Error comparing disruptions:", error);
    return "new"; // Default to sending a new message if there's an error
  }
}

async function sendAlertWithScreenshot(isUpdate = false) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
  const { WebClient } = require("@slack/web-api");
  
  if (!SLACK_BOT_TOKEN) {
    console.log("No Slack bot token configured.");
    return;
  }
  
  const slackClient = new WebClient(SLACK_BOT_TOKEN);
  let affectedLines;
  let slackUsers;
  
  try {
    affectedLines = JSON.parse(fs.readFileSync("disruptions.json"));
    slackUsers = JSON.parse(fs.readFileSync("slackUsers.json"));
  } catch (error) {
    console.error("Failed to read JSON files:", error);
    return;
  }
  
  if (!affectedLines.length) {
    console.log("No major disruptions to report.");
    return;
  }
  
  const message = affectedLines
    .map(line => {
      // Get users associated with this line
      let userMentions = "";
      if (slackUsers.lines[line.lineName] && 
          slackUsers.lines[line.lineName].users && 
          slackUsers.lines[line.lineName].users.length > 0) {
        userMentions = slackUsers.lines[line.lineName].users
          .filter(userId => userId && userId.trim() !== "")
          .map(userId => `<@${userId}>`)
          .join(" ");
      }
      
      // Only add user mentions if there are any
      return `🚨 *${line.lineName}*: ${line.status}\n📌 _${line.details}_${userMentions ? `\n${userMentions}` : ""}`;
    })
    .join("\n\n");
  
  try {
    // First send the text message
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: isUpdate ? "*UPDATE: TfL Status Alert:*" : "*TfL Status Alert:*",
      attachments: [{ text: message }],
    });

    // Check if screenshot exists and is non-empty before uploading
    const path = require('path');
    const screenshotPath = 'disruptions.png';
    console.log('Screenshot absolute path:', path.resolve(screenshotPath));
    if (!fs.existsSync(screenshotPath) || fs.statSync(screenshotPath).size === 0) {
      console.error('disruptions.png does not exist or is empty!');
    } else {
      console.log('disruptions.png exists and is non-empty.');
      // Then upload the screenshot with proper filename
      const response = await slackClient.files.uploadV2({
        channel_id: SLACK_CHANNEL,
        file: fs.createReadStream(screenshotPath),
        filename: 'tfl-disruptions.png',
        title: isUpdate ? 'TfL Disruptions Update Screenshot' : 'TfL Disruptions Screenshot',
      });
      console.log('Slack upload response:', response);
      // Send a follow-up message with the screenshot
      if (response && response.file) {
        await slackClient.chat.postMessage({
          channel: SLACK_CHANNEL,
          text: isUpdate ? "*UPDATE: TfL Status Alert Screenshot:*" : "*TfL Status Alert Screenshot:*",
          attachments: [{ 
            text: message,
            image_url: response.file.url_private 
          }],
        });
      }
    }

    console.log(`Disruption details and screenshot sent to Slack${isUpdate ? " (UPDATE)" : ""}`);
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

async function sendNoDisruptionsMessage() {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
  const { WebClient } = require("@slack/web-api");
  
  if (!SLACK_BOT_TOKEN) {
    console.log("No Slack bot token configured.");
    return;
  }
  
  const slackClient = new WebClient(SLACK_BOT_TOKEN);
  
  try {
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: "*TfL Status Update:*",
      attachments: [{
        text: "✅ All TfL lines are running with good service. No major disruptions reported.",
        color: "good"
      }]
    });
    console.log("No disruptions message sent to Slack");
  } catch (error) {
    console.error("Failed to send no disruptions message:", error);
  }
}

checkStatus();
