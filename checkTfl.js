const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const TFL_URL = "https://tfl.gov.uk/tube-dlr-overground/status";

async function checkStatus() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  });
  
  const page = await browser.newPage();
  await page.goto(TFL_URL, { waitUntil: "networkidle2" });
  
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
  await sendAlertWithScreenshot();
}

async function sendAlertWithScreenshot() {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
  const { WebClient } = require("@slack/web-api");
  
  if (!SLACK_BOT_TOKEN) {
    console.log("No Slack bot token configured.");
    return;
  }
  
  const slackClient = new WebClient(SLACK_BOT_TOKEN);
  let affectedLines;
  try {
    affectedLines = JSON.parse(fs.readFileSync("disruptions.json"));
  } catch (error) {
    console.error("Failed to read disruptions.json:", error);
    return;
  }
  
  if (!affectedLines.length) {
    console.log("No major disruptions to report.");
    return;
  }
  
  const message = affectedLines
    .map(line => `🚨 *${line.lineName}*: ${line.status}\n📌 _${line.details}_`)
    .join("\n\n");
  
  try {
    // First send the text message
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: "*TfL Status Alert:*",
      attachments: [{ text: message }],
    });
    
    // Then upload the screenshot with proper filename
    const response = await slackClient.files.uploadV2({
      channel_id: SLACK_CHANNEL,
      file: fs.createReadStream("disruptions.png"),
      filename: "tfl-disruptions.png",
      title: "TfL Disruptions Screenshot",
    });
    
    // Send a follow-up message with the screenshot
    if (response && response.file) {
      await slackClient.chat.postMessage({
        channel: SLACK_CHANNEL,
        text: "*TfL Status Alert Screenshot:*",
        attachments: [{ 
          text: message,
          image_url: response.file.url_private 
        }],
      });
    }
    
    console.log("Disruption details and screenshot sent to Slack");
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

checkStatus();
