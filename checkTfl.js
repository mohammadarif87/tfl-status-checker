const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const TFL_URL = "https://tfl.gov.uk/tube-dlr-overground/status";
const PREVIOUS_DISRUPTIONS_FILE = "previous_disruptions.json";

async function checkStatus() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  });
  
  const page = await browser.newPage();
  
  // Set a longer default timeout for all operations
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);
  
  // Navigate to the page with increased timeout
  await page.goto(TFL_URL, { 
    waitUntil: "networkidle2",
    timeout: 60000
  });
  
  // Wait an additional 5 seconds to ensure the page is fully loaded
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
  await page.reload();
  console.log("Page Refreshed");

  // Wait to ensure the page is fully rendered without the cookie policy
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Wait for disruptions list
  await page.waitForSelector(".disruptions-list");
  
  // Extract disrupted lines
  const disruptedLines = await page.evaluate(async () => {
    const lines = [];
    const accordions = document.querySelectorAll(".disruptions-list [data-testid='headles-accordion-root-testid']");
    
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
    
    // Use a Map to remove duplicates (keys are line names)
    return Array.from(new Map(lines.map(line => [line.lineName, line])).values());
  });  
  
  const affectedLines = disruptedLines.filter(line => 
    !["Good service", "Information", "Closure"].includes(line.status)
  );
  
  if (affectedLines.length === 0) {
    console.log("No major disruptions.");
    await browser.close();
    
    // Send a message to Slack indicating no disruptions
    await sendNoDisruptionsMessage();
    return;
  }
  
  // Screenshot the disrupted section
  //const disruptionSection = await page.$("#tfl-status-tube-content");
  const disruptionSection = await page.$("#tfl-status-tube");
  //const disruptionSection = await page.$(".disruptions-list");
  if (disruptionSection) {
    //await page.evaluate(el => el.scrollIntoView(), disruptionSection);  // Ensure visibility
    await disruptionSection.screenshot({ path: "disruptions.png" });
    console.log("Screenshot saved: disruptions.png");
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
    
    // Then upload the screenshot with proper filename
    const response = await slackClient.files.uploadV2({
      channel_id: SLACK_CHANNEL,
      file: fs.createReadStream("disruptions.png"),
      filename: "tfl-disruptions.png",
      title: isUpdate ? "TfL Disruptions Update Screenshot" : "TfL Disruptions Screenshot",
    });
    
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
