# tfl-status-checker

This tool is a node script written in JavaScript designed to obtain TFL Line Status data and send an alert via Slack using a custom created Slackbot. Initially, this script would scrape data from the TFL Status website using puppeteer but it's now changed to use the TFL Unified API endpoints. The Slack message is send to a channel tagging users affected by delays on their affected TFL lines with a copy of the description and severity of the delay.

Setup requires creating a Slackbot and associating the bot to a channel. Alongside this, Secrets in GitHub need to be set up, in this case `SLACK_CHANNEL` and `SLACK_BOT_TOKEN` to allow pipelines to access the necessary variables.

The cron job on the pipeline is set to run 6 times a day, around 07:30, 08:00 and 08:30 and 16:30, 17:00 and 17:30. On the 1st and 4th runs, the results are saved into a Git cache and recalled on the next runs. On the 2nd, 3rd, 5th and 6th runs, it compares the results to the previous run to see if anything has changed and will send an update if it has or it won't set an update if nothing has changed. It also clears the cache on the 3rd and 6th run.
