# tfl-status-checker

This tool is a node script written in JavaScript designed to obtain TFL Line Status data and send an alert via Slack using a custom created Slackbot. Initially, this script would scrape data from the TFL Status website using puppeteer but it's now changed to use the TFL Unified API endpoints. The Slack message is send to a channel tagging users affected by delays on their affected TFL lines with a copy of the description and severity of the delay.

Setup requires creating a Slackbot and associating the bot to a channel. Alongside this, Secrets in GitHub need to be set up, in this case `SLACK_CHANNEL` and `SLACK_BOT_TOKEN` to allow pipelines to access the necessary variables.

GitHub Actions can run each cron in a specific IANA timezone. This workflow uses **six weekday schedules** at `07:15`, `08:00`, `08:45`, `16:30`, `17:15`, and `18:00` with `timezone: Europe/London`, so targets stay correct through GMT/BST without editing UTC offsets. GitHub may still **delay** scheduled runs under load; Slack footers show both the **scheduled** slot (`github.event.schedule`) and the **actual send** time after install and API calls. On the first run in each morning/evening block the snapshot is cached for comparison; on the third run in each block that block’s cache is cleared.
