const crypto = require('crypto');

const FIREBASE_DB = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';

function emailToKey(email) {
  return email.toLowerCase().trim().replace(/[.@]/g, '_');
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

async function fbPut(path, value) {
  const { default: fetch } = await import('node-fetch').catch(() => {
    throw new Error('node-fetch not available');
  });
  const r = await fetch(FIREBASE_DB + path + '.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error('Firebase PUT failed: HTTP ' + r.status);
  return r.json();
}

const PASSWORD = 'HP@2025';
const PASSWORD_HASH = hashPassword(PASSWORD);

const users = [
  { email: 'kriti.tiwari@wiom.in',      name: 'Kriti Tiwari' },
  { email: 'shivani.sharma@wiom.in',     name: 'Shivani Sharma' },
  { email: 'poonam.singh@wiom.in',       name: 'Poonam Singh' },
  { email: 'deepak@wiom.in',             name: 'Deepak' },
  { email: 'noor.ahmad@wiom.in',         name: 'Noor Ahmad' },
  { email: 'vivek.pandey@wiom.in',       name: 'Vivek Pandey' },
  { email: 'dhananjay.shukla@wiom.in',   name: 'Dhananjay Shukla' },
  { email: 'nitin.diwakar@wiom.in',      name: 'Nitin Diwakar' },
  { email: 'saddam.husain@wiom.in',      name: 'Saddam Husain' },
  { email: 'sandeep.kumar@wiom.in',      name: 'Sandeep Kumar' },
];

(async () => {
  for (const u of users) {
    const key = emailToKey(u.email);
    const payload = {
      email: u.email,
      name: u.name,
      team: 'NQT',
      role: 'user',
      password_hash: PASSWORD_HASH
    };
    try {
      await fbPut('/cases/__users__/' + key, payload);
      console.log('✓ Added:', u.email);
    } catch (e) {
      console.error('✗ Failed:', u.email, e.message);
    }
  }
  console.log('\nDone. Password for all users: HP@2025');
})();
