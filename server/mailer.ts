/**
 * Sends the credential claim ("magic link") email.
 *
 * Transport is chosen at runtime:
 *  - QUORUM_SMTP_URL set  → nodemailer (a lazy import; `npm i nodemailer` is only
 *    needed for real sending).
 *  - unset (dev only)     → the link is written to the API console so the flow is
 *    still walkable without a mail server. `server/config.ts` requires the URL
 *    when NODE_ENV=production, so this branch cannot run in prod.
 */
import { config } from './config';

let transportPromise: Promise<{ sendMail: (opts: unknown) => Promise<unknown> } | null> | null = null;

async function getTransport() {
  if (!config.email.smtpUrl) return null;
  if (!transportPromise) {
    transportPromise = import('nodemailer' as string)
      .then((mod: any) => (mod.default ?? mod).createTransport(config.email.smtpUrl))
      .catch((err: any) => {
        console.error(
          '[mailer] QUORUM_SMTP_URL is set but nodemailer is not installed. ' +
            'Run `npm i nodemailer` or unset the URL to fall back to console output.',
          err?.message ?? err,
        );
        throw err;
      });
  }
  return transportPromise;
}

export async function sendMagicLink(email: string, link: string): Promise<void> {
  const minutes = Math.round(config.email.magicTtlMs / 60_000);
  const text =
    `Someone asked for a Quorum reporter credential for this address.\n\n` +
    `Open this link within ${minutes} minutes to claim it:\n\n${link}\n\n` +
    `If it wasn't you, ignore this email — nothing happens without the link.`;

  const transport = await getTransport();
  if (!transport) {
    console.log(`\n[mailer:dev] credential claim link for ${email}\n   ${link}\n`);
    return;
  }
  await transport.sendMail({
    to: email,
    from: config.email.from,
    subject: 'Your Quorum reporter credential',
    text,
  });
}
