# tfl-status-checker

This tool is a node script written in JavaScript designed to obtain TFL Line Status data and send an alert via Slack using a custom created Slackbot. Initially, this script would scrape data from the TFL Status website using puppeteer but it's now changed to use the TFL Unified API endpoints. The Slack message is send to a channel tagging users affected by delays on their affected TFL lines with a copy of the description and severity of the delay.

Setup requires creating a Slackbot and associating the bot to a channel. Alongside this, Secrets in GitHub need to be set up, in this case `SLACK_CHANNEL` and `SLACK_BOT_TOKEN` to allow pipelines to access the necessary variables.

GitHub Actions cron schedules are strictly **UTC** (any `timezone` keys are silently ignored by GitHub). During British Summer Time (BST, UTC+1), that translates to scheduling jobs at `06:15`, `07:00`, `07:45`, `15:30`, `16:15`, and `17:00` UTC to target London wall-clock times of `07:15`, `08:00`, `08:45`, `16:30`, `17:15`, and `18:00`.

### Scheduled Run Delays & Solution
GitHub Actions runs scheduled jobs on a "best-effort" basis. Under load, jobs can be delayed by 1 to 3 hours. 

If you require **precise/guaranteed timing**:
1. Use a free external scheduler (like **Cronitor**, **Google Cloud Scheduler**, or **Pipedream**) configured with your local timezone (Europe/London) to target the exact times.
2. Configure the external scheduler to trigger the workflow via the GitHub API's `workflow_dispatch` endpoint.
3. Because `workflow_dispatch` runs are treated as immediate, they start with almost zero delay (typically within seconds).

**API Trigger Example:**
```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR_GITHUB_PERSONAL_ACCESS_TOKEN>" \
  https://api.github.com/repos/mohammadarif87/tfl-status-checker/actions/workflows/schedule.yml/dispatches \
  -d '{"ref":"main","inputs":{"schedule_note":"07:15 Europe/London"}}'
```
*(Slack footers will display the `schedule_note` passed via the API input).*
