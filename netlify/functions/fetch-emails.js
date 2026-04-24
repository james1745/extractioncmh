const imaps = require('imap-simple');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { email, appPassword, folder, startIdx, endIdx } = body;
  if (!email || !appPassword || !folder || startIdx == null || endIdx == null) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
  }
  if (startIdx < 0 || endIdx < startIdx) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid index range' }) };
  }

  try {
    const connection = await imaps.connect({
      imap: {
        user: email,
        password: appPassword,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
    });

    const folderNames = { inbox: 'INBOX', spam: '[Gmail]/Spam' };
    const imapFolder = folderNames[folder] || 'INBOX';
    await connection.openBox(imapFolder);

    const messages = await connection.search(['ALL'], { bodies: ['HEADER'], struct: true });

    messages.sort((a, b) => new Date(b.attributes.date) - new Date(a.attributes.date));

    const total = messages.length;
    const selected = messages.slice(startIdx, endIdx + 1);

    const results = [];
    for (const msg of selected) {
      const headerPart = msg.parts.find(p => p.which === 'HEADER');
      if (!headerPart) continue;
      const rawHeader = headerPart.body.toString('utf-8');
      results.push(parseEmailHeaders(rawHeader, msg.attributes));
    }

    connection.end();

    return { statusCode: 200, headers, body: JSON.stringify({ emails: results, totalAvailable: total, error: null }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal Server Error' }) };
  }
};

// ====== Manual header parsing (no mailparser) ======

function parseEmailHeaders(headerText, attributes) {
  const lines = headerText.split('\n');

  // Sender IP – SPF header first
  let senderIP = 'NOT FOUND';
  const spfLines = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(received-spf|authentication-results):/i.test(t)) spfLines.push(t);
  }
  for (const line of spfLines) {
    const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (m) { senderIP = m[1]; break; }
  }

  if (senderIP === 'NOT FOUND') {
    const received = [];
    for (const line of lines) {
      if (/^Received:/i.test(line.trim())) received.push(line.trim());
    }
    if (received.length > 0) {
      const last = received[received.length - 1];
      const m = last.match(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/);
      if (m) senderIP = m[1];
    }
  }

  // From
  const fromRaw = extractHeader(headerText, 'from');
  let fromName = 'UNKNOWN', fromEmail = 'UNKNOWN';
  if (fromRaw) {
    const m = fromRaw.match(/^"?([^"]*)"?\s*<(.+?)>$/);
    if (m) {
      fromName = m[1].trim() || m[2];
      fromEmail = m[2].trim();
    } else if (fromRaw.includes('@')) {
      fromEmail = fromRaw.trim().replace(/^<|>$/g, '');
      fromName = fromEmail.split('@')[0];
    }
  }
  const domain = fromEmail.includes('@') ? fromEmail.split('@')[1] : 'UNKNOWN';

  // Subject
  const subjectRaw = extractHeader(headerText, 'subject') || '(no subject)';
  const subject = decodeMimeWords(subjectRaw);

  // Date
  const receivedDate = attributes.date ? new Date(attributes.date).toISOString() : new Date().toISOString();

  // Auth results
  const hdrLower = headerText.toLowerCase();
  let spf = 'NOT FOUND';
  if (/spf\s*=\s*pass/i.test(hdrLower) || /received-spf:\s*pass/i.test(hdrLower)) spf = 'PASS';
  else if (/spf\s*=\s*(fail|softfail|neutral)/i.test(hdrLower) || /received-spf:\s*(fail|softfail)/i.test(hdrLower)) spf = 'FAIL';

  let dkim = 'NOT FOUND';
  if (/dkim\s*=\s*pass/i.test(hdrLower)) dkim = 'PASS';
  else if (/dkim\s*=/i.test(hdrLower)) dkim = 'FAIL';

  let dmarc = 'NOT FOUND';
  if (/dmarc\s*=\s*pass/i.test(hdrLower)) dmarc = 'PASS';
  else if (/dmarc\s*=/i.test(hdrLower)) dmarc = 'FAIL';

  return { senderIP, domain, fromName, fromEmail, subject, receivedDate, spf, dkim, dmarc };
}

function extractHeader(text, name) {
  const regex = new RegExp(`^${name}:\\s*([^\\r\\n]*)`, 'im');
  const match = text.match(regex);
  if (!match) return null;
  let value = match[1];
  const rest = text.slice(match.index + match[0].length);
  const cont = rest.match(/^\s+[^\r\n]*/gm);
  if (cont) value += ' ' + cont.join(' ').replace(/\s+/g, ' ');
  return value.trim();
}

function decodeMimeWords(str) {
  if (!str) return str;
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      } else if (encoding.toUpperCase() === 'Q') {
        return text.replace(/_/g, ' ').replace(/=([A-F0-9]{2})/gi, (m, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
      }
    } catch {}
    return text;
  });
}
