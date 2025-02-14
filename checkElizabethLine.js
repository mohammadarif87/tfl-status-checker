const puppeteer = require("puppeteer");
const axios = require("axios");
require("dotenv").config();

const TFL_URL = "https://tfl.gov.uk/tube-dlr-overground/status";

async function checkStatus() {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.goto(TFL_URL, { waitUntil: "networkidle2" });

  const status = await page.evaluate(() => {
    const elizabethLine = Array.from(document.querySelectorAll(".service"));
    for (let service of elizabethLine) {
      if (service.innerText.includes("Elizabeth line")) {
        return service.innerText.replace("Elizabeth line", "").trim();
      }
    }
    return "Unknown";
  });

  await browser.close();

  if (status !== "Good Service") {
    console.log(`Alert! Elizabeth Line status: ${status}`);
    await sendAlert(status);
  } else {
    console.log("Elizabeth Line is running fine.");
  }
}

async function sendAlert(status) {
  if (process.env.SLACK_WEBHOOK_URL) {
    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      text: `Elizabeth Line alert! Current status: ${status}`,
    });
  } else {
    console.log("No Slack webhook configured.");
  }
}

checkStatus();
