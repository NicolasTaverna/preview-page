// netlify/functions/verify-paypal.js
const { google } = require('googleapis');

exports.handler = async function(event) {
  // CORS response helper
  const makeResponse = (statusCode, body) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  });

  try {
    if (event.httpMethod !== 'POST') return makeResponse(405, { error: 'Method not allowed' });

    const payload = JSON.parse(event.body || '{}');
    const { orderRef, orderId } = payload;
    if (!orderRef || !orderId) return makeResponse(400, { error: 'Missing orderRef or orderId' });

    // --- 1) Get PayPal access token ---
    const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
    const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
    if (!PAYPAL_CLIENT || !PAYPAL_SECRET) return makeResponse(500, { error: 'PayPal credentials missing' });

    const auth = Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) return makeResponse(500, { error: 'Failed to get PayPal access token', tokenJson });

    // --- 2) Get order details from PayPal and verify ---
    const orderRes = await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const orderJson = await orderRes.json();

    // Basic verification
    //  - check order exists
    if (!orderJson || !orderJson.purchase_units) return makeResponse(400, { error: 'Invalid order', orderJson });

    // Attempt to detect completed payment: either order.status === 'COMPLETED' OR captured payments present
    const orderStatus = orderJson.status;
    const pu = orderJson.purchase_units[0] || {};
    // custom_id from order must match
    const customId = pu.custom_id || null;

    // If order is not completed, but capture exists and is completed, treat as OK
    const hasCompletedCapture = (pu.payments && Array.isArray(pu.payments.captures) && pu.payments.captures.some(c => c.status === 'COMPLETED'));

    if (!(orderStatus === 'COMPLETED' || hasCompletedCapture)) {
      return makeResponse(400, { error: 'Payment not completed', orderStatus, hasCompletedCapture });
    }

    if (customId !== orderRef) {
      // custom_id mismatch => possible tampering
      return makeResponse(400, { error: 'custom_id does not match orderRef', customId, orderRef });
    }

    // --- 3) Read Google Sheet to find the Drive file ID ---
    // Service account JSON should be stored in env var GOOGLE_SERVICE_ACCOUNT (as JSON string)
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) return makeResponse(500, { error: 'Google service account JSON missing in env' });

    let serviceAccount;
    try {
      // Allow either raw JSON string or base64 encoded value
      const raw = process.env.GOOGLE_SERVICE_ACCOUNT.trim();
      serviceAccount = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (e) {
      return makeResponse(500, { error: 'Invalid GOOGLE_SERVICE_ACCOUNT value', detail: String(e) });
    }

    const jwt = new google.auth.JWT(
      serviceAccount.client_email,
      null,
      serviceAccount.private_key,
      ['https://www.googleapis.com/auth/spreadsheets'] // readonly + update
    );
    await jwt.authorize();

    const sheets = google.sheets({ version: 'v4', auth: jwt });
    const SPREADSHEET_ID = process.env.SHEET_ID;
    if (!SPREADSHEET_ID) return makeResponse(500, { error: 'SHEET_ID missing in env' });

    // read data starting at row2 (skip header)
    const RANGE = process.env.SHEET_RANGE || 'Orders!A2:G';
    const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: RANGE });
    const rows = sheetRes.data.values || [];

    // Find the row index where col A === orderRef
    let foundRowIndex = -1;
    let foundRow = null;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toString() === orderRef) {
        foundRowIndex = i; // zero-based for rows[]
        foundRow = rows[i];
        break;
      }
    }
    if (!foundRow) return makeResponse(404, { error: 'orderRef not found in sheet' });

    // Columns: A: orderRef, B: finalDriveFileId, C: finalDriveViewLink, D: finalDirectDownload
    const fileId = foundRow[1] || null;
    const viewLinkFromSheet = foundRow[2] || null;
    let viewLink = viewLinkFromSheet;
    let directDownloadLink = foundRow[3] || null;
    if (!viewLink && fileId) viewLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
    if (!directDownloadLink && fileId) directDownloadLink = `https://docs.google.com/uc?export=download&id=${fileId}`;

    // --- 4) Update sheet: status & deliveredAt (optional but recommended) ---
    const deliveredAt = new Date().toISOString();
    // row number in sheet = 2 + foundRowIndex (because we started at A2)
    const rowNumber = 2 + foundRowIndex;
    // Prepare update to columns F (status) and G (deliveredAt)
    const updateRange = `Orders!F${rowNumber}:G${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: updateRange,
      valueInputOption: 'RAW',
      requestBody: { values: [['delivered', deliveredAt]] }
    });

    // --- 5) Return success + links ---
    return makeResponse(200, {
      success: true,
      viewLink,
      directDownloadLink
    });

  } catch (err) {
    console.error('verify-paypal error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'internal_server_error', detail: String(err) })
    };
  }
};
