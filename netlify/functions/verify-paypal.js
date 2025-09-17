const { google } = require('googleapis');
const fetch = require('node-fetch'); // netlify supports node-fetch out of the box

exports.handler = async (event) => {
  try {
    const { orderId, ref } = JSON.parse(event.body || '{}');
    if (!orderId || !ref) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing orderId or ref' })
      };
    }

    // === 1. Verify PayPal payment ===
    // (Assuming you set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET as env variables)
    const tokenResponse = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(
            process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET
          ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    const orderResponse = await fetch(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );
    const orderData = await orderResponse.json();

    if (!orderData || orderData.status !== 'COMPLETED') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Payment not completed yet.' })
      };
    }

    // === 2. Lookup Google Sheets row for this ref ===
    // Parse service account credentials from env
    let creds = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!creds) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT env var');
    try {
      creds = JSON.parse(creds);
    } catch {
      // maybe base64 encoded
      creds = JSON.parse(Buffer.from(creds, 'base64').toString());
    }

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheetId = process.env.GOOGLE_SHEET_ID; // add this env var in Netlify
    const range = 'Orders!A2:H'; // adjust your tab + range
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });

    const rows = response.data.values || [];
    // assuming your columns: [ref, redditUser, directDownloadUrl, shareableUrl, ...]
    const row = rows.find(r => r[0] === ref);
    if (!row) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'OrderRef not found in database' })
      };
    }

    // e.g. row[2] = directDownloadUrl, row[3] = shareableUrl
    const directDownloadUrl = row[2];
    const shareableUrl = row[3];

    // === 3. Return the URLs to the front-end ===
    return {
      statusCode: 200,
      body: JSON.stringify({
        directDownloadUrl,
        shareableUrl
      })
    };
  } catch (err) {
    console.error('verify-paypal error', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Payment verification failed: internal_server_error' })
    };
  }
};
