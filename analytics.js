const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'analytics.json');

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
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read analytics data:', err.message);
    return { users: {}, downloads: [] };
  }
}

function saveData(data) {
  ensureDataFile();

  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function now() {
  return new Date().toISOString();
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
    sizeMB: 0,
  };

  data.downloads.push(download);
  saveData(data);

  return download.id;
}

function finishDownload(downloadId, status, sizeMB = 0) {
  const data = loadData();

  const download = data.downloads.find((item) => item.id === downloadId);

  if (!download) return;

  download.completedAt = now();
  download.status = status;
  download.sizeMB = Number(sizeMB) || 0;

  saveData(data);
}

function countSince(items, field, milliseconds) {
  const cutoff = Date.now() - milliseconds;

  return items.filter(
    (item) => new Date(item[field]).getTime() >= cutoff
  ).length;
}

function getStats() {
  const data = loadData();

  const users = Object.values(data.users);
  const downloads = data.downloads;

  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;

  const successfulDownloads = downloads.filter(
    (download) => download.status === 'completed'
  );

  const failedDownloads = downloads.filter(
    (download) => download.status === 'failed'
  );

  const cancelledDownloads = downloads.filter(
    (download) => download.status === 'cancelled'
  );

  const totalDataMB = successfulDownloads.reduce(
    (total, download) => total + (Number(download.sizeMB) || 0),
    0
  );

  return {
    totalUsers: users.length,

    newUsersToday: countSince(users, 'firstSeen', dayMs),
    newUsersThisWeek: countSince(users, 'firstSeen', weekMs),
    newUsersThisMonth: countSince(users, 'firstSeen', monthMs),

    activeToday: countSince(users, 'lastSeen', dayMs),
    activeThisWeek: countSince(users, 'lastSeen', weekMs),
    activeThisMonth: countSince(users, 'lastSeen', monthMs),

    totalDownloads: downloads.length,
    successfulDownloads: successfulDownloads.length,
    failedDownloads: failedDownloads.length,
    cancelledDownloads: cancelledDownloads.length,

    totalDataMB,
  };
}

module.exports = {
  trackUser,
  startDownload,
  finishDownload,
  getStats,
};
