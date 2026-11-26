// Sending e-mail (server only). SMTP settings come from the environment and are never stored in the database or sent to the browser:
//   SILPI_SMTP_HOST, SILPI_SMTP_PORT (default 587; 465 uses an encrypted connection from the start), SILPI_SMTP_USER, SILPI_SMTP_PASSWORD, SILPI_SMTP_FROM
// Until SMTP is set up the message is printed in the server console instead (so a password reset can still be tried on your own computer) and is NOT sent.
import nodemailer from "nodemailer";

export type Mail = { to: string; subject: string; text: string };
export type MailResult = { delivered: boolean; logged: boolean };
export type MailTransport = (mail: Mail & { from: string }) => Promise<void>;

let override: MailTransport | null = null;
/** Tests replace the transport so no network is used. */
export const setMailTransport = (t: MailTransport | null): void => { override = t; };

export const smtpConfigured = (env: Record<string, string | undefined> = process.env): boolean => !!(env.SILPI_SMTP_HOST?.trim() && env.SILPI_SMTP_FROM?.trim());

const fromAddress = () => process.env.SILPI_SMTP_FROM?.trim() || "SILPI AI <no-reply@localhost>";

async function viaSmtp(mail: Mail & { from: string }): Promise<void> {
  const port = Number(process.env.SILPI_SMTP_PORT) || 587;
  const user = process.env.SILPI_SMTP_USER?.trim();
  const transporter = nodemailer.createTransport({
    host: process.env.SILPI_SMTP_HOST!.trim(),
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    ...(user ? { auth: { user, pass: process.env.SILPI_SMTP_PASSWORD ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  await transporter.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text });
}

/** Sends a message, or prints it when SMTP is not set up. Throws when the SMTP server refuses it: the caller decides what the person is told. */
export async function sendMail(mail: Mail): Promise<MailResult> {
  const full = { ...mail, from: fromAddress() };
  if (override) { await override(full); return { delivered: true, logged: false }; }
  if (smtpConfigured()) { await viaSmtp(full); return { delivered: true, logged: false }; }
  console.log(`SILPI MAIL (SMTP is not set up, so this was NOT sent)\n  to: ${mail.to}\n  subject: ${mail.subject}\n${mail.text.split("\n").map((l) => `  ${l}`).join("\n")}`);
  return { delivered: false, logged: true };
}
