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
  h2 { font-size:15px; margin:32px 0 10px; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:20px; }
  .note { color:var(--muted); font-size:13px; margin:6px 0 14px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .tile .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.04em; }
  .tile .value { font-size:26px; font-weight:600; margin-top:4px; font-variant-numeric:tabular-nums; }
  .wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; }
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
  label { color:var(--muted); font-size:12px; display:flex; flex-direction:column; gap:4px; }
  input, button { font:inherit; }
  input[type=month] { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  button { background:#10303a; color:#4cc9f0; border:1px solid var(--line); border-radius:6px;
           padding:8px 14px; cursor:pointer; }
  button:disabled { opacity:0.5; cursor:default; }
  button.approve { background:#10331d; color:#4ade80; padding:5px 12px; font-size:13px; }
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

<h2>Service tickets — low ratings</h2>
<div class="wrap"><table>
  <thead><tr><th>Order</th><th>Customer</th><th>Phone</th></tr></thead>
  <tbody id="ticket-rows"></tbody>
</table></div>

<h2>Delivery</h2>
<div class="tiles" id="delivery-tiles"></div>
<div class="wrap"><table>
  <thead><tr><th>Order</th><th>AWB</th><th>Courier</th><th>RTO initiated</th></tr></thead>
  <tbody id="rto-rows"></tbody>
</table></div>

<h2>Cancellations — pending review</h2>
<div class="wrap"><table>
  <thead><tr><th>Order</th><th>Customer</th><th>Phone</th><th>Reason</th><th></th></tr></thead>
  <tbody id="cancel-rows"></tbody>
</table></div>

<h2>Invoices</h2>
<div class="wrap"><table>
  <thead><tr><th>Invoice</th><th>Order</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
  <tbody id="invoice-rows"></tbody>
</table></div>
<div class="sub" style="margin-top:14px;">GST discrepancy flags — computed GST vs. Shopify's tax_lines at intake</div>
<div class="wrap"><table>
  <thead><tr><th>Order</th><th>Discrepancy</th></tr></thead>
  <tbody id="discrepancy-rows"></tbody>
</table></div>

<h2>GST — B2CS export</h2>
<div class="panel">
  <label>Month <input type="month" id="gst-month"></label>
  <button id="gst-download">Download B2CS CSV</button>
</div>

<h2>Health</h2>
<div class="note">
  All invoices use the default HSN configured for the store — there is no per-product
  HSN source in Stage 1, so this is a fact of the current setup, not a flag to action.
</div>
<div class="tiles" id="health-tiles"></div>
<div class="wrap"><table>
  <thead><tr><th>Order</th><th>Effect</th><th>Last error</th></tr></thead>
  <tbody id="failed-effect-rows"></tbody>
</table></div>
<div class="sub" style="margin-top:14px;">Unmapped courier statuses — raw values Shadowfax sent that the hub doesn't recognise yet</div>
<div class="wrap"><table>
  <thead><tr><th>Order</th><th>AWB</th><th>Raw status</th></tr></thead>
  <tbody id="unmapped-rows"></tbody>
</table></div>
<div class="sub" style="margin-top:14px;">Blocked invoices — delivered orders the hub refused to invoice rather than guess at. Fix the underlying data, then set the order's <code>delivered</code> effect row back to PENDING so the next drain retries it.</div>
<div class="wrap"><table>
  <thead><tr><th>Order</th><th>Reason</th><th>Detail</th></tr></thead>
  <tbody id="blocked-invoice-rows"></tbody>
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

function showError(message) {
  document.getElementById('error').innerHTML = '<div class="err">' + esc(message) + '</div>';
  document.getElementById('updated').textContent = '';
}

/**
 * Fetches with the stored token; returns null (and shows the 401 hint) if unauthorized.
 * options is passed straight to fetch (a POST caller can supply { method: 'POST' }) —
 * the Authorization header is always added on top of whatever headers it supplies.
 * On any other non-2xx, throws with the server's { error } body when there is one, so
 * a caller's catch block has something real to show the operator instead of a bare
 * HTTP status.
 */
async function authFetch(path, options) {
  const res = await fetch(path, {
    ...(options || {}),
    headers: { ...((options && options.headers) || {}), Authorization: 'Bearer ' + token },
  });
  if (res.status === 401) {
    showError('Unauthorized. Open this page as /dashboard?token=YOUR_DASHBOARD_TOKEN');
    return null;
  }
  if (!res.ok) {
    let detail = 'HTTP ' + res.status + ' on ' + path;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') detail = body.error;
    } catch (err) {
      // Not a JSON body (e.g. an HTML error page) — fall back to the generic detail above.
    }
    throw new Error(detail);
  }
  return res;
}

async function loadOrders() {
  const res = await authFetch('/api/orders');
  if (!res) return null;
  const { orders, metrics } = await res.json();

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

  // The low-rating bucket IS the service-ticket queue — no separate ticket store exists.
  const tickets = orders.filter((o) => o.rating === '1-2');
  document.getElementById('ticket-rows').innerHTML = tickets.map((o) =>
    '<tr><td>' + esc(o.orderNo) + '</td><td>' + esc(o.customerName) + '</td>' +
    '<td class="num">' + esc(o.phone) + '</td></tr>'
  ).join('') || '<tr><td colspan="3">No open low-rating tickets.</td></tr>';

  return { orders, metrics };
}

async function loadDelivery() {
  const res = await authFetch('/api/delivery');
  if (!res) return;
  const { funnel, rto } = await res.json();

  document.getElementById('delivery-tiles').innerHTML = [
    tile('Shipped', funnel.shipped),
    tile('Out for delivery', funnel.ofd),
    tile('Delivered', funnel.delivered),
  ].join('');

  document.getElementById('rto-rows').innerHTML = rto.map((s) =>
    '<tr><td>' + esc(s.orderNo) + '</td><td>' + esc(s.awb) + '</td><td>' + esc(s.courier) + '</td>' +
    '<td>' + when(s.rtoInitiatedAt) + '</td></tr>'
  ).join('') || '<tr><td colspan="4">No RTOs in transit back.</td></tr>';
}

async function loadCancellations() {
  const res = await authFetch('/api/cancellations');
  if (!res) return;
  const { orders } = await res.json();

  document.getElementById('cancel-rows').innerHTML = orders.map((o) =>
    '<tr><td>' + esc(o.orderNo) + '</td><td>' + esc(o.customerName) + '</td>' +
    '<td class="num">' + esc(o.phone) + '</td><td>' + esc(o.cancelReason) + '</td>' +
    '<td><button class="approve" data-order="' + esc(o.orderNo) + '">Approve</button></td></tr>'
  ).join('') || '<tr><td colspan="5">Nothing pending review.</td></tr>';
}

async function loadInvoices() {
  const res = await authFetch('/api/invoices');
  if (!res) return;
  const { invoices, discrepancies } = await res.json();

  document.getElementById('invoice-rows').innerHTML = invoices.map((i) =>
    '<tr><td>' + esc(i.invoiceNo) + '</td><td>' + esc(i.orderNo) + '</td>' +
    '<td>' + esc(i.invoiceDate) + '</td><td class="num">' + rupees(i.invoiceTotal) + '</td>' +
    '<td><span class="chip ' + (i.status === 'VOID' ? 'CANCELLED' : 'PAID_EARLY') + '">' + esc(i.status) + '</span></td></tr>'
  ).join('') || '<tr><td colspan="5">No invoices yet.</td></tr>';

  document.getElementById('discrepancy-rows').innerHTML = discrepancies.map((o) =>
    '<tr><td>' + esc(o.orderNo) + '</td><td class="num">' + rupees(o.gstDiscrepancy) + '</td></tr>'
  ).join('') || '<tr><td colspan="2">No GST discrepancies flagged.</td></tr>';
}

async function loadHealth() {
  const res = await authFetch('/api/health-flags');
  if (!res) return;
  const { failedEffects, unmappedStatuses, blockedInvoices } = await res.json();

  document.getElementById('health-tiles').innerHTML = [
    tile('Failed effects', failedEffects.length),
    tile('Unmapped statuses', unmappedStatuses.length),
    tile('Blocked invoices', blockedInvoices.length),
  ].join('');

  document.getElementById('failed-effect-rows').innerHTML = failedEffects.map((e) =>
    '<tr><td>' + esc(e.orderNo) + '</td><td>' + esc(e.kind) + '</td><td>' + esc(e.lastError) + '</td></tr>'
  ).join('') || '<tr><td colspan="3">No failed effects.</td></tr>';

  document.getElementById('unmapped-rows').innerHTML = unmappedStatuses.map((s) =>
    '<tr><td>' + esc(s.orderNo) + '</td><td>' + esc(s.awb) + '</td><td>' + esc(s.rawStatus) + '</td></tr>'
  ).join('') || '<tr><td colspan="3">No unmapped statuses.</td></tr>';

  document.getElementById('blocked-invoice-rows').innerHTML = blockedInvoices.map((b) =>
    '<tr><td>' + esc(b.orderNo) + '</td><td>' + esc(b.reasons.join(', ')) + '</td>' +
    '<td style="white-space:normal;">' + esc(b.detail) + '</td></tr>'
  ).join('') || '<tr><td colspan="3">No blocked invoices.</td></tr>';
}

async function refreshAll() {
  try {
    document.getElementById('error').innerHTML = '';
    const ordersLoaded = await loadOrders();
    if (!ordersLoaded) return; // 401 already shown by authFetch
    await Promise.all([loadDelivery(), loadCancellations(), loadInvoices(), loadHealth()]);
    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN');
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById('cancel-rows').addEventListener('click', async (event) => {
  const button = event.target.closest('button.approve');
  if (!button) return;
  button.disabled = true;
  try {
    const res = await authFetch(
      '/api/cancellations/' + encodeURIComponent(button.dataset.order) + '/approve',
      { method: 'POST' },
    );
    if (!res) { button.disabled = false; return; } // 401 — authFetch already showed why
    await loadCancellations();
  } catch (err) {
    button.disabled = false;
    showError(err.message);
  }
});

document.getElementById('gst-download').addEventListener('click', () => {
  const month = document.getElementById('gst-month').value;
  if (!month) return;
  // A plain navigation can't set an Authorization header, so this relies on the
  // dashboard token's \`?token=\` query fallback rather than the fetch+header path
  // every other section above uses.
  const url = '/api/b2cs?month=' + encodeURIComponent(month) + '&token=' + encodeURIComponent(token);
  window.open(url, '_blank');
});

refreshAll();
setInterval(refreshAll, 60000);
</script>
</body>
</html>`;
}
