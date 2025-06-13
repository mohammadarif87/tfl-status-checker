const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');
require('dotenv').config();

const SLACK_BOT_TFL_TOKEN = process.env.SLACK_BOT_TFL_TOKEN ? process.env.SLACK_BOT_TFL_TOKEN.trim() : undefined;
const SLACK_CHANNEL_TFL = process.env.SLACK_CHANNEL_TFL ? process.env.SLACK_CHANNEL_TFL.trim() : undefined;

const CURRENT_DISRUPTIONS_FILE = "disruptions.json";
const PREVIOUS_DISRUPTIONS_FILE = "previous_disruptions.json";
const SLACK_USERS_FILE = "slackUsers.json";

// --- Debugging Start ---
console.log("SLACK_BOT_TFL_TOKEN from process.env (full, for debug only):", process.env.SLACK_BOT_TFL_TOKEN);
console.log("SLACK_BOT_TFL_TOKEN (trimmed, first 5 chars):", SLACK_BOT_TFL_TOKEN ? SLACK_BOT_TFL_TOKEN.substring(0, 5) : "Not set");
console.log("SLACK_CHANNEL_TFL (trimmed):", SLACK_CHANNEL_TFL || "Not set");
// --- Debugging End ---

const slackClient = new WebClient(SLACK_BOT_TFL_TOKEN);

const LINE_EMOJIS = {
  bakerloo: '🟤',
  central: '🔴',
  circle: '🟡',
  district: '🟢',
  'hammersmith-city': '🟣',
  jubilee: '⚫',
  metropolitan: '🟪',
  northern: '⬛',
  piccadilly: '🔵',
  victoria: '🔷',
  'waterloo-city': '⚪',
  dlr: '🚟',
  elizabeth: '🟪',
  liberty: '🟠',
  lioness: '🟠',
  mildmay: '🟠',
  suffragette: '🟠',
  weaver: '🟠',
  windrush: '🟠',
};

const LINE_COLORS = {
  bakerloo: '#B36305',
  central: '#E41D2D',
  circle: '#FFD300',
  district: '#00772D',
  'hammersmith-city': '#F3A9BB',
  jubilee: '#A1A5A7',
  metropolitan: '#79178E',
  northern: '#000000',
  piccadilly: '#00108A',
  victoria: '#00A0E2',
  'waterloo-city': '#93CEB5',
  dlr: '#00A4A7',
  elizabeth: '#6A22B3',
  liberty: '#FF8C00', // Overground orange
  lioness: '#FF8C00', // Overground orange
  mildmay: '#FF8C00', // Overground orange
  suffragette: '#FF8C00', // Overground orange
  weaver: '#FF8C00', // Overground orange
  windrush: '#FF8C00', // Overground orange
};

function getTubeLines() {
  const filePath = path.join(__dirname, 'tubeLines.json');
  console.log("Read tubeLines.json: SUCCESS");
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function getDisruption(lineId) {
  const { data } = await axios.get(`https://api.tfl.gov.uk/Line/${lineId}/Disruption`);
  console.log("Checking disruption endpoint for", lineId);
  if (!data.length) return null;
  // If there are multiple disruptions, get unique descriptions and join them.
  const uniqueDescriptions = Array.from(new Set(data.map(d => d.description)));
  return uniqueDescriptions.join(' | ');
}

async function checkForChanges(currentDisruptions) {
  try {
    if (!fs.existsSync(PREVIOUS_DISRUPTIONS_FILE)) {
      console.log("No previous disruptions file found. This is the first run.");
      return "new";
    }
    const previousDisruptions = JSON.parse(fs.readFileSync(PREVIOUS_DISRUPTIONS_FILE));
    if (JSON.stringify(currentDisruptions) === JSON.stringify(previousDisruptions)) {
      return false; // No changes
    }
    const currentLineIds = new Set(currentDisruptions.map(line => line.id));
    const previousLineIds = new Set(previousDisruptions.map(line => line.id));
    const hasCommonLines = [...currentLineIds].some(id => previousLineIds.has(id));
    return hasCommonLines ? "update" : "new";
  } catch (error) {
    console.error("Error comparing disruptions:", error);
    return "new"; // Default to sending a new message if there's an error
  }
}

async function main() {
  try {
    if (!SLACK_BOT_TFL_TOKEN || !SLACK_CHANNEL_TFL) {
      console.error("Slack bot token or channel is not set. Please check your .env file.");
      return;
    }

    const lines = getTubeLines();
    let slackUsers = {};
    try {
        slackUsers = JSON.parse(fs.readFileSync(SLACK_USERS_FILE, 'utf8'));
        console.log("Read slackUsers.json: SUCCESS");
    } catch (err) {
        console.error("Error reading slackUsers.json:", err.message);
        // Continue without user tagging if file is missing/corrupt
    }

    let currentAffectedLines = [];

    for (const line of lines) {
      const disruption = await getDisruption(line.id);
      if (disruption) {
        currentAffectedLines.push({ id: line.id, name: line.name, details: disruption });
      }
    }

    // Save current disruptions to file
    fs.writeFileSync(CURRENT_DISRUPTIONS_FILE, JSON.stringify(currentAffectedLines, null, 2));
    console.log(`Current disruptions saved to ${CURRENT_DISRUPTIONS_FILE}`);

    const hasChanges = await checkForChanges(currentAffectedLines);

    let attachments = [];
    let messageTitle = '';

    if (hasChanges) {
      messageTitle = hasChanges === "update" ? "*UPDATE: TfL Tube Disruptions:*" : "*TfL Tube Disruptions:*";
      for (const line of currentAffectedLines) {
        const emoji = LINE_EMOJIS[line.id] || '';
        const color = LINE_COLORS[line.id] || '#CCCCCC';
        
        let userMentions = "";
        if (slackUsers.lines && slackUsers.lines[line.id] && 
            slackUsers.lines[line.id].users && slackUsers.lines[line.id].users.length > 0) {
          userMentions = slackUsers.lines[line.id].users
            .filter(userId => userId && userId.trim() !== "")
            .map(userId => `<@${userId}>`)
            .join(" ");
        }

        let textContent = `${emoji} *${line.name}*\n${line.details}`;
        if (userMentions) {
          textContent += `\n${userMentions}`;
        }

        attachments.push({
          color: color,
          text: textContent,
          mrkdwn_in: ['text'],
        });
      }
    }

    if (hasChanges && attachments.length > 0) {
      await slackClient.chat.postMessage({
        channel: SLACK_CHANNEL_TFL,
        text: messageTitle,
        attachments: attachments,
        mrkdwn: true
      });
      console.log('TfL disruption details sent to Slack with colored lines.');
    } else if (hasChanges === "new" && attachments.length === 0) {
        // This case would be if it's the first run, and there are no disruptions
        await slackClient.chat.postMessage({
            channel: SLACK_CHANNEL_TFL,
            text: '*TfL Tube Status Update:*\n\n✅ All lines are running with good service.',
            mrkdwn: true
        });
        console.log('No disruptions message sent to Slack on first run.');
    } else if (hasChanges === false) {
      console.log("No changes in disruptions since last check. Skipping Slack notification.");
    }

    // Save current disruptions as previous for next comparison
    fs.writeFileSync(PREVIOUS_DISRUPTIONS_FILE, JSON.stringify(currentAffectedLines, null, 2));
    console.log(`Previous disruptions saved to ${PREVIOUS_DISRUPTIONS_FILE} for future comparison`);

  } catch (err) {
    console.error('Error fetching or posting TfL status:', err);
  }
}

main();