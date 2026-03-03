import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { db } from './db/index.js';
import type { JobRow } from './db/search.js';

// --- Environment ---

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) {
  console.error('Error: BOT_TOKEN is not set in .env');
  process.exit(1);
}

if (!CHAT_ID) {
  console.error('Error: CHAT_ID is not set in .env');
  process.exit(1);
}

const chatId = Number(CHAT_ID);
const bot = new Bot(BOT_TOKEN);

// --- Commands ---

async function cmdSend(text: string): Promise<void> {
  const msg = await bot.api.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
  });
  console.log(msg.message_id);
}

async function cmdSendJob(jobId: string): Promise<void> {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) {
    console.error(`Error: Job not found: ${jobId}`);
    process.exit(1);
  }

  const description = job.description
    ? job.description.slice(0, 500) + (job.description.length > 500 ? '...' : '')
    : null;

  const lines = [
    `\uD83D\uDCBC *${job.title}*`,
    '',
    `\uD83D\uDCB0 ${job.budget ?? 'N/A'} | ${job.job_type ?? 'N/A'}`,
    `\u2B50 Relevance: ${job.relevance_score ?? 'N/A'}/10`,
    `\uD83D\uDCDD ${job.relevance_reason ?? 'N/A'}`,
    '',
    `\uD83D\uDC64 Client: ${job.client_location ?? 'N/A'}, rating ${job.client_rating ?? 'N/A'}, ${job.client_hires ?? 'N/A'} hires, spent ${job.client_spent ?? 'N/A'}`,
    `\uD83D\uDCCA Proposals: ${job.proposals_count ?? 'N/A'}`,
    `\uD83D\uDD50 Posted: ${job.posted_at ?? 'N/A'}`,
    '',
    ...(description ? [description, ''] : []),
    `\uD83D\uDD17 ${job.url}`,
  ];

  const keyboard = new InlineKeyboard()
    .text('\u2705 Apply', `approve-${jobId}`)
    .text('\u274C Skip', `skip-${jobId}`);

  let msg;
  try {
    msg = await bot.api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch {
    // Markdown parse failed (special chars in title/description), retry without formatting
    msg = await bot.api.sendMessage(chatId, lines.join('\n'), {
      reply_markup: keyboard,
    });
  }

  db.prepare(
    'UPDATE jobs SET status = ?, telegram_message_id = ?, updated_at = unixepoch() WHERE id = ?',
  ).run('sent', msg.message_id, jobId);

  console.log(msg.message_id);
}

async function cmdSendProposal(jobId: string): Promise<void> {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) {
    console.error(`Error: Job not found: ${jobId}`);
    process.exit(1);
  }

  if (!job.proposal_text) {
    console.error(`Error: No proposal text for job: ${jobId}`);
    process.exit(1);
  }

  const lines = [
    `\uD83D\uDCDD *Proposal for:* ${job.title}`,
    '',
    job.proposal_text,
    '',
    job.bid_amount ? `\uD83D\uDCB0 Bid: ${job.bid_amount}` : '',
    '',
    `\uD83D\uDD17 ${job.url}`,
  ].filter(Boolean);

  const keyboard = new InlineKeyboard()
    .text('\u2705 Send', `confirm-${jobId}`)
    .text('\u274C Cancel', `cancel-${jobId}`)
    .text('\uD83D\uDD04 Redo', `redo-${jobId}`);

  let msg;
  try {
    msg = await bot.api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch {
    // Markdown parse failed (special chars in proposal text), retry without formatting
    msg = await bot.api.sendMessage(chatId, lines.join('\n'), {
      reply_markup: keyboard,
    });
  }

  // Save proposal message_id so /report can link to the proposal, not the job card
  db.prepare(
    'UPDATE jobs SET telegram_proposal_message_id = ?, updated_at = unixepoch() WHERE id = ?',
  ).run(msg.message_id, jobId);

  console.log(msg.message_id);
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'send': {
      const text = args[1];
      if (!text) {
        console.error('Usage: tg send "<text>"');
        process.exit(1);
      }
      await cmdSend(text);
      break;
    }
    case 'send-job': {
      const jobId = args[1];
      if (!jobId) {
        console.error('Usage: tg send-job <jobId>');
        process.exit(1);
      }
      await cmdSendJob(jobId);
      break;
    }
    case 'send-proposal': {
      const jobId = args[1];
      if (!jobId) {
        console.error('Usage: tg send-proposal <jobId>');
        process.exit(1);
      }
      await cmdSendProposal(jobId);
      break;
    }
    default:
      console.error('Usage: tg <command> [args]');
      console.error('Commands: send, send-job, send-proposal');
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
