# tfl-status-checker

This tool is a node script written in JavaScript designed to scrape data from the TFL Status website using puppeteer. It then sends a Slack message via a custom created Slackbot to a channel tagging users affected by delays on certain TFL lines with a copy of the description from the TFL Status website and a screenshot.

Setup requires creating a new Slackbot and associating the bot to a channel. Alongside this, Secrets in GitHub need to be set up, in this case `SLACK_CHANNEL` and `SLACK_BOT_TOKEN` to allow pipelines to access the necessary variables.

The cron job on the pipeline is set to run 4 times a day, around 7:30am, 8:00am, 16:30 and 17:00. On the 1st and 3rd runs, the results are saved into a Git cache and recalled on the next runs. On the 2nd and 4th runs, it compares the results to the previous run to see if anything has changed and will send an update if it has or it won't set an update if nothing has changed. It also clears the cache
