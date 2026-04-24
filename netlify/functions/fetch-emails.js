const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only POST allowed
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  // Parse body safely
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // Validate required fields
  const { email, appPassword, folder, startIdx, endIdx } = body;
  if (!email || !appPassword || !folder || startIdx === undefined || endIdx === undefined) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing required fields' }),
    };
  }
  if (startIdx < 0 || endIdx < startIdx) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid index range' }),
    };
  }

  // ========== MAIN LOGIC (wrapped in try/catch) ==========
  try {
    const imapConfig = {
      imap: {
        user: email,
        password: appPassword,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
    };

    const connection = await imaps.connect(imapConfig);
    const folderNames = { inbox: 'INBOX', spam: '[Gmail]/Spam' };
    const imapFolder = folderNames[folder] || 'INBOX';

    await connection.openBox(imapFolder);

    const searchCriteria = ['ALL'];
    const fetchOptions = { bodies: ['HEADER'], struct: true };

    const messages = await connection.search(searchCriteria, fetchOptions);

    messages.sort((a, b) => {
      const da = new Date(a.attributes.date);
      const db = new Date(b.attributes.date);
      return db - da;
    });

    const total = messages.length;
    const selected = messages.slice(startIdx, endIdx + 1);

    const results = [];
    for (const msg of selected) {
      const headerPart = msg.parts.find(p => p.which === 'HEADER');
      if (!headerPart) continue;
      const parsed = await parseEmailHeaders(headerPart.body, msg.attributes);
      results.push(parsed);
    }

    connection.end();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ emails: results, totalAvailable: total, error: null }),
    };
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal Server Error' }),
    };
  }
};

// parseEmailHeaders and extractHeader functions remain unchanged (from previous code)
// ... (include them here)