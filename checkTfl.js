const puppeteer = require("puppeteer");
const axios = require("axios");
require("dotenv").config();

const TFL_URL = "https://tfl.gov.uk/tube-dlr-overground/status";

async function checkStatus() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
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
      .filter(item => item.closest("#rainbow-list-tube-dlr-overground-elizabeth-line-tram")) // Ensure it's a tube line
      .map((item) => {  
        const lineText = item.innerText.trim();
        const lines = lineText.split("\n").map(text => text.trim()).filter(Boolean);
        if (lines.length < 2) return null;

        const lineName = lines[0];
        const status = lines.slice(1).join(", ");
        const lineId = item.getAttribute("id")?.replace("line-", "");

        return { lineName, status, lineId, element: item };
      })
      .filter(Boolean);
  });

  // Remove duplicate disruptions for the same line
  const uniqueDisruptions = disruptedLines.reduce((acc, line) => {
    if (!acc.some(existing => existing.lineName === line.lineName)) {
      acc.push(line);
    }
    return acc;
  }, []);


  // Filter affected lines (excluding Good service, Information & Closure)
  const affectedLines = uniqueDisruptions.filter(line => 
    !["Good service", "Information", "Closure"].includes(line.status)
  );

  if (affectedLines.length === 0) {
    console.log("No major disruptions.");
    await browser.close();
    return;
  }

  // Capture cropped screenshot of only affected lines
  const boundingBoxes = await Promise.all(
    affectedLines.map(async (line) => {
      const element = await page.$(`#line-${line.lineId}`);
      return element ? await element.boundingBox() : null;
    })
  );

  const validBoxes = boundingBoxes.filter(box => box !== null);
  if (validBoxes.length > 0) {
    const minY = Math.min(...validBoxes.map(box => box.y));
    const maxY = Math.max(...validBoxes.map(box => box.y + box.height));
    const screenshotRegion = {
      x: 0,
      y: minY,
      width: 800,
      height: maxY - minY,
    };
    await page.screenshot({ path: "disruptions.png", clip: screenshotRegion });
  }

  // Extract disruption details
  for (const line of affectedLines) {
    const lineUrl = `${TFL_URL}/#line-${line.lineId}`;
    await page.goto(lineUrl, { waitUntil: "networkidle2" });
    await page.waitForSelector(".rainbow-list-content", { timeout: 5000 }).catch(() => null);
    const details = await page.evaluate(() => {
      const contentElement = document.querySelector(".rainbow-list-content");
      if (!contentElement) return "No additional details.";
      const sections = Array.from(contentElement.querySelectorAll(".section"));
      const disruptionSection = sections.find(section => 
        !section.innerText.includes("Replan your journey")
      );
      return disruptionSection ? disruptionSection.innerText.trim() : "No additional details.";
    });
    line.details = details;
  }

  await browser.close();
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

  const uniqueLines = [];
  const message = affectedLines
  .filter(line => {
    if (!uniqueLines.includes(line.lineName)) {
      uniqueLines.push(line.lineName);
      return true;
    }
    return false;
  })
  .map(line => `🚨 *${line.lineName}*: ${line.status}\n📌 ${line.details || "No additional details."}`)
  .join("\n\n");

  try {
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: "*TfL Status Alert:*",
      attachments: [
        {
          text: message,
          image_url: "disruptions.png"
        }
      ]
    });
    console.log("Disruption details sent to Slack");
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

checkStatus();