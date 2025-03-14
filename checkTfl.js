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
    return Array.from(document.querySelectorAll(".rainbow-list-item")).map((item) => {
      const lineText = item.innerText.trim(); // Get full text content
      const lines = lineText.split("\n").map(text => text.trim()).filter(Boolean); // Split by new lines
  
      if (lines.length < 2) return null; // Ensure at least a name and status exist
  
      const lineName = lines[0]; // First line is always the name
      const status = lines.slice(1).join(", "); // Join remaining text as status
      const lineId = item.getAttribute("id")?.replace("line-", ""); // Extract unique identifier
  
      return { lineName, status, lineId };
    }).filter(Boolean);
  });
  
  
  // console.log(disruptedLines);
  
  // Filter affected lines (excluding Good service, Information & Closure)
  const affectedLines = disruptedLines.filter(line => 
    !["Good service", "Information", "Closure"].includes(line.status)
  );
  
  // console.log("Extracted disrupted lines:", disruptedLines);

  if (affectedLines.length === 0) {
    console.log("No major disruptions.");
    await browser.close();
    return;
  }

  // Extract disruption details by navigating to each line's detailed URL
  for (const line of affectedLines) {
    const lineUrl = `${TFL_URL}/#line-${line.lineId}`;
    await page.goto(lineUrl, { waitUntil: "networkidle2" });

    // Wait for content to load
    await page.waitForSelector(".rainbow-list-content", { timeout: 5000 }).catch(() => null);

    // Extract additional details
    const details = await page.evaluate(() => {
      const contentElement = document.querySelector(".rainbow-list-content");
      if (!contentElement) return "No additional details.";
      
      // Get all sections within the content area
      const sections = Array.from(contentElement.querySelectorAll(".section"));
      
      // Pick the section that does not include the 'Replan your journey' button text
      const disruptionSection = sections.find(section => 
        !section.innerText.includes("Replan your journey")
      );

      return disruptionSection ? disruptionSection.innerText.trim() : "No additional details.";
    });

    line.details = details;
  }

  await browser.close();

  // Send the alert with details
  await sendAlertWithDetails(affectedLines);
}

async function sendAlertWithDetails(affectedLines) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

  const { WebClient } = require("@slack/web-api");

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

    console.log("Disruption details sent to Slack");
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

checkStatus();
