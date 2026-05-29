const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');
require('dotenv').config();

const SLACK_BOT_TFL_TOKEN = process.env.SLACK_BOT_TFL_TOKEN
const SLACK_CHANNEL_TFL = process.env.SLACK_CHANNEL_TFL

const CURRENT_DISRUPTIONS_FILE = "disruptions.json";
const PREVIOUS_DISRUPTIONS_FILE = "previous_disruptions.json";
const SLACK_USERS_FILE = "slackUsers.json";
// From workflow; 1 means first run of the block (morning or evening)
const RUN_SLOT = Number(process.env.RUN_SLOT || '1');
const BLOCK = process.env.BLOCK || 'unknown';
const SCHEDULE_NOTE = (process.env.SCHEDULE_NOTE || '').trim();

const slackClient = new WebClient(SLACK_BOT_TFL_TOKEN);

const LINE_EMOJIS = {
  bakerloo: ':bakerloo:',
  central: ':central:',
  circle: ':circle:',
  district: ':district:',
  'hammersmith-city': ':hammersmith-city:',
  jubilee: ':jubilee:',
  metropolitan: ':metropolitan:',
  northern: ':northern:',
  piccadilly: ':piccadilly:',
  victoria: ':victoria:',
  'waterloo-city': ':waterloo-city:',
  dlr: ':dlr:',
  elizabeth: ':elizabeth:',
  liberty: ':overground:',
  lioness: ':overground:',
  mildmay: ':overground:',
  suffragette: ':overground:',
  weaver: ':overground:',
  windrush: ':overground:',
};

const LINE_COLORS = {
  bakerloo: '#B26300',
  central: '#DC241F',
  circle: '#FFD329',
  district: '#007229',
  'hammersmith-city': '#F4A9BE',
  jubilee: '#A1A5A7',
  metropolitan: '#9B0058',
  northern: '#000000',
  piccadilly: '#0019A8',
  victoria: '#00A0E2',
  'waterloo-city': '#93CEBA',
  dlr: '#00A4A7',
  elizabeth: '#7156A5',
  liberty: '#EE7d11', // Overground orange
  lioness: '#EE7d11', // Overground orange
  mildmay: '#EE7d11', // Overground orange
  suffragette: '#EE7d11', // Overground orange
  weaver: '#EE7d11', // Overground orange
  windrush: '#EE7d11', // Overground orange
};

function getTubeLines() {
  const filePath = path.join(__dirname, 'tubeLines.json');
  console.log("Read tubeLines.json: SUCCESS");
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeDetailsText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ') // collapse whitespace
    .replace(/\s*\|\s*/g, ' | ') // standardize separator spacing
    .trim();
}

function getCurrentBlock() {
  // Use the BLOCK from environment if available, otherwise calculate
  if (BLOCK && BLOCK !== 'unknown') {
    return BLOCK;
  }
  const hour = new Date().getUTCHours();
  return hour < 12 ? 'morning' : 'evening';
}

function buildSlackRunFooter() {
  const when = new Date();
  const london = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(when);
  const utc = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(when);
  const slot =
    BLOCK !== 'unknown' && Number.isFinite(RUN_SLOT) && RUN_SLOT >= 1
      ? ` · ${BLOCK} ${RUN_SLOT}/3`
      : '';
  // Footer "Sent" time is when the message is posted (after queue + npm + API calls).
  // SCHEDULE_NOTE (from github.event.schedule) is GitHub's intended cron slot.
  const scheduled = SCHEDULE_NOTE
    ? `${SCHEDULE_NOTE} · `
    : '';
  return `\n_${scheduled}Sent: ${london}${slot} · ${utc}_`;
}

function loadPreviousState() {
  if (!fs.existsSync(PREVIOUS_DISRUPTIONS_FILE)) {
    return { disruptions: [], metadata: null };
  }
  try {
    const raw = fs.readFileSync(PREVIOUS_DISRUPTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { disruptions: parsed, metadata: null };
    }
    if (parsed && Array.isArray(parsed.disruptions)) {
      return { disruptions: parsed.disruptions, metadata: parsed.metadata || null };
    }
    return { disruptions: [], metadata: null };
  } catch (_e) {
    return { disruptions: [], metadata: null };
  }
}

function saveCurrentState(disruptions) {
  const state = {
    metadata: {
      date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
      block: getCurrentBlock(),
      slot: RUN_SLOT
    },
    disruptions
  };
  fs.writeFileSync(CURRENT_DISRUPTIONS_FILE, JSON.stringify(disruptions, null, 2));
  fs.writeFileSync(PREVIOUS_DISRUPTIONS_FILE, JSON.stringify(state, null, 2));
}

async function getDisruption(lineId) {
  const { data } = await axios.get(`https://api.tfl.gov.uk/Line/${lineId}/Disruption`);
  console.log("Checking disruption endpoint for", lineId);
  if (!data.length) return null;
  // If there are multiple disruptions, dedupe, trim and sort for stable ordering
  const uniqueDescriptions = Array.from(new Set(
    data
      .map(d => (d && d.description ? String(d.description) : ''))
      .map(s => s.trim())
      .filter(Boolean)
  ));
  uniqueDescriptions.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return uniqueDescriptions.join(' | ');
}



function findDisruptionChanges(currentDisruptions, previousDisruptions) {
  const changes = {
    newLines: [],
    resolvedLines: [],
    updatedLines: [],
    unchangedLines: []
  };

  const currentMap = new Map(currentDisruptions.map(line => [line.id, line]));
  const previousMap = new Map(previousDisruptions.map(line => [line.id, line]));

  // Find new and updated lines
  for (const [lineId, currentLine] of currentMap) {
    if (!previousMap.has(lineId)) {
      changes.newLines.push(currentLine);
    } else {
      const previousLine = previousMap.get(lineId);
      const currNorm = normalizeDetailsText(currentLine.details);
      const prevNorm = normalizeDetailsText(previousLine.details);
      if (currNorm !== prevNorm) {
        changes.updatedLines.push(currentLine);
      } else {
        changes.unchangedLines.push(currentLine);
      }
    }
  }

  // Find resolved lines
  for (const [lineId, previousLine] of previousMap) {
    if (!currentMap.has(lineId)) {
      changes.resolvedLines.push(previousLine);
    }
  }

  return changes;
}

function addFullDisruptionAttachments(attachments, affectedLines, slackUsers) {
  for (const line of affectedLines) {
    const emoji = LINE_EMOJIS[line.id] || '';
    const color = LINE_COLORS[line.id] || '#CCCCCC';
    let userMentions = '';
    if (slackUsers.lines && slackUsers.lines[line.id] &&
        slackUsers.lines[line.id].users && slackUsers.lines[line.id].users.length > 0) {
      userMentions = slackUsers.lines[line.id].users
        .filter(userId => userId && userId.trim() !== '')
        .map(userId => `<@${userId}>`)
        .join(' ');
    }
    let textContent = `${emoji} *${line.name}*\n${line.details}`;
    if (userMentions) {
      textContent += `\n${userMentions}`;
    }
    attachments.push({
      color,
      text: textContent,
      mrkdwn_in: ['text'],
    });
  }
}

async function main() {
  try {
    if (!SLACK_BOT_TFL_TOKEN || !SLACK_CHANNEL_TFL) {
      console.error("Slack bot token or channel is not set. Please check your .env file.");
      return;
    }
    const isFirstRun = RUN_SLOT === 1;
    console.log(`RUN_SLOT=${RUN_SLOT}, BLOCK=${BLOCK} -> isFirstRun=${isFirstRun}`);

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

    // Debug: Log the raw API data collected
    console.log('=== RAW API DATA COLLECTED ===');
    console.log(JSON.stringify(currentAffectedLines, null, 2));
    console.log('=== END RAW API DATA ===');

    // Save current disruptions snapshot for visibility
    fs.writeFileSync(CURRENT_DISRUPTIONS_FILE, JSON.stringify(currentAffectedLines, null, 2));
    console.log(`Current disruptions saved to ${CURRENT_DISRUPTIONS_FILE}`);

    let shouldSendMessage = false;
    let messageTitle = '';
    let attachments = [];
    const runFooter = buildSlackRunFooter();

    if (isFirstRun) {
      // First run of morning/evening - send full update (single postMessage below)
      shouldSendMessage = true;
      messageTitle = currentAffectedLines.length > 0 ? "*TfL Tube Disruptions:*" : "*TfL Tube Status Update:*";
      if (currentAffectedLines.length > 0) {
        addFullDisruptionAttachments(attachments, currentAffectedLines, slackUsers);
      }
    } else {
      // Subsequent runs - only show changes
      const previousState = loadPreviousState();
      
      if (previousState.disruptions.length === 0) {
        // Slots 2/3 (or cache miss): no snapshot to diff — send same shape as slot 1
        console.log('No previous disruptions found. Treating as first run for Slack content.');
        shouldSendMessage = true;
        if (currentAffectedLines.length === 0) {
          messageTitle = "*TfL Tube Status Update:*";
        } else {
          messageTitle = "*TfL Tube Disruptions:*";
          addFullDisruptionAttachments(attachments, currentAffectedLines, slackUsers);
        }
      } else {
        const changes = findDisruptionChanges(currentAffectedLines, previousState.disruptions);
        
        // Debug: Log the change detection results
        console.log('=== CHANGE DETECTION RESULTS ===');
        console.log('New lines:', changes.newLines.map(l => l.name));
        console.log('Updated lines:', changes.updatedLines.map(l => l.name));
        console.log('Resolved lines:', changes.resolvedLines.map(l => l.name));
        console.log('Unchanged lines:', changes.unchangedLines.map(l => l.name));
        console.log('=== END CHANGE DETECTION ===');
        
        const hasChanges = changes.newLines.length > 0 || changes.resolvedLines.length > 0 || changes.updatedLines.length > 0;
        
        if (hasChanges) {
          shouldSendMessage = true;
          messageTitle = "*UPDATE: TfL Tube Disruptions:*";
          
          // Add attachments for new lines (with user mentions)
          for (const line of changes.newLines) {
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

            let textContent = `🆕 ${emoji} *${line.name}* (NEW DISRUPTION)\n${line.details}`;
            if (userMentions) {
              textContent += `\n${userMentions}`;
            }

            attachments.push({
              color: color,
              text: textContent,
              mrkdwn_in: ['text'],
            });
          }
          
          // Add attachments for updated lines (with user mentions)
          for (const line of changes.updatedLines) {
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

            let textContent = `🔄 ${emoji} *${line.name}* (UPDATED)\n${line.details}`;
            if (userMentions) {
              textContent += `\n${userMentions}`;
            }

            attachments.push({
              color: color,
              text: textContent,
              mrkdwn_in: ['text'],
            });
          }
          
          // Add resolved lines info (no user mentions)
          for (const line of changes.resolvedLines) {
            const emoji = LINE_EMOJIS[line.id] || '';
            const color = '#28a745'; // Green for resolved
            
            attachments.push({
              color: color,
              text: `✅ ${emoji} *${line.name}* (RESOLVED)`,
              mrkdwn_in: ['text'],
            });
          }
          
          // Add summary of unchanged lines (no user mentions)
          if (changes.unchangedLines.length > 0) {
            const unchangedNames = changes.unchangedLines.map(line => {
              const emoji = LINE_EMOJIS[line.id] || '';
              return `${emoji} ${line.name}`;
            }).join(', ');
            
            attachments.push({
              color: '#ffc107', // Yellow for ongoing
              text: `ℹ️ *Still affected (${changes.unchangedLines.length} lines):* ${unchangedNames}`,
              mrkdwn_in: ['text'],
            });
          }
        } else {
          console.log("No changes in disruptions since last check. Skipping Slack notification.");
        }
      }
    }

    if (shouldSendMessage && (attachments.length > 0 || currentAffectedLines.length === 0)) {
      // Debug: Log the final message that will be sent
      console.log('=== FINAL SLACK MESSAGE ===');
      console.log('Title:', messageTitle);
      console.log('Attachments:', JSON.stringify(attachments, null, 2));
      console.log('=== END FINAL SLACK MESSAGE ===');

      const slackText =
        attachments.length === 0 && currentAffectedLines.length === 0
          ? `${messageTitle}\n\n✅ All lines are running with good service.${runFooter}`
          : `${messageTitle}${runFooter}`;

      await slackClient.chat.postMessage({
        channel: SLACK_CHANNEL_TFL,
        text: slackText,
        attachments: attachments,
        mrkdwn: true
      });
      console.log('TfL disruption update sent to Slack.');
    }

    // Save state for next comparison
    saveCurrentState(currentAffectedLines);
    console.log(`State saved to ${PREVIOUS_DISRUPTIONS_FILE} for future comparison`);

  } catch (err) {
    console.error('Error fetching or posting TfL status:', err);
  }
}

main();