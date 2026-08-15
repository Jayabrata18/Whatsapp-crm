/**
 * The dashboard page. No client build step, no framework, no external requests —
 * it reads the token from the URL, keeps it in sessionStorage, and polls the API.
 */
export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>URBNMYTH — Orders &amp; Confirmations</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --card:#171a21; --fg:#e8eaed; --muted:#9aa0a6; --line:#262b35; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:20px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .tile .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.04em; }
  .tile .value { font-size:26px; font-weight:600; margin-top:4px; font-variant-numeric:tabular-nums; }
  .wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  table { border-collapse:collapse; width:100%; min-width:760px; }
  th,td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.04em; }
  tbody tr:last-child td { border-bottom:none; }
  .chip { display:inline-block; padding:2px 9px; border-radius:99px; font-size:12px; font-weight:500; }
  .PENDING { background:#3a2f10; color:#f2c94c; }
  .CONFIRMED { background:#10303a; color:#4cc9f0; }
  .PAID_EARLY { background:#10331d; color:#4ade80; }
  .CANCELLED { background:#3a1414; color:#f87171; }
  .NO_RESPONSE { background:#26262b; color:#9aa0a6; }
  .num { font-variant-numeric:tabular-nums; }
  .err { background:#3a1414; color:#f87171; padding:12px 16px; border-radius:10px; margin-bottom:16px; }
</style>
</head>
<body>
<h1>Orders &amp; Confirmations</h1>
<div class="sub" id="updated">Loading…</div>
<div id="error"></div>
<div class="tiles" id="tiles"></div>
<div class="wrap"><table>
  <thead><tr>
    <th>Order</th><th>Customer</th><th>Phone</th><th>Amount</th>
    <th>Payable</th><th>Type</th><th>Status</th><th>Created</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<script>
const params = new URLSearchParams(location.search);
const urlToken = params.get('token');
if (urlToken) { sessionStorage.setItem('dashToken', urlToken); history.replaceState({}, '', location.pathname); }
const token = sessionStorage.getItem('dashToken') || '';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const rupees = (n) => '\\u20b9' + Number(n || 0).toLocaleString('en-IN');
const when = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' }) : '—';

function tile(label, value) {
  return '<div class="tile"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}

async function load() {
  try {
    const res = await fetch('/api/orders', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) {
      document.getElementById('error').innerHTML =
        '<div class="err">Unauthorized. Open this page as /dashboard?token=YOUR_DASHBOARD_TOKEN</div>';
      document.getElementById('updated').textContent = '';
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { orders, metrics } = await res.json();
    document.getElementById('error').innerHTML = '';

    document.getElementById('tiles').innerHTML = [
      tile('Orders', metrics.total),
      tile('COD orders', metrics.codOrders),
      tile('Confirm rate', metrics.confirmRate + '%'),
      tile('Early-pay rate', metrics.earlyPayRate + '%'),
      tile('Collected early', rupees(metrics.revenueCollectedEarly)),
      tile('Awaiting reply', metrics.pending),
    ].join('');

    document.getElementById('rows').innerHTML = orders.map((o) =>
      '<tr>' +
      '<td>' + esc(o.orderNo) + '</td>' +
      '<td>' + esc(o.customerName) + '</td>' +
      '<td class="num">' + esc(o.phone) + '</td>' +
      '<td class="num">' + rupees(o.amount) + '</td>' +
      '<td class="num">' + rupees(o.payable) + '</td>' +
      '<td>' + (o.isCod ? 'COD' : 'Prepaid') + '</td>' +
      '<td><span class="chip ' + esc(o.confirmStatus) + '">' + esc(o.confirmStatus).replace('_', ' ') + '</span></td>' +
      '<td>' + when(o.createdAt) + '</td>' +
      '</tr>').join('') || '<tr><td colspan="8">No orders yet.</td></tr>';

    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN');
  } catch (err) {
    document.getElementById('error').innerHTML = '<div class="err">' + esc(err.message) + '</div>';
  }
}

load();
setInterval(load, 60000);
</script>
</body>
</html>`;
}
