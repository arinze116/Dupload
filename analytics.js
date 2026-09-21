const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'analytics.json');

const ANALYTICS_TIMEZONE =
  process.env.ANALYTICS_TIMEZONE || 'Africa/Lagos';

const EMPTY_DATA = {
  users: {},
  downloads: [],
};

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY_DATA, null, 2));
  }
}

function loadData() {
  ensureDataFile();

  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    return {
      users: data.users || {},
      downloads: Array.isArray(data.downloads) ? data.downloads : [],
    };
  } catch (err) {
    console.error('Failed to read analytics data:', err.message);
    return { users: {}, downloads: [] };
  }
}

function saveData(data) {
  ensureDataFile();

  const tempFile = `${DATA_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  fs.renameSync(tempFile, DATA_FILE);
}

function now() {
  return new Date().toISOString();
}

function getDateKey(timestamp = new Date()) {
  const date = timestamp instanceof Date
    ? timestamp
    : new Date(timestamp);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ANALYTICS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function getWeekStartKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  date.setUTCDate(date.getUTCDate() - daysSinceMonday);

  return date.toISOString().slice(0, 10);
}

function getMonthStartKey(dateKey) {
  return `${dateKey.slice(0, 7)}-01`;
}

function isOnOrAfter(dateKey, startKey) {
  return dateKey >= startKey;
}

function trackUser(userId) {
  if (!userId) return;

  const data = loadData();
  const id = String(userId);
  const timestamp = now();

  if (!data.users[id]) {
    data.users[id] = {
      firstSeen: timestamp,
      lastSeen: timestamp,
    };
  } else {
    data.users[id].lastSeen = timestamp;
  }

  saveData(data);
}

function startDownload(userId) {
  const data = loadData();

  const download = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: String(userId),
    startedAt: now(),
    completedAt: null,
    status: 'started',
    outputSizeMB: 0,
  };

  data.downloads.push(download);
  saveData(data);

  return download.id;
}

function finishDownload(downloadId, status, sizeMB = 0) {
  const data = loadData();

  const download = data.downloads.find(
    (item) => item.id === downloadId
  );

  if (!download) return;

  download.completedAt = now();
  download.status = status;

  // Keep compatibility with old analytics records while using
  // the more accurate name for new records.
  download.outputSizeMB = Number(sizeMB) || 0;
  download.sizeMB = download.outputSizeMB;

  saveData(data);
}

function recoverStaleDownloads() {
  const data = loadData();
  let recovered = 0;

  for (const download of data.downloads) {
    if (download.status === 'started') {
      download.status = 'interrupted';
      download.completedAt = now();
      download.failureReason = 'bot_restart';
      recovered++;
    }
  }

  if (recovered > 0) {
    saveData(data);
    console.log(`Analytics: recovered ${recovered} interrupted download(s).`);
  }

  return recovered;
}

function getOutputSizeMB(download) {
  if (download.outputSizeMB !== undefined) {
    return Number(download.outputSizeMB) || 0;
  }

  return Number(download.sizeMB) || 0;
}

function getStats() {
  const data = loadData();

  const users = Object.values(data.users);
  const downloads = data.downloads;

  const todayKey = getDateKey();
  const weekStartKey = getWeekStartKey(todayKey);
  const monthStartKey = getMonthStartKey(todayKey);

  const successfulDownloads = downloads.filter(
    (download) => download.status === 'completed'
  );

  const failedDownloads = downloads.filter(
    (download) => download.status === 'failed'
  );

  const cancelledDownloads = downloads.filter(
    (download) => download.status === 'cancelled'
  );

  const interruptedDownloads = downloads.filter(
    (download) => download.status === 'interrupted'
  );

  const inProgressDownloads = downloads.filter(
    (download) => download.status === 'started'
  );

  const terminalDownloads = downloads.filter(
    (download) =>
      ['completed', 'failed', 'cancelled', 'interrupted']
        .includes(download.status)
  );

  const totalDataMB = successfulDownloads.reduce(
    (total, download) =>
      total + getOutputSizeMB(download),
    0
  );

  const newUsersToday = users.filter(
    (user) => getDateKey(user.firstSeen) === todayKey
  ).length;

  const newUsersThisWeek = users.filter(
    (user) =>
      isOnOrAfter(getDateKey(user.firstSeen), weekStartKey)
  ).length;

  const newUsersThisMonth = users.filter(
    (user) =>
      isOnOrAfter(getDateKey(user.firstSeen), monthStartKey)
  ).length;

  const activeToday = users.filter(
    (user) => getDateKey(user.lastSeen) === todayKey
  ).length;

  const activeThisWeek = users.filter(
    (user) =>
      isOnOrAfter(getDateKey(user.lastSeen), weekStartKey)
  ).length;

  const activeThisMonth = users.filter(
    (user) =>
      isOnOrAfter(getDateKey(user.lastSeen), monthStartKey)
  ).length;

  return {
    timezone: ANALYTICS_TIMEZONE,
    today: todayKey,

    totalUsers: users.length,

    newUsersToday,
    newUsersThisWeek,
    newUsersThisMonth,

    activeToday,
    activeThisWeek,
    activeThisMonth,

    totalDownloads: terminalDownloads.length,
    successfulDownloads: successfulDownloads.length,
    failedDownloads: failedDownloads.length,
    cancelledDownloads: cancelledDownloads.length,
    interruptedDownloads: interruptedDownloads.length,
    inProgressDownloads: inProgressDownloads.length,

    totalDataMB,
  };
}

module.exports = {
  trackUser,
  startDownload,
  finishDownload,
  recoverStaleDownloads,
  getStats,
};
