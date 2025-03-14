const puppeteer = require('puppeteer');
const { WebClient } = require('@slack/web-api');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#your-channel';
const TFL_URL = 'https://tfl.gov.uk/tube-dlr-overground/status/';

const slack = new WebClient(SLACK_TOKEN);

(async () => {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    await page.goto(TFL_URL, { waitUntil: 'networkidle2' });

    // Extract disruption messages
    const disruptions = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.service-disruption'))
            .map(el => el.innerText.trim())
            .filter(text => /(Minor delays|Part suspended|Severe delays)/i.test(text)); // Filter only required statuses
    });

    // Remove duplicate messages
    const uniqueDisruptions = [...new Set(disruptions)];

    if (uniqueDisruptions.length > 0) {
        // Take a cropped screenshot
        const element = await page.$('.service-disruptions'); // Adjust selector if needed
        if (element) {
            await element.screenshot({ path: 'tfl_status.png' });
        }

        // Send Slack message
        const message = uniqueDisruptions.map(status => `:siren: ${status}`).join('\n');

        await slack.chat.postMessage({
            channel: SLACK_CHANNEL,
            text: `🚨 *TFL Disruptions* 🚨\n${message}`,
        });

        if (element) {
            await slack.files.upload({
                channels: SLACK_CHANNEL,
                file: require('fs').createReadStream('tfl_status.png'),
                title: 'TfL Status Screenshot',
            });
        }
    }

    await browser.close();
})();
