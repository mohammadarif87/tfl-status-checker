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

// Schedule times in UTC (24-hour format)
const SCHEDULE_TIMES = [
  { hour: 6, minute: 30, isFirstRun: true },   // 1st run - 06:30
  { hour: 7, minute: 0, isFirstRun: false },   // 2nd run - 07:00
  { hour: 8, minute: 0, isFirstRun: false },   // 3rd run - 08:00
  { hour: 15, minute: 30, isFirstRun: true },  // 4th run - 15:30 (evening first)
  { hour: 16, minute: 0, isFirstRun: false },  // 5th run - 16:00
  { hour: 16, minute: 30, isFirstRun: false }  // 6th run - 16:30
];

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
  metropolitan: '9B0058',
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

function getCurrentRunType() {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  
  // Find the closest matching schedule time (within 30 minutes)
  for (const schedule of SCHEDULE_TIMES) {
    const scheduleTime = schedule.hour * 60 + schedule.minute;
    const currentTime = currentHour * 60 + currentMinute;
    
    // Allow for up to 30 minutes after the scheduled time
    if (currentTime >= scheduleTime && currentTime <= scheduleTime + 30) {
      return {
        isFirstRun: schedule.isFirstRun,
        runNumber: SCHEDULE_TIMES.indexOf(schedule) + 1,
        scheduleTime: `${schedule.hour.toString().padStart(2, '0')}:${schedule.minute.toString().padStart(2, '0')}`
      };
    }
  }
  
  // Default to first run if no match found (for manual runs)
  return { isFirstRun: true, runNumber: 1, scheduleTime: 'manual' };
}

async function getDisruption(lineId) {
  const { data } = await axios.get(`https://api.tfl.gov.uk/Line/${lineId}/Disruption`);
  console.log("Checking disruption endpoint for", lineId);
  if (!data.length) return null;
  // If there are multiple disruptions, get unique descriptions and join them.
  const uniqueDescriptions = Array.from(new Set(data.map(d => d.description)));
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
      if (currentLine.details !== previousLine.details) {
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

async function main() {
  try {
    if (!SLACK_BOT_TFL_TOKEN || !SLACK_CHANNEL_TFL) {
      console.error("Slack bot token or channel is not set. Please check your .env file.");
      return;
    }

    const runInfo = getCurrentRunType();
    console.log(`Current run: ${runInfo.runNumber} (${runInfo.scheduleTime}) - First run: ${runInfo.isFirstRun}`);

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

    let shouldSendMessage = false;
    let messageTitle = '';
    let attachments = [];

    if (runInfo.isFirstRun) {
      // First run of morning/evening - send full update
      shouldSendMessage = true;
      messageTitle = currentAffectedLines.length > 0 ? "*TfL Tube Disruptions:*" : "*TfL Tube Status Update:*";
      
      if (currentAffectedLines.length === 0) {
        await slackClient.chat.postMessage({
          channel: SLACK_CHANNEL_TFL,
          text: `${messageTitle}\n\n✅ All lines are running with good service.`,
          mrkdwn: true
        });
        console.log('No disruptions message sent to Slack on first run.');
      } else {
        // Create attachments for all current disruptions with user mentions
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
    } else {
      // Subsequent runs - only show changes
      if (!fs.existsSync(PREVIOUS_DISRUPTIONS_FILE)) {
        console.log("No previous disruptions file found. Treating as first run.");
        shouldSendMessage = true;
        messageTitle = "*TfL Tube Disruptions:*";
      } else {
        const previousDisruptions = JSON.parse(fs.readFileSync(PREVIOUS_DISRUPTIONS_FILE));
        const changes = findDisruptionChanges(currentAffectedLines, previousDisruptions);
        
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
      await slackClient.chat.postMessage({
        channel: SLACK_CHANNEL_TFL,
        text: messageTitle,
        attachments: attachments,
        mrkdwn: true
      });
      console.log('TfL disruption update sent to Slack.');
    }

    // Save current disruptions as previous for next comparison
    fs.writeFileSync(PREVIOUS_DISRUPTIONS_FILE, JSON.stringify(currentAffectedLines, null, 2));
    console.log(`Previous disruptions saved to ${PREVIOUS_DISRUPTIONS_FILE} for future comparison`);

  } catch (err) {
    console.error('Error fetching or posting TfL status:', err);
  }
}

main();