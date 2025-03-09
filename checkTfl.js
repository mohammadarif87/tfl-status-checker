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
    !["Good service", "Information", "Closure"].includes(line.status)
  );

  if (affectedLines.length === 0) {
    console.log("No major disruptions.");
    await browser.close();
    return;
  }

  // Extract disruption details by clicking each line's expand button
  for (const line of affectedLines) {
    const lineElementHandle = await page.evaluateHandle((lineName) => {
      return Array.from(document.querySelectorAll('.rainbow-list-item')).find(el => 
        el.innerText.includes(lineName)
      );
    }, line.lineName);

    if (lineElementHandle) {
      const expandButton = await lineElementHandle.$("button"); // Properly select button
      if (expandButton) {
        await expandButton.click();
        await page.waitForTimeout(1000);
        
        // Extract disruption details after expanding
        const details = await page.evaluate((lineName) => {
          const lineElement = Array.from(document.querySelectorAll(".rainbow-list-item"))
            .find(el => el.innerText.includes(lineName));
          if (!lineElement) return "No additional details.";
          const detailsElement = lineElement.querySelector(".disruption-details");
          return detailsElement ? detailsElement.innerText.trim() : "No additional details.";
        }, line.lineName);
    
        line.details = details;
      }
    }
    
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

  // Send the alert with details and screenshot
  await sendAlertWithDetails(affectedLines, screenshotPath);
}

async function sendAlertWithDetails(affectedLines, screenshotPath) {
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
    .map(line => `🚨 *${line.lineName}*: ${line.status}\n📌 ${line.details || "No additional details."}`)
    .join("\n\n");

  try {
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `*TfL Status Alert:*\n${message}`,
    });

    // Upload Screenshot with proper filename to fix Slack API warning
    const result = await slackClient.files.uploadV2({
      channel_id: SLACK_CHANNEL,
      file: fs.createReadStream(screenshotPath),
      filename: "tfl_disruptions.png", // Explicitly setting filename
      title: "TfL Disruptions",
      initial_comment: `📸 Affected lines captured in screenshot.`,
    });

    console.log("Disruption details & screenshot sent to Slack:", result.ok);
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

checkStatus();
