// ══════════════════════════════════════════════════════════════════
//  High Pain Customer Tracker — Google Apps Script
//  Serves the dashboard as a web app AND handles all data operations.
//  Deploy as: Execute as = Me, Who has access = Anyone
// ══════════════════════════════════════════════════════════════════

var SHEET_NAME = 'Raw Data - Internet > 3 days';

function doGet(e) {
  // Serve the dashboard HTML when the URL is opened in a browser
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('High Pain Customer Tracker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── Called by client: google.script.run.getCSVData() ──
function getCSVData() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + SHEET_NAME);

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var rows   = sheet.getDataRange().getValues();
  var csv    = rows.map(function(row) {
    return row.map(function(cell) {
      var s;
      if (cell instanceof Date) {
        s = String(cell.getDate()).padStart(2,'0') + '-' + MONTHS[cell.getMonth()] + '-' + cell.getFullYear();
      } else {
        s = String(cell == null ? '' : cell);
      }
      return (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0)
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(',');
  }).join('\n');
  return csv;
}

// ── Called by client: google.script.run.saveEdit(ticket, field, value) ──
function saveEdit(ticket, field, value) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + SHEET_NAME);

  var colMap = { remarks: 9, engineer: 11, migration_date: 15 };
  var col    = colMap[field];
  if (!col || !ticket) throw new Error('Missing params: ticket=' + ticket + ' field=' + field);

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(ticket).trim()) {
      sheet.getRange(i + 1, col).setValue(value);
      return 'ok';
    }
  }
  throw new Error('Ticket not found: ' + ticket);
}

// ══════════════════════════════════════════════════════════════════
//  Daily Slack Notification — 10:00 AM IST
//  Sends a channel alert after the auto-sync adds new cases.
//
//  SETUP (one-time):
//    1. In GAS editor → Project Settings → Script Properties
//       Add property: SLACK_BOT_TOKEN  →  value: xoxb-...your token...
//    2. In GAS editor, select function "installDailySlackTrigger" → Run
//       (Only needs to be done once. The trigger persists forever.)
// ══════════════════════════════════════════════════════════════════

function sendSlackNotification() {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) {
    Logger.log('ERROR: SLACK_BOT_TOKEN not set in Script Properties.');
    return;
  }
  var payload = JSON.stringify({
    channel:  'C0AHDR8H4CC',
    username: "Shariq's Slack Agent",
    icon_url: 'https://raw.githubusercontent.com/shariqkhan-ui/hp-customer-tracker/master/shariq-agent.jpg',
    text:     '<!channel> New cases have been added in the tracker \u2014 check it here: https://shariqkhan-ui.github.io/hp-customer-tracker/'
  });
  var response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method:  'post',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: payload,
    muteHttpExceptions: true
  });
  Logger.log('Slack response: ' + response.getContentText());
}

// Run this function ONCE from the GAS editor to install the daily 10 AM IST trigger.
// It is safe to run again — removes any existing trigger first to avoid duplicates.
function installDailySlackTrigger() {
  // Remove any existing trigger for sendSlackNotification to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'sendSlackNotification') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  // Create a new daily trigger at 10:00–10:30 AM IST (India Standard Time)
  ScriptApp.newTrigger('sendSlackNotification')
    .timeBased()
    .atHour(10)
    .nearMinute(0)
    .inTimezone('Asia/Kolkata')
    .everyDays(1)
    .create();
  Logger.log('Daily Slack trigger installed: fires at 10:00 AM IST every day.');
}

// ── Called by client: google.script.run.addRow(params) ──
function addRow(params) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + SHEET_NAME);

  sheet.appendRow([
    params.caseAddedOn  || '',
    params.ticketNo     || '',
    '',
    params.mobile       || '',
    params.subcat       || '',
    params.custName     || '',
    params.partner      || '',
    params.tat          || '',
    '', '', '', '', '', '', ''
  ]);
  return 'ok';
}
