const puppeteer = require("puppeteer");
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

  for (const line of affectedLines) {
    // Find the specific line element
    const lineElementHandle = await page.evaluateHandle((lineName) => {
      return Array.from(document.querySelectorAll('.rainbow-list-item')).find(el =>
        el.innerText.includes(lineName)
      );
    }, line.lineName);

    if (lineElementHandle) {
      const expandButton = await lineElementHandle.$("button"); // Find the expand button inside the element
      if (expandButton) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Extract additional details after expanding
        line.details = await page.evaluate(el => {
          const detailsElement = el.querySelector(".disruption-details");
          return detailsElement ? detailsElement.innerText.trim() : "No additional details.";
        }, lineElementHandle);
      }
      await lineElementHandle.dispose(); // Free up resources
    }
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
    .map(line => `🚨 *${line.lineName}*: ${line.status}\n📌 ${line.details}`)
    .join("\n\n");

  try {
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `*TfL Status Alert:*
${message}`,
    });

    console.log("Disruption details sent to Slack");
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

checkStatus();
