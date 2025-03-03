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

  // Wait for the status list
  await page.waitForSelector("#rainbow-list-tube-dlr-overground-elizabeth-line-tram");

  // Extract statuses
  const disruptedLines = await page.evaluate(() => {
    const lines = [];
    document.querySelectorAll(".rainbow-list-item").forEach((item) => {
      const lineName = item.querySelector(".service-name")?.innerText.trim();
      const status = item.querySelector(".disruption-summary")?.innerText.trim();
      if (lineName && status && status !== "Good service") {
        lines.push({ lineName, status, element: item });
      }
    });
    return lines;
  });

  // If all lines are "Good service", just send text and exit
  if (disruptedLines.length === 0) {
    console.log("All lines are running fine.");
    await sendAlert("All lines are running fine.");
    await browser.close();
    return;
  }

  console.log("Disrupted lines:", disruptedLines);

  // Capture only the affected lines in a screenshot
  const clip = await page.evaluate((lines) => {
    const rects = lines.map((line) => {
      const { x, y, width, height } = line.element.getBoundingClientRect();
      return { x, y, width, height };
    });

    // Get the bounding box that contains all affected lines
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const width = Math.max(...rects.map((r) => r.x + r.width)) - x;
    const height = Math.max(...rects.map((r) => r.y + r.height)) - y;

    return { x, y, width, height };
  }, disruptedLines);

  await page.screenshot({ path: "disruptions.png", clip });

  await browser.close();

  // Send the alert with the screenshot
  await sendAlertWithScreenshot(disruptedLines);
}

async function sendAlertWithScreenshot(disruptedLines) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

  const { WebClient } = require("@slack/web-api");
  const fs = require("fs");

  if (!SLACK_BOT_TOKEN) {
    console.log("No Slack bot token configured.");
    return;
  }

  const slackClient = new WebClient(SLACK_BOT_TOKEN);

  const messageText = disruptedLines
    .map((line) => `🚨 ${line.lineName}: ${line.status}`)
    .join("\n");

  try {
    // Send status text
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `TfL Status Alert:\n${messageText}`,
    });

    // Upload Screenshot
    const result = await slackClient.files.uploadV2({
      channel_id: SLACK_CHANNEL,
      file: fs.createReadStream("disruptions.png"),
      title: "TfL Status Update",
      initial_comment: `📸 Affected lines captured in screenshot.`,
    });

    console.log("Screenshot sent to Slack:", result.ok);
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

async function sendAlert(message) {
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
      text: message,
    });
    console.log("Message sent to Slack.");
  } catch (error) {
    console.error("Failed to send message:", error);
  }
}

checkStatus();
