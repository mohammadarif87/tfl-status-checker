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

  // Extract disrupted lines with valid bounding boxes
  const disruptedLines = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".rainbow-list-item"))
      .map((item) => {
        const lineName = item.querySelector(".service-name")?.innerText.trim();
        const status = item.querySelector(".disruption-summary")?.innerText.trim();
        const rect = item.getBoundingClientRect();
        if (lineName && status && status !== "Good service" && rect.width > 0 && rect.height > 0) {
          return { lineName, status, boundingBox: rect };
        }
        return null;
      })
      .filter(Boolean);
  });

  // If all lines are "Good service", send a message and exit
  if (disruptedLines.length === 0) {
    console.log("All lines are running fine.");
    await sendAlert("All lines are running fine.");
    await browser.close();
    return;
  }

  console.log("Disrupted lines:", disruptedLines);

  // Ensure valid screenshot dimensions
  if (disruptedLines.length > 0 && disruptedLines.some(line => line.boundingBox.width > 0 && line.boundingBox.height > 0)) {
    const clip = disruptedLines.reduce(
      (acc, line) => {
        acc.x = Math.min(acc.x, line.boundingBox.x);
        acc.y = Math.min(acc.y, line.boundingBox.y);
        acc.width = Math.max(acc.width, line.boundingBox.x + line.boundingBox.width - acc.x);
        acc.height = Math.max(acc.height, line.boundingBox.y + line.boundingBox.height - acc.y);
        return acc;
      },
      { x: Infinity, y: Infinity, width: 0, height: 0 }
    );

    if (clip.width > 0 && clip.height > 0) {
      await page.screenshot({ path: "disruptions.png", clip });
    } else {
      console.log("Invalid screenshot dimensions, skipping screenshot.");
    }
  } else {
    console.log("No valid disruptions found for screenshot.");
  }

  await browser.close();
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
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `TfL Status Alert:\n${messageText}`,
    });

    if (fs.existsSync("disruptions.png")) {
      const result = await slackClient.files.uploadV2({
        channel_id: SLACK_CHANNEL,
        file: fs.createReadStream("disruptions.png"),
        title: "TfL Status Update",
        initial_comment: `📸 Affected lines captured in screenshot.`,
      });
      console.log("Screenshot sent to Slack:", result.ok);
    }
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
