require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OAuth = require('oauth-1.0a');
const CryptoJS = require('crypto-js');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '2mb' }));

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({
  origin: allowedOrigin === '*' ? true : allowedOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

const CONSUMER_KEY = process.env.TRIPLESEAT_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.TRIPLESEAT_CONSUMER_SECRET;
const API_BASE = process.env.TRIPLESEAT_API_BASE || 'https://api.tripleseat.com/v1';

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error('Missing TRIPLESEAT_CONSUMER_KEY or TRIPLESEAT_CONSUMER_SECRET');
  process.exit(1);
}

const oauth = OAuth({
  consumer: { key: CONSUMER_KEY, secret: CONSUMER_SECRET },
  signature_method: 'HMAC-SHA1',
  hash_function(baseString, key) {
    return CryptoJS.HmacSHA1(baseString, key).toString(CryptoJS.enc.Base64);
  },
});

async function tripleseatGet(endpoint, params = {}) {
  const url = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const requestData = { url: url.toString(), method: 'GET' };
  const authHeader = oauth.toHeader(oauth.authorize(requestData, { key: '', secret: '' }));
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { ...authHeader, 'Accept': 'application/json' },
  });
  if (!res.ok) { const body = await res.text(); throw new Error('Tripleseat ' + res.status + ': ' + body); }
  return res.json();
}

app.get('/api/lookup', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const [leadsRes, eventsRes] = await Promise.all([
      tripleseatGet('/leads/search.json', { query: email }).catch(() => ({ results: [] })),
      tripleseatGet('/events/search.json', { query: email }).catch(() => ({ results: [] })),
    ]);
    const leads = leadsRes.results || leadsRes.leads || [];
    const events = eventsRes.results || eventsRes.events || [];
    const inquiries = [];
    for (const lead of leads) {
      const l = lead.lead || lead;
      inquiries.push({
        source: 'lead', id: l.id,
        name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.contact_name || '',
        email: l.email_address || l.email || email,
        phone: l.phone_number || l.phone || '',
        eventDate: l.event_date || l.event_start || '',
        guestCount: l.guest_count || l.guests || 0,
        eventType: l.event_type || l.event_description || '',
        room: l.room_name || l.location || '',
        notes: l.additional_information || l.description || '',
        status: l.status || 'new', createdAt: l.created_at || '',
      });
    }
    for (const event of events) {
      const e = event.event || event;
      inquiries.push({
        source: 'event', id: e.id,
        name: e.contact_name || [e.first_name, e.last_name].filter(Boolean).join(' ') || '',
        email: e.email_address || e.contact_email || email,
        phone: e.phone_number || '',
        eventDate: e.event_start || e.event_date || '',
        guestCount: e.guest_count || e.attendance || 0,
        eventType: e.type_name || e.event_type || '',
        room: e.room_name || e.site_name || '',
        notes: e.description || '', status: e.status || '',
        createdAt: e.created_at || '', eventEnd: e.event_end || '',
        accountName: e.account_name || '',
      });
    }
    inquiries.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json({ success: true, count: inquiries.length, inquiries });
  } catch (err) {
    console.error('Lookup error:', err.message);
    return res.status(502).json({ error: 'Could not reach Tripleseat. Please try again.' });
  }
});

app.get('/api/sites', async (req, res) => {
  try {
    const data = await tripleseatGet('/sites.json');
    return res.json({ success: true, sites: data.results || data.sites || data });
  } catch (err) { return res.status(502).json({ error: 'Could not fetch sites' }); }
});

app.post('/api/submit', async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.guestEmail) return res.status(400).json({ error: 'Missing event data' });
  try {
    await sendNotificationEmail(payload);
    console.log('Event submission received:', payload.guestEmail, payload.room);
    return res.json({ success: true, message: 'Event configuration received!' });
  } catch (err) {
    console.error('Submit error:', err.message);
    return res.status(500).json({ error: 'Submission received but notification failed.' });
  }
});

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) { console.warn('SMTP not configured'); return null; }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendNotificationEmail(data) {
  const t = getTransporter();
  if (!t) { console.log('Email skipped (SMTP not configured)'); return; }
  const roomNames = { 'g-room': 'The G Room', 'pdr': 'Private Dining Room', 'main': 'Main Dining Room' };
  const pkgNames = { 1: 'Primo', 2: 'Secondo', 3: 'Gran Lusso' };
  const barNames = { signature: 'Signature Open Bar', house: 'House Open Bar', consumption: 'Consumption Tab' };
  const addonNames = { prosecco: 'The Tree - Prosecco', espresso: 'The Tree - Espresso Martini', tiramisu: 'Tiramisu Tower', 'prosecco-tower': 'Prosecco Tower' };
  const svcNames = { plated: 'Plated', family: 'For the Table', cocktail: 'Cocktail Style' };
  const addons = (data.addons || []).map(a => addonNames[a] || a).join(', ') || 'None';
  const enhancements = (data.enhancements || []).map(e => e).join(', ') || 'None';
  const html = '<div style="font-family:Arial;max-width:600px;margin:0 auto;background:#111;color:#f2f0eb;padding:32px;border-radius:12px">' +
    '<h1 style="color:#C9A54E;font-size:22px;text-align:center">New Event Configuration</h1>' +
    '<p style="color:#999;font-size:13px;text-align:center">Submitted via Gigante Event Portal</p><hr style="border-color:#333">' +
    '<table style="width:100%;font-size:14px">' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Guest</td><td>' + (data.guestName||'N/A') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Email</td><td>' + data.guestEmail + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Phone</td><td>' + (data.guestPhone||'N/A') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Date</td><td>' + (data.eventDate||'TBD') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Guests</td><td>' + (data.guestCount||'TBD') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Room</td><td>' + (roomNames[data.room]||'TBD') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Package</td><td>' + (pkgNames[data.package]||'TBD') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Bar</td><td>' + (barNames[data.bar]||'TBD') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Style</td><td>' + (svcNames[data.serviceStyle]||'TBD') + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Experiences</td><td>' + addons + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Enhancements</td><td>' + enhancements + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Kids</td><td>' + (data.kidsCount||0) + '</td></tr>' +
    '<tr><td style="color:#C9A54E;padding:8px 0">Est. Total</td><td style="color:#C9A54E;font-weight:bold">' + (data.estimatedTotal||'N/A') + '</td></tr>' +
    '</table></div>';
  await t.sendMail({
    from: '"Gigante Event Portal" <' + process.env.SMTP_USER + '>',
    to: process.env.NOTIFY_EMAIL || 'ivana@gigantehospitality.com',
    cc: process.env.NOTIFY_EMAIL_CC || '',
    subject: 'New Event Config: ' + (data.guestName || data.guestEmail) + ' - ' + (roomNames[data.room] || 'Room TBD'),
    html,
  });
  console.log('Notification sent to', process.env.NOTIFY_EMAIL);
}

app.get('/', (req, res) => {
  res.json({ service: 'Gigante Event Portal API', status: 'running', version: '1.0.0',
    endpoints: ['GET /api/lookup?email=...', 'GET /api/sites', 'POST /api/submit'] });
});
app.get('/api/health', (req, res) => { res.json({ status: 'ok', timestamp: new Date().toISOString() }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log('Gigante API Proxy running on port ' + PORT); });
