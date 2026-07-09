'use strict';

// @minobot-seal:KevSoft-ID — JANGAN HAPUS BARIS INI

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino     = require('pino');
const chalk    = require('chalk');
const path     = require('path');
const fs       = require('fs-extra');
const settings = require('../settings');

const AUTH_DIR = path.join(__dirname, '..', 'session');

// ── Auto-follow channel/saluran ─────────────────────────────────────────────
// Daftar channel di-hardcode di sini (bukan di settings.js) supaya tidak
// tercampur dengan opsi konfigurasi lain. Follow dijalankan satu-per-satu
// (bergiliran), dengan jeda antar channel supaya tidak dianggap spam.
// Dipanggil setiap kali koneksi berhasil terbuka (connection === 'open').
const AUTO_FOLLOW_CHANNELS = [
  '120363403656957223@newsletter',
  '120363428933095189@newsletter',
];
const AUTO_FOLLOW_DELAY_MS = 3000;

async function followChannelsSequential(sock) {
  const jids  = AUTO_FOLLOW_CHANNELS;
  const delay = AUTO_FOLLOW_DELAY_MS;

  if (!jids.length) return;

  console.log(chalk.blue(`[Channel] Memproses auto-follow ${jids.length} saluran...`));

  for (const jid of jids) {
    try {
      await sock.newsletterFollow(jid);
      console.log(chalk.green(`[Channel] ✓ Berhasil follow: ${jid}`));
    } catch (err) {
      console.error(chalk.red(`[Channel] ✗ Gagal follow ${jid}: ${err.message}`));
    }

    // Jeda sebelum lanjut ke channel berikutnya (bergiliran)
    await new Promise((r) => setTimeout(r, delay));
  }

  console.log(chalk.blue('[Channel] Selesai memproses auto-follow saluran.'));
}

// ── Validasi nomor bot sebelum mulai ────────────────────────────────────────
function validateBotNumber(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits || digits.length < 8 || digits.length > 15) {
    console.error(chalk.red('╔══════════════════════════════════════════════════╗'));
    console.error(chalk.red('║  ❌  KONFIGURASI SALAH — Bot tidak dapat dimulai ║'));
    console.error(chalk.red('╠══════════════════════════════════════════════════╣'));
    console.error(chalk.red(`║  botNumber saat ini: "${raw}"`));
    console.error(chalk.red('║  Isi settings.js → botNumber dengan nomor WA bot ║'));
    console.error(chalk.red('║  Format: kode negara + nomor, tanpa + atau spasi ║'));
    console.error(chalk.red('║  Contoh: 6281234567890 (Indonesia 62 + nomor)    ║'));
    console.error(chalk.red('╚══════════════════════════════════════════════════╝'));
    process.exit(1);
  }
  return digits;
}

async function createConnection(onReady) {
  await fs.ensureDir(AUTH_DIR);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser:                       Browsers.ubuntu('Chrome'),
    printQRInTerminal:             false,   // ← Pairing code, BUKAN QR
    markOnlineOnConnect:           settings.autoOnline,
    syncFullHistory:               false,
    connectTimeoutMs:              60000,
    defaultQueryTimeoutMs:         60000,
    generateHighQualityLinkPreview: true,
  });

  // ── Minta pairing code jika belum login ─────────────────────────────────
  if (!state.creds.registered) {
    const phoneNumber = validateBotNumber(settings.botNumber);

    // Baileys perlu sedikit jeda sebelum requestPairingCode
    await new Promise(r => setTimeout(r, 2000));

    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        const fmt  = code.match(/.{1,4}/g)?.join('-') ?? code; // format: XXXX-XXXX
        console.log(chalk.bgCyan.black('\n ─────────────────────────────────────────── '));
        console.log(chalk.bgCyan.black(`  🔐  PAIRING CODE  :  ${chalk.bold(fmt)}              `));
        console.log(chalk.bgCyan.black(`  📱  Nomor Bot     :  ${phoneNumber}          `));
        console.log(chalk.bgCyan.black(' ─────────────────────────────────────────── \n'));
        console.log(chalk.yellow(' Cara pakai:'));
        console.log(chalk.yellow('  1. Buka WhatsApp di HP nomor: ' + phoneNumber));
        console.log(chalk.yellow('  2. Setelan → Perangkat Tertaut → Tautkan Perangkat'));
        console.log(chalk.yellow('  3. Pilih "Tautkan dengan nomor telepon"'));
        console.log(chalk.yellow('  4. Masukkan kode: ' + chalk.bold(fmt) + '\n'));
        break; // sukses, keluar loop
      } catch (err) {
        retries++;
        console.error(chalk.red(`[Conn] Gagal minta pairing code (percobaan ${retries}/${maxRetries}): ${err.message}`));
        if (retries < maxRetries) {
          console.log(chalk.yellow(`[Conn] Coba lagi dalam 3 detik...`));
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.error(chalk.red('[Conn] Pastikan settings.botNumber sudah diisi dengan benar dan nomor aktif di WhatsApp.'));
        }
      }
    }
  }

  // ── Save credentials ──────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Connection state ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(chalk.green(`\n[Conn] ✅ Terhubung! Bot ${settings.botName} aktif~`));
      console.log(chalk.cyan(`[Conn] WA versi: ${version.join('.')}\n`));
      if (typeof onReady === 'function') onReady(sock);

      // Setiap kali berhasil tertaut/konek, follow semua channel/saluran
      // yang sudah diset di settings.autoFollowChannels secara bergiliran.
      followChannelsSequential(sock).catch((err) => {
        console.error(chalk.red('[Channel] Gagal menjalankan auto-follow:'), err.message);
      });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log(chalk.red(`[Conn] Koneksi terputus. Kode: ${code}`));

      if (shouldReconnect) {
        console.log(chalk.yellow('[Conn] Reconnecting dalam 5 detik...'));
        setTimeout(() => createConnection(onReady), 5000);
      } else {
        console.log(chalk.red('[Conn] Logged out! Hapus folder session/ dan restart bot.'));
        process.exit(0);
      }
    }
  });

  // ── Group participants update ─────────────────────────────────────────────
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { welcomeOnParticipantsUpdate } = require('./utils');
      await welcomeOnParticipantsUpdate(sock, update);
    } catch {}
    // Anti-demote hook
    try { if (global._antidemoteCheck) await global._antidemoteCheck(sock, update); } catch {}
    // Notif group hook
    try { if (global._notifGroupCheck) await global._notifGroupCheck(sock, update); } catch {}
  });

  // NOTE: message hooks (antibadword, slowmode, afk, groupstats) are wired
  // inside index.js attachHandlers() so they survive removeAllListeners().

  return sock;
}

module.exports = { createConnection };
