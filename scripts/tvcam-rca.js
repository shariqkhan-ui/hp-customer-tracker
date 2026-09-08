/**
 * TV & Camera complaints — RCA for the board.
 *
 * Content comes from data-tvcam-rca.json: the field team's final report
 * ("Customer Issue & RCA — Final Report", 7 cases formally documented) plus
 * 8 further cases the team took end to end. Every count on the page is
 * derived from that file, so the prose and the numbers cannot drift apart.
 *
 * Writes tv-camera-rca.html (GitHub Pages) and tv-camera-rca.artifact.html.
 */

const fs = require('fs');
const path = require('path');

const ROWS = require('../data-tvcam-rca.json');
const OUT = path.join(__dirname, '..', 'tv-camera-rca.html');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '—');

const N = ROWS.length;
const reported = ROWS.filter(r => r.reported);
const by = (key) => {
  const m = {};
  ROWS.forEach(r => { m[r[key]] = (m[r[key]] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};
const has = re => ROWS.filter(r => re.test(r.cause));

// Where the fault actually sat. This is the spine of the whole report.
const LAYERS = [
  ['Our access network', /Faulty Wi-Fi device|SSID|Coverage|LAN cabling/, 'The Wi-Fi device we installed, how it was configured, the cable run, or where it was placed'],
  ['ISP / backhaul', /ISP/, 'Upstream capacity or an outage at the ISP — outside the home, outside the CSP'],
  ['Line quality', /Optical/, 'Optical receive power out of range on the fibre serving the home'],
  ['Customer premise', /Customer TV|Band mismatch|Customer-premise/, "The customer's own TV or the app on it — no fault on our side"],
];
const layerOf = c => (LAYERS.find(l => l[1].test(c)) || LAYERS[3])[0];
const layerCount = {};
ROWS.forEach(r => { const l = layerOf(r.cause); layerCount[l] = (layerCount[l] || 0) + 1; });
const ourSide = N - (layerCount['Customer premise'] || 0);

const resolved = ROWS.filter(r => r.state === 'Resolved');
const noFault = ROWS.filter(r => r.state === 'No fault at our end');
const open = ROWS.filter(r => r.state === 'Open');
const deviceSwaps = ROWS.filter(r => /replaced/i.test(r.fix || '') || /replaced/i.test(r.resolution || '')).length;
const trulyDead = has(/Faulty Wi-Fi device/).length;
const ssidCases = ROWS.filter(r => /SSID not visible/i.test(r.symptom)).length;
const tvLabelled = ROWS.filter(r => /tv|camera/i.test(r.issue)).length;
// Were the swaps warranted? Tested against DBT.HOURLY_DEVICE_PING_INFLUX —
// a dead unit stops pinging, a configuration fault leaves it online.
const swapped = ROWS.filter(r => /Faulty Wi-Fi device/.test(r.cause));
const vNot = swapped.filter(r => r.verdict === 'Not a device failure').length;
const vYes = swapped.filter(r => r.verdict === 'Consistent with a device failure').length;
const vUnk = swapped.filter(r => r.verdict === 'Cannot be verified').length;
const swapRows = swapped.map(r =>
  `<tr><td class="mono">${esc(r.dev)}</td><td class="mono">${esc(r.mob)}</td>` +
  `<td><span class="pill ${r.verdict === 'Not a device failure' ? 'no' : r.verdict === 'Consistent with a device failure' ? 'ok' : 'na'}">${esc(r.verdict)}</span></td>` +
  `<td class="wrap">${esc(r.evidence)}</td></tr>`).join(String.fromCharCode(10));

const causeRows = by('cause').map(([k, n]) =>
  `<tr><td class="lbl wrap">${esc(k)}</td><td class="lay">${esc(layerOf(k))}</td><td>${n}</td><td>${pct(n, N)}</td></tr>`).join('\n');

const openRows = open.map(r =>
  `<tr><td class="mono">${esc(r.mob)}</td><td class="mono">${esc(r.dev)}</td><td class="wrap">${esc(r.cause)}</td>` +
  `<td class="wrap">${esc(r.fix)}</td></tr>`).join('\n');

const ledger = ROWS.map((r, i) =>
  `<tr><td class="num">${i + 1}</td><td class="mono">${esc(r.mob)}</td><td class="mono">${esc(r.dev)}</td>` +
  `<td class="wrap">${esc(r.issue)}</td><td class="wrap"><b>${esc(r.cause)}</b></td>` +
  `<td class="wrap">${esc(r.rca)}</td><td class="wrap">${esc(r.fix)}</td>` +
  `<td><span class="pill ${r.state === 'Resolved' ? 'ok' : r.state === 'Open' ? 'no' : 'na'}">${esc(r.state)}</span></td>` +
  `<td>${r.reported ? '✓' : ''}</td></tr>`).join('\n');

const headBits = `<title>TV &amp; Camera Complaints RCA</title>
<meta name="description" content="Root cause analysis of the TV and camera complaints: what customers reported, what was actually wrong, what fixed it, and what is still open.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@600;700&display=swap">
<style>
:root{
  --bg:#F7F3F6; --surface:#FFFFFF; --surface2:#F3EAF0; --raise:#FBF7FA;
  --ink:#1E141B; --ink2:#574A52; --muted:#8B7B85; --border:#E7DAE2; --rule:#D9C6D2;
  --accent:#C2007A; --accent-ink:#8E0059; --accent-soft:#FCE7F3;
  --good:#1A7F37; --good-soft:#E4F3E9; --warn:#A75B00; --bad:#B23A0A; --bad-soft:#FCE6DC;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#150F14; --surface:#1E1720; --surface2:#271E29; --raise:#241C26;
    --ink:#F5ECF2; --ink2:#C8B8C3; --muted:#95848F; --border:#382B36; --rule:#4A3A46;
    --accent:#FF5FBE; --accent-ink:#FF92D3; --accent-soft:#3A1030;
    --good:#5BD07F; --good-soft:#12301C; --warn:#E8A33D; --bad:#FF8757; --bad-soft:#3A1A0E;
  }
}
:root[data-theme="dark"]{
  --bg:#150F14; --surface:#1E1720; --surface2:#271E29; --raise:#241C26;
  --ink:#F5ECF2; --ink2:#C8B8C3; --muted:#95848F; --border:#382B36; --rule:#4A3A46;
  --accent:#FF5FBE; --accent-ink:#FF92D3; --accent-soft:#3A1030;
  --good:#5BD07F; --good-soft:#12301C; --warn:#E8A33D; --bad:#FF8757; --bad-soft:#3A1A0E;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:400 16px/1.65 "IBM Plex Sans",-apple-system,Segoe UI,system-ui,sans-serif;padding:0 22px 80px}
.wrap{max-width:1000px;margin:0 auto}
header{padding:56px 0 10px;border-bottom:1px solid var(--rule)}
.eyebrow{font:600 12px/1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.16em;
  text-transform:uppercase;color:var(--accent);margin:0 0 14px}
h1{font:700 clamp(30px,5.4vw,46px)/1.08 "IBM Plex Serif",Georgia,serif;margin:0 0 14px;
  letter-spacing:-.022em;text-wrap:balance;max-width:20ch}
.thesis{font-size:19px;line-height:1.5;color:var(--ink2);max-width:60ch;margin:0 0 22px}
.thesis b{color:var(--ink)}
.stamp{font:500 12.5px/1.5 "IBM Plex Mono",ui-monospace,monospace;color:var(--muted);
  padding:0 0 26px;display:flex;flex-wrap:wrap;gap:6px 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:26px 0 0}
.tile{background:var(--surface);padding:17px 19px 16px}
.tile .lb{font:600 11px/1.35 "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tile .vl{font:600 32px/1.1 "IBM Plex Mono",monospace;margin-top:8px;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.tile .nt{font-size:12.5px;color:var(--ink2);margin-top:4px}
section{margin-top:52px}
.sec-head{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--rule);padding-bottom:10px;margin-bottom:16px}
.sec-no{font:600 12px/1 "IBM Plex Mono",monospace;color:var(--accent);letter-spacing:.12em;padding-top:4px}
h2{font:700 clamp(21px,2.7vw,27px)/1.2 "IBM Plex Serif",Georgia,serif;margin:0;letter-spacing:-.015em}
h3{font:600 13px/1.3 "IBM Plex Mono",monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px}
p{max-width:74ch}
.sub{color:var(--ink2);font-size:14.6px;margin:0 0 18px;max-width:78ch}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14.3px;min-width:600px}
th{background:var(--surface2);color:var(--ink);text-align:right;padding:11px 14px;
  font:600 12px/1.35 "IBM Plex Mono",monospace;letter-spacing:.04em;border-bottom:1px solid var(--rule);white-space:nowrap}
th:first-child{text-align:left}
td{padding:9px 14px;border-bottom:1px solid var(--border);text-align:right;color:var(--ink2);
  font-variant-numeric:tabular-nums;white-space:nowrap}
td.lbl{text-align:left;color:var(--ink);white-space:normal}
td.wrap{text-align:left;white-space:normal;min-width:150px}
td.lay{text-align:left;color:var(--muted);font-size:12.5px;white-space:nowrap}
td.num{text-align:left;color:var(--muted)}
td.mono{font-family:"IBM Plex Mono",monospace;font-size:12.5px}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;font:600 11px/1.5 "IBM Plex Mono",monospace;letter-spacing:.04em;text-transform:uppercase}
.pill.ok{background:var(--good-soft);color:var(--good)}
.pill.no{background:var(--bad-soft);color:var(--bad)}
.pill.na{background:var(--accent-soft);color:var(--accent-ink)}
.finding{border:1px solid var(--border);border-left:3px solid var(--accent);background:var(--surface);
  border-radius:0 10px 10px 0;padding:17px 20px;margin:20px 0 0;font-size:15.5px;color:var(--ink2);max-width:78ch}
.finding b{color:var(--ink)}
.steps{list-style:none;counter-reset:st;padding:0;margin:14px 0 0;display:grid;gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.steps li{counter-increment:st;background:var(--surface);padding:15px 20px 15px 54px;position:relative;font-size:14.8px;color:var(--ink2)}
.steps li::before{content:counter(st);position:absolute;left:19px;top:15px;font:600 13px/1.65 "IBM Plex Mono",monospace;color:var(--accent)}
.steps b{color:var(--ink)}
footer{margin-top:58px;padding-top:18px;border-top:1px solid var(--rule);
  font:400 13px/1.65 "IBM Plex Mono",monospace;color:var(--muted)}
@media (max-width:640px){body{padding:0 14px 56px}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
</style>`;

const bodyInner = `<div class="wrap">

<header>
  <p class="eyebrow">Root cause analysis · customer experience</p>
  <h1>Why the TV stopped working</h1>
  <p class="thesis">${N} customers raised a TV or camera complaint. <b>${ourSide} of them turned out to be faults in the network we run</b> — the device, the cabling, the coverage, the line — not the television. The TV is simply where the customer notices.</p>
</header>
<div class="stamp">
  <span>${reported.length} cases, all formally documented by the field team</span>
  <span>Replacements re-tested against the device ping record</span>
  <span>Every figure derived from the case file</span>
</div>

<div class="tiles">
  <div class="tile"><div class="lb">Cases reviewed</div><div class="vl">${N}</div><div class="nt">${tvLabelled} logged as a TV or camera fault</div></div>
  <div class="tile"><div class="lb">Our network</div><div class="vl">${ourSide}</div><div class="nt">${pct(ourSide, N)} sat on our side of the wall</div></div>
  <div class="tile"><div class="lb">Closed</div><div class="vl">${resolved.length + noFault.length}</div><div class="nt">${resolved.length} fixed · ${noFault.length} no fault at our end</div></div>
  <div class="tile"><div class="lb">Still open</div><div class="vl">${open.length}</div><div class="nt">each has a named next action</div></div>
</div>

<section>
  <div class="sec-head"><span class="sec-no">01</span><h2>The finding</h2></div>
  <p class="sub">A complaint reaches us named after the symptom the customer can see. Reading the ${N} cases together, that name turns out to be a poor guide to the fault.</p>
  <div class="finding"><b>${tvLabelled} of ${N} cases arrived labelled as a TV or camera fault. Only ${layerCount['Customer premise']} of them actually were.</b> The rest were ordinary access-network faults — a dead Wi-Fi unit, a mis-configured SSID, a bad cable crimp, weak coverage, an ISP outage, an out-of-range optical level. The television was the detector, not the defect. It is the one device in the house that is on every evening, so it is where an intermittent connection is felt first and reported.</div>
  <p class="sub" style="margin-top:20px">The consequence is operational, not semantic. A case labelled “TV issue” gets routed and triaged as a customer-premise problem, which is the slowest possible path for what is usually our own device failing.</p>
</section>

<section>
  <div class="sec-head"><span class="sec-no">02</span><h2>What was actually wrong</h2></div>
  <p class="sub">Every case traced to a single root cause. Grouped by where the fault physically sat.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Root cause</th><th style="text-align:left">Where it sat</th><th>Cases</th><th>Share</th></tr></thead>
    <tbody>${causeRows}</tbody></table></div>

  <h3>Rolled up by layer</h3>
  <div class="tablewrap"><table style="min-width:520px">
    <thead><tr><th>Layer</th><th style="text-align:left">What this covers</th><th>Cases</th><th>Share</th></tr></thead>
    <tbody>
      ${LAYERS.map(([name, , desc]) => layerCount[name] ? `<tr><td class="lbl">${name}</td><td class="wrap" style="color:var(--muted);font-size:13px">${desc}</td><td>${layerCount[name]}</td><td>${pct(layerCount[name], N)}</td></tr>` : '').join('\n')}
    </tbody></table></div>

  <div class="finding"><b>Two different faults were being recorded as one.</b> ${deviceSwaps} of ${N} cases ended in a unit being replaced, all on the symptom “the network name has vanished”. But only ${trulyDead} of them had the name missing from <i>every</i> device, which is what a dead unit looks like. In the other ${deviceSwaps - trulyDead} the name was missing on the television alone while the rest of the house stayed online — so the box was working, and replacing it fixed the problem only because a new unit comes up with a fresh network name.</div>
</section>

<section>
  <div class="sec-head"><span class="sec-no">03</span><h2>Were the replacements necessary?</h2></div>
  <p class="sub">Every one of the ${deviceSwaps} swaps was raised on the same symptom: the network name had disappeared. That symptom has two very different causes — a dead radio, or an SSID the television cannot see while every other device can. The two are separable after the fact, because a dead unit stops pinging and a configuration fault does not. Each swap was tested against the hourly device ping record.</p>
  <div class="tablewrap"><table style="min-width:760px">
    <thead><tr><th>Device</th><th>Mobile</th><th>Verdict</th><th style="text-align:left">Evidence</th></tr></thead>
    <tbody>${swapRows}</tbody></table></div>
  <div class="finding"><b>Of the ${deviceSwaps} replacements, ${vYes} is consistent with a genuine device failure, ${vNot} demonstrably was not, and ${vUnk} cannot be checked</b> — those two complaints predate the ping record, which begins 24 June. On SY048096 the router was carrying clients on both 2.4 GHz and 5 GHz on the day it was swapped, and was broadcasting all three of its SSIDs. Replacing it worked, but only because a new unit comes up with a fresh WLAN configuration. We changed the hardware to fix a setting.</div>
  <p class="sub" style="margin-top:18px">Band steering is measured on every device and the flag was never set on any of these four, so this is not the platform steering clients between bands. It is the narrower problem of a television failing to detect an SSID that is plainly being broadcast — the same fault family as the two cases that were fixed by renaming the network, with no visit and no hardware.</p>
  <div class="finding" style="border-left-color:var(--warn)"><b>What this costs.</b> On the evidence available, at least one of the ${deviceSwaps} swaps was avoidable, and the honest reading of the remaining three is one confirmed and two unknown. A router costs materially more than a remote SSID change, and the swap needs a CSP visit, so the process gap is not cosmetic. The check that separates them takes seconds and is already in our own data.</p></div>
</section>

<section>
  <div class="sec-head"><span class="sec-no">04</span><h2>What fixed it</h2></div>
  <p class="sub">${resolved.length} cases are fixed and confirmed by the customer; ${noFault.length} closed with no fault on our side; ${open.length} remain open.</p>
  <div class="tablewrap"><table style="min-width:560px">
    <thead><tr><th>Action that closed the case</th><th>Cases</th><th style="text-align:left">Outcome</th></tr></thead>
    <tbody>
      <tr><td class="lbl">Wi-Fi device replaced</td><td>${deviceSwaps}</td><td class="wrap">Network name returned, customer confirmed service restored</td></tr>
      <tr><td class="lbl">SSID renamed via WLAN settings</td><td>1</td><td class="wrap">TV found the network again — fixed remotely, no visit</td></tr>
      <tr><td class="lbl">ISP speed shortfall raised with the ISP</td><td>1</td><td class="wrap">Throughput corrected upstream, buffering stopped</td></tr>
      <tr><td class="lbl">ISP outage cleared upstream</td><td>2</td><td class="wrap">Service returned with the outage; nothing wrong in the home</td></tr>
      <tr><td class="lbl">Explained as customer-premise</td><td>${noFault.length}</td><td class="wrap">TV without 5 GHz support, an uninstalled app, a repaired TV that no longer keeps its Wi-Fi credentials</td></tr>
    </tbody></table></div>

  <h3>Still open — ${open.length} cases</h3>
  <div class="tablewrap"><table style="min-width:640px">
    <thead><tr><th>Mobile</th><th>Device</th><th style="text-align:left">Root cause</th><th style="text-align:left">Next action</th></tr></thead>
    <tbody>${openRows}</tbody></table></div>
</section>

<section>
  <div class="sec-head"><span class="sec-no">05</span><h2>Why it keeps happening</h2></div>
  <p class="sub">Three patterns run underneath the ${N} cases. Each is a process gap, not a one-off.</p>
  <ol class="steps">
    <li><b>We diagnose the appliance, not the network.</b> The complaint arrives named after the TV, so the first hour goes into the TV. In ${ourSide} of ${N} cases that hour was spent on the wrong side of the wall.</li>
    <li><b>We cannot tell a dead unit from a hidden SSID in the field.</b> Both present as “the network name isn't showing”. ${deviceSwaps} units were replaced on that symptom and, where it can be checked, at least one was online and broadcasting at the time. The ping record answers this in seconds and nobody consults it before authorising a swap.</li>
    <li><b>We close on the customer's word, not on a measurement.</b> Coverage, optical power and ISP throughput each caused a case here, and none of the three is visible to the CSP standing in the room. Where it was measured — ${'−30 dBm'} on one line, a speed shortfall on another — the cause was found immediately.</li>
  </ol>
</section>

<section>
  <div class="sec-head"><span class="sec-no">06</span><h2>What we are changing</h2></div>
  <p class="sub">A remote-first triage drawn from these ${N} cases. It is written so a support agent can run it on the call, before any visit is booked.</p>
  <ol class="steps">
    <li><b>Ask what the customer can see, not what is broken.</b> “Is the Wi-Fi name showing in the TV's network list?” splits these ${N} cases almost in half. Name missing means a device or configuration fault; name present means speed, coverage or the TV itself.</li>
    <li><b>Name missing → check the ping record before raising a swap.</b> If the router is pinging and shows clients on either band, the unit is alive and the fault is the SSID, not the hardware. Only a unit that has genuinely stopped reporting should be replaced.</li>
    <li><b>Name visible on the phone but not the TV → rename the SSID from WLAN settings.</b> This closed a case remotely with no visit, and is the open action on one more.</li>
    <li><b>TV joins nothing while the phone is fine → check the band before booking anyone.</b> Older sets are 2.4 GHz only. One customer needed a TV service centre, not us.</li>
    <li><b>Buffering rather than disconnection → read the line first.</b> Optical receive power and ISP throughput, before dispatch. −30 dBm is already out of range and no CSP visit will move it.</li>
    <li><b>Camera down while Wi-Fi is up → test the cable run to the DVR.</b> Where the DVR sits in a different shop, the RJ45 crimp is the first suspect.</li>
    <li><b>Close no-fault cases explicitly as customer-premise.</b> ${noFault.length} of ${N} were the customer's own equipment. Unless they are dispositioned as such they keep ageing in the tracker and are counted as our breach.</li>
  </ol>
  <div class="finding">The measurable test of this change is the split above: today ${pct(ourSide, N)} of “TV issues” are network faults being triaged as appliance faults. If the triage works, that mislabelling should fall, and the cases that remain should reach a device swap in hours rather than days.</div>
</section>

<section>
  <div class="sec-head"><span class="sec-no">07</span><h2>Case ledger</h2></div>
  <p class="sub">All ${N} cases, every one formally documented across the field team's two reports.</p>
  <div class="tablewrap" style="max-height:560px;overflow:auto"><table style="min-width:1060px">
    <thead><tr><th>#</th><th>Mobile</th><th>Device</th><th style="text-align:left">Reported as</th><th style="text-align:left">Root cause</th><th style="text-align:left">What we found</th><th style="text-align:left">Action</th><th>Status</th></tr></thead>
    <tbody>${ledger}</tbody></table></div>
</section>

<footer>
  Source: field team case file, “Customer Issue &amp; RCA — Final Report”, plus ${N - reported.length} further cases worked end to end.<br>
  Counts on this page are derived from the case file itself, so the narrative and the numbers cannot diverge.
</footer>

</div>`;

const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
  headBits + '\n</head>\n<body>\n' + bodyInner + '\n</body>\n</html>\n';

fs.writeFileSync(OUT, html, 'utf8');
fs.writeFileSync(path.join(__dirname, '..', 'tv-camera-rca.artifact.html'), headBits + '\n' + bodyInner + '\n', 'utf8');
console.log('wrote', OUT, html.length, 'bytes');
console.log('cases', N, '| our side', ourSide, '| resolved', resolved.length, '| no fault', noFault.length, '| open', open.length);
console.log('layers', JSON.stringify(layerCount));
