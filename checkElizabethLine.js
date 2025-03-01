const puppeteer = require("puppeteer");
const axios = require("axios");
require("dotenv").config();

const TFL_URL = "https://tfl.gov.uk/tube-dlr-overground/status";

async function checkStatus() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

  // Try new selector
  await page.waitForSelector('#rainbow-list-tube-dlr-overground-elizabeth-line-tram > ul > li.rainbow-list-item.elizabeth');
  
  // Extract Piccadilly Line status
  const status = await page.evaluate(() => {
    const elizabethLine = document.querySelector('#rainbow-list-tube-dlr-overground-elizabeth-line-tram > ul > li.rainbow-list-item.elizabeth > div > span.disruption-summary');
    return elizabethLine ? elizabethLine.innerText.trim() : "Unknown";
  });

  console.log(`Extracted status: ${status}`);

  // Screenshot selector
const STATUS_SELECTOR = "#rainbow-list-tube-dlr-overground-elizabeth-line-tram";

// Take a screenshot of the status section
await page.waitForSelector(STATUS_SELECTOR, { timeout: 5000 });
await page.screenshot({ path: "tfl_status.png", clip: await page.$eval(STATUS_SELECTOR, el => {
  const { x, y, width, height } = el.getBoundingClientRect();
  return { x, y, width, height };
}) });


  await browser.close();

  if (status !== "Good service") {
    console.log(`Alert! Elizabeth Line status: ${status}`);
    await sendAlert(status);
  } else {
    console.log("Elizabeth Line is running fine.");
    await sendAlert(status); //debug
  }
}

async function sendAlert(status) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // Needed for file uploads
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "#general";

  const { WebClient } = require("@slack/web-api");
  const fs = require("fs");

  if (!SLACK_BOT_TOKEN) {
    console.log("No Slack bot token configured.");
    return;
  }

  const slackClient = new WebClient(SLACK_BOT_TOKEN);

  try {
    // Send status text
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `Elizabeth Line alert! Current status: ${status}`,
    });

    // Check file exists
    if (!fs.existsSync("tfl_status.png")) {
      console.error("Screenshot file not found!");
      return;
    }
    
    // Upload Screenshot
    const result = await slackClient.files.uploadV2({
      channel: SLACK_CHANNEL,
      file: fs.createReadStream("tfl_status.png"),
      filename: "tfl_status.png",
      title: "TfL Status Update",
      initial_comment: `Elizabeth Line alert! Current status: ${status}`,
    });

    console.log(`Sending to Slack channel: ${SLACK_CHANNEL}`);

    console.log("Screenshot sent to Slack:", result.ok);
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}


checkStatus();
