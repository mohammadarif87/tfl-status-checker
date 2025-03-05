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

  // Extract disrupted lines
  const disruptedLines = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".rainbow-list-item"))
      .map((item) => {
        const lineName = item.querySelector(".service-name")?.innerText.trim();
        const status = item.querySelector(".disruption-summary")?.innerText.trim();
        return lineName && status ? { lineName, status } : null;
      })
      .filter(Boolean);
  });

  // Filter affected lines (excluding Good Service & Information)
  const affectedLines = disruptedLines.filter(line => 
    !["Good Service", "Information"].includes(line.status)
  );

  if (affectedLines.length === 0) {
    console.log("No major disruptions.");
    await browser.close();
    return;
  }

  // Fetch bounding boxes separately using Puppeteer API
  const boundingBoxes = [];
  for (const line of affectedLines) {
    const element = await page.evaluateHandle((lineName) => {
      return Array.from(document.querySelectorAll('.rainbow-list-item'))
        .find(el => el.innerText.includes(lineName));
    }, line.lineName);    
    if (element) {
      const box = await element.boundingBox();
      if (box) boundingBoxes.push(box);
    }
  }

  // Calculate the clip area based on bounding boxes
  const clip = boundingBoxes.reduce(
    (acc, box) => ({
      x: Math.min(acc.x, box.x),
      y: Math.min(acc.y, box.y),
      width: Math.max(acc.width, box.x + box.width - acc.x),
      height: Math.max(acc.height, box.y + box.height - acc.y),
    }),
    { x: Infinity, y: Infinity, width: 0, height: 0 }
  );

  // Take a screenshot only of the affected area
  const screenshotPath = "tfl_disruptions.png";
  await page.screenshot({ path: screenshotPath, type: "png", clip });

  await browser.close();

  // Send the alert with the screenshot
  await sendAlertWithScreenshot(affectedLines, screenshotPath);
}

async function sendAlertWithScreenshot(affectedLines, screenshotPath) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

  const { WebClient } = require("@slack/web-api");
  const fs = require("fs");

  if (!SLACK_BOT_TOKEN) {
    console.log("No Slack bot token configured.");
    return;
  }

  const slackClient = new WebClient(SLACK_BOT_TOKEN);

  const message = affectedLines
    .map(line => `:siren: *${line.lineName}*: ${line.status}`)
    .join("\n");

  try {
    // Send status text
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `*TfL Status Alert:*\n${message}`,
    });

    // Upload Screenshot
    const result = await slackClient.files.uploadV2({
      channel_id: SLACK_CHANNEL,
      file: fs.createReadStream(screenshotPath),
      title: "TfL Disruptions",
      initial_comment: `📸 Affected lines captured in screenshot.`,
    });

    console.log("Screenshot sent to Slack:", result.ok);
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

checkStatus();
