'use strict';

/**
 * Email service — Nodemailer wrapper.
 *
 * Development (no SMTP_HOST env var):
 *   Uses Ethereal fake SMTP. Emails are captured and viewable at the preview
 *   URL printed in the console. No real emails are sent.
 *
 * Production (set env vars):
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (true/false),
 *   SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * Free SMTP relay options for hosting:
 *   - Brevo (Sendinblue): 300 emails/day — https://www.brevo.com
 *   - Mailersend:         3000 emails/month — https://www.mailersend.com
 *   - Resend:             100 emails/day   — https://resend.com
 */

const nodemailer = require('nodemailer');

const APP_NAME = 'Comparte Ruta Granada';
let transporter = null;

async function initTransporter() {
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host:              process.env.SMTP_HOST,
      port:              parseInt(process.env.SMTP_PORT || '587'),
      secure:            process.env.SMTP_SECURE === 'true',
      auth:              { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 8000,
      socketTimeout:     8000,
    });
    console.log(`[SMTP] Relay configurado: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
  } else {
    const acc = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: acc.user, pass: acc.pass },
      connectionTimeout: 8000,
      socketTimeout:     8000,
    });
    console.log(`[SMTP] Modo desarrollo — Ethereal Email`);
    console.log(`[SMTP] Bandeja de entrada: https://ethereal.email/messages`);
    console.log(`[SMTP] Credenciales: ${acc.user} / ${acc.pass}`);
  }
}

async function sendEmail({ to, subject, text }) {
  if (!to?.trim()) {
    console.log(`[EMAIL] Destinatario vacío — omitido: "${subject}"`);
    return;
  }
  try {
    if (!transporter) await initTransporter();
    const from = `"${APP_NAME}" <${process.env.SMTP_FROM || 'noreply@comparteruta.es'}>`;
    const info  = await transporter.sendMail({ from, to, subject, text });
    const url   = nodemailer.getTestMessageUrl(info);
    if (url) console.log(`[EMAIL PREVIEW] ${url}`);
    else     console.log(`[EMAIL] Enviado → ${to} | "${subject}"`);
  } catch (err) {
    console.error(`[EMAIL ERROR] ${err.message}`);
  }
}

module.exports = { initTransporter, sendEmail };
