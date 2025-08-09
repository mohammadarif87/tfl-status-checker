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

const slackClient = new WebClient(SLACK_BOT_TFL_TOKEN);

const LINE_EMOJIS = {
  // TfL Lines
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
  // National Rail Lines
  'avanti-west-coast': ':nationalrail:',
  'c2c': ':nationalrail:',
  'chiltern-railways': ':nationalrail:',
  'crosscountry': ':nationalrail:',
  'east-midlands-railway': ':nationalrail:',
  'gatwick-express': ':nationalrail:',
  'grand-central': ':nationalrail:',
  'greater-anglia': ':nationalrail:',
  'great-northern': ':nationalrail:',
  'great-western-railway': ':nationalrail:',
  'heathrow-express': ':nationalrail:',
  'hull-trains': ':nationalrail:',
  'london-north-eastern-railway': ':nationalrail:',
  'lumo': ':nationalrail:',
  'merseyrail': ':nationalrail:',
  'northern-rail': ':nationalrail:',
  'scotrail': ':nationalrail:',
  'southeastern': ':nationalrail:',
  'southern': ':nationalrail:',
  'south-western-railway': ':nationalrail:',
  'thameslink': ':nationalrail:',
  'transpennine-express': ':nationalrail:',
  'transport-for-wales': ':nationalrail:',
  'west-midlands-trains': ':nationalrail:',
  'stansted-express': ':nationalrail:',
  'london-northwestern-railway': ':nationalrail:'
};

const LINE_COLORS = {
  // TfL Lines
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
  // National Rail Lines - using a consistent color for all national rail lines
  'avanti-west-coast': '#013365',
  'c2c': '#013365',
  'chiltern-railways': '#013365',
  'crosscountry': '#013365',
  'east-midlands-railway': '#013365',
  'gatwick-express': '#013365',
  'grand-central': '#013365',
  'greater-anglia': '#013365',
  'great-northern': '#013365',
  'great-western-railway': '#013365',
  'heathrow-express': '#013365',
  'hull-trains': '#013365',
  'london-north-eastern-railway': '#013365',
  'lumo': '#013365',
  'merseyrail': '#013365',
  'northern-rail': '#013365',
  'scotrail': '#013365',
  'southeastern': '#013365',
  'southern': '#013365',
  'south-western-railway': '#013365',
  'thameslink': '#013365',
  'transpennine-express': '#013365',
  'transport-for-wales': '#013365',
  'west-midlands-trains': '#013365',
  'stansted-express': '#013365',
  'london-northwestern-railway': '#013365'
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getTubeLines() {
  const filePath = path.join(__dirname, 'tubeLines.json');
  console.log("Read tubeLines.json: SUCCESS");
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getNationalRailLines() {
  const filePath = path.join(__dirname, 'nationalRailLines.json');
  console.log("Read nationalRailLines.json: SUCCESS");
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function getDisruption(lineId) {
  try {
    const { data } = await axios.get(`https://api.tfl.gov.uk/Line/${lineId}/Disruption`);
    console.log("Checking disruption endpoint for", lineId);
    if (!data.length) return null;
    // If there are multiple disruptions, get unique descriptions and join them.
    const uniqueDescriptions = Array.from(new Set(data.map(d => d.description)));
    return uniqueDescriptions.join(' | ');
  } catch (error) {
    if (error.response && error.response.status === 429) {
      console.log(`Rate limited for ${lineId}, waiting 3 seconds...`);
      await delay(3000);
      // Retry once
      try {
        const { data } = await axios.get(`https://api.tfl.gov.uk/Line/${lineId}/Disruption`);
        console.log("Retry successful for", lineId);
        if (!data.length) return null;
        const uniqueDescriptions = Array.from(new Set(data.map(d => d.description)));
        return uniqueDescriptions.join(' | ');
      } catch (retryError) {
        console.error(`Retry failed for ${lineId}:`, retryError.message);
        return null;
      }
    } else {
      console.error(`Error checking disruption for ${lineId}:`, error.message);
      return null;
    }
  }
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

async function getNationalRailDisruptions() {
  try {
    console.log("Fetching National Rail disruptions from website...");
    const response = await axios.get('https://www.nationalrail.co.uk/status-and-disruptions/?mode=train-operator-status', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const html = response.data;
    const disruptions = [];

    // Try multiple parsing approaches to handle different data structures
    
    // Approach 1: Look for complete operator objects
    let operatorObjectPattern = /"operatorName":"([^"]+)","operatorCode":"([^"]+)","twitterHandle":"([^"]+)"[^}]*"status":"([^"]+)"[^}]*"customStatusDescription":"([^"]*)"[^}]*"statusColourIcon":"([^"]*)"/g;
    let match;
    let count = 0;
    
    while ((match = operatorObjectPattern.exec(html)) !== null) {
      const operator = match[1];
      const status = match[4];
      const customStatus = match[5];
      
      if (status !== 'Good service' && customStatus && customStatus.trim() !== '') {
        const operatorId = getOperatorId(operator);
        if (operatorId) {
          disruptions.push({
            id: operatorId,
            name: operator,
            details: customStatus
          });
          count++;
        }
      }
    }
    
    // If Approach 1 didn't work, try Approach 2: Extract and match arrays
    if (count === 0) {
      console.log("Trying alternative parsing approach...");
      
      const operatorNames = [];
      const operatorNameMatches = html.match(/"operatorName":"([^"]+)"/g);
      if (operatorNameMatches) {
        operatorNameMatches.forEach(match => {
          const operator = match.match(/"operatorName":"([^"]+)"/)[1];
          operatorNames.push(operator);
        });
      }
      
      const statuses = [];
      const statusMatches = html.match(/"status":"([^"]+)"/g);
      if (statusMatches) {
        statusMatches.forEach(match => {
          const status = match.match(/"status":"([^"]+)"/)[1];
          statuses.push(status);
        });
      }
      
      const customStatuses = [];
      const customStatusMatches = html.match(/"customStatusDescription":"([^"]*)"/g);
      if (customStatusMatches) {
        customStatusMatches.forEach(match => {
          const customStatus = match.match(/"customStatusDescription":"([^"]*)"/)[1];
          customStatuses.push(customStatus);
        });
      }
      
      // Match by index (less reliable but might work)
      for (let i = 0; i < Math.min(operatorNames.length, statuses.length, customStatuses.length); i++) {
        const operator = operatorNames[i];
        const status = statuses[i];
        const customStatus = customStatuses[i];
        
        if (status !== 'Good service' && customStatus && customStatus.trim() !== '') {
          const operatorId = getOperatorId(operator);
          if (operatorId) {
            disruptions.push({
              id: operatorId,
              name: operator,
              details: customStatus
            });
            count++;
          }
        }
      }
    }
    
    console.log(`Found ${count} National Rail disruptions`);
    return disruptions;
  } catch (error) {
    console.error('Error fetching National Rail disruptions:', error.message);
    return [];
  }
}

function getOperatorId(operatorName) {
  const operatorIdMap = {
    'Greater Anglia': 'greater-anglia',
    'Avanti West Coast': 'avanti-west-coast',
    'c2c': 'c2c',
    'Chiltern Railways': 'chiltern-railways',
    'CrossCountry': 'crosscountry',
    'East Midlands Railway': 'east-midlands-railway',
    'Gatwick Express': 'gatwick-express',
    'Grand Central': 'grand-central',
    'Great Northern': 'great-northern',
    'Great Western Railway': 'great-western-railway',
    'Heathrow Express': 'heathrow-express',
    'Hull Trains': 'hull-trains',
    'LNER': 'london-north-eastern-railway',
    'Lumo': 'lumo',
    'Merseyrail': 'merseyrail',
    'Northern': 'northern-rail',
    'ScotRail': 'scotrail',
    'Southeastern': 'southeastern',
    'Southern': 'southern',
    'South Western Railway': 'south-western-railway',
    'Thameslink': 'thameslink',
    'TransPennine Express': 'transpennine-express',
    'Transport for Wales': 'transport-for-wales',
    'West Midlands Railway': 'west-midlands-trains',
    'Stansted Express': 'stansted-express',
    'London Northwestern Railway': 'london-northwestern-railway'
  };
  
  return operatorIdMap[operatorName];
}

async function main() {
  try {
    if (!SLACK_BOT_TFL_TOKEN || !SLACK_CHANNEL_TFL) {
      console.error("Slack bot token or channel is not set. Please check your .env file.");
      return;
    }

    const tubeLines = getTubeLines();
    const nationalRailLines = getNationalRailLines();
    
    let slackUsers = {};
    try {
        slackUsers = JSON.parse(fs.readFileSync(SLACK_USERS_FILE, 'utf8'));
        console.log("Read slackUsers.json: SUCCESS");
    } catch (err) {
        console.error("Error reading slackUsers.json:", err.message);
        // Continue without user tagging if file is missing/corrupt
    }

    let currentAffectedLines = [];

    // Check TfL lines using the TfL API
    console.log("Checking TfL lines for disruptions...");
    for (const line of tubeLines) {
      const disruption = await getDisruption(line.id);
      if (disruption) {
        currentAffectedLines.push({ id: line.id, name: line.name, details: disruption });
      }
      // Add a small delay between requests to avoid rate limiting
      await delay(500);
    }

    // Check National Rail lines using the National Rail website
    console.log("Checking National Rail lines for disruptions...");
    const nationalRailDisruptions = await getNationalRailDisruptions();
    currentAffectedLines = [...currentAffectedLines, ...nationalRailDisruptions];

    // Save current disruptions to file
    fs.writeFileSync(CURRENT_DISRUPTIONS_FILE, JSON.stringify(currentAffectedLines, null, 2));
    console.log(`Current disruptions saved to ${CURRENT_DISRUPTIONS_FILE}`);

    const hasChanges = await checkForChanges(currentAffectedLines);

    let attachments = [];
    let messageTitle = '';

    if (hasChanges) {
      messageTitle = hasChanges === "update" ? "*UPDATE: Status Update:*" : "*Status Update:*";
      
      // Separate TfL and National Rail lines
      const tflLines = currentAffectedLines.filter(line => tubeLines.some(tl => tl.id === line.id));
      const railLines = currentAffectedLines.filter(line => nationalRailLines.some(nrl => nrl.id === line.id));

      // --- Begin new per-line TfL update logic ---
      let previousDisruptions = [];
      if (fs.existsSync(PREVIOUS_DISRUPTIONS_FILE)) {
        previousDisruptions = JSON.parse(fs.readFileSync(PREVIOUS_DISRUPTIONS_FILE));
      }
      const previousTflLines = previousDisruptions.filter(line => tubeLines.some(tl => tl.id === line.id));

      // Build maps for easy lookup
      const prevMap = new Map(previousTflLines.map(l => [l.id, l]));
      const currMap = new Map(tflLines.map(l => [l.id, l]));

      // Find lines that were disrupted before but now are not (good service)
      const nowGoodService = previousTflLines.filter(l => !currMap.has(l.id));
      // Find lines that are still disrupted (in both prev and curr)
      const stillDisrupted = tflLines.filter(l => prevMap.has(l.id));
      // Find lines that are newly disrupted (in curr but not prev)
      const newlyDisrupted = tflLines.filter(l => !prevMap.has(l.id));

      // Add messages for lines that are now good service
      for (const line of nowGoodService) {
        attachments.push({
          color: '#36a64f',
          text: `:white_check_mark: *${line.name}* now has no disruptions.`,
          mrkdwn_in: ['text'],
        });
      }
      // Add messages for newly disrupted lines
      for (const line of newlyDisrupted) {
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
      // Add messages for lines still disrupted
      for (const line of stillDisrupted) {
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
      // If there are still disrupted lines, add a summary
      if (stillDisrupted.length > 0) {
        attachments.push({
          color: '#FFA500',
          text: `All other lines are still affected as before.`,
          mrkdwn_in: ['text'],
        });
      }
      // --- End new per-line TfL update logic ---

      // Add National Rail status
      if (railLines.length === 0) {
        attachments.push({
          color: '#36a64f', // Green color for good service
          text: '*National Rail Services:* :nationalrail: ✅ All National Rail lines are running with good service.',
          mrkdwn_in: ['text'],
        });
      } else {
        for (const line of railLines) {
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
    }

    if (hasChanges && attachments.length > 0) {
      await slackClient.chat.postMessage({
        channel: SLACK_CHANNEL_TFL,
        text: messageTitle,
        attachments: attachments,
        mrkdwn: true
      });
      console.log('Disruption details sent to Slack with colored lines.');
    } else if (hasChanges === "new" && attachments.length === 0) {
        // This case would be if it's the first run, and there are no disruptions
        await slackClient.chat.postMessage({
            channel: SLACK_CHANNEL_TFL,
            text: '*Status Update:*\n\n*TfL Services:* :tfl: ✅ All TfL lines are running with good service.\n*National Rail Services:* :nationalrail: ✅ All National Rail lines are running with good service.',
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
    console.error('Error fetching or posting status:', err);
  }
}

main();