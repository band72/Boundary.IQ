/**
 * emailService.js
 * Sends transactional emails via Resend (https://resend.com).
 * Falls back to console logging when RESEND_API_KEY is not set (dev/mock mode).
 *
 * Set RESEND_API_KEY and EMAIL_FROM in .env to activate:
 *   RESEND_API_KEY=re_...
 *   EMAIL_FROM=noreply@yourdomain.com
 *   EMAIL_FROM_NAME=Boundary.IQ
 */

const RESEND_KEY  = process.env.RESEND_API_KEY;
const FROM_ADDR   = process.env.EMAIL_FROM || 'noreply@boundary.iq';
const FROM_NAME   = process.env.EMAIL_FROM_NAME || 'Boundary.IQ';
const FROM        = `${FROM_NAME} <${FROM_ADDR}>`;
const APP_URL     = process.env.FRONTEND_URL || 'http://localhost:5174';
const MOCK_MODE   = !RESEND_KEY;

if (MOCK_MODE) {
  console.log('📧 Email service: mock mode (set RESEND_API_KEY to send real emails)');
}

// ── Core send function ────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html, text }) {
  if (MOCK_MODE) {
    console.log(`📧 [Mock Email] To: ${to} | Subject: ${subject}`);
    if (text) console.log(`   ${text.substring(0, 200)}`);
    return { id: 'mock', mockMode: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html, text }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }

  return res.json();
}

// ── Email templates ────────────────────────────────────────────────────────────

function baseHtml(title, body) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#090e1a;color:#e8eeff;margin:0;padding:0;}
  .wrap{max-width:560px;margin:40px auto;background:#0f1629;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;}
  .head{background:linear-gradient(135deg,#1a2748 0%,#0f1629 100%);padding:32px 36px;border-bottom:1px solid rgba(255,255,255,0.08);}
  .logo{font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.03em;}
  .logo span{color:#3d7fff;}
  .body{padding:32px 36px;}
  h1{font-size:22px;font-weight:800;color:#fff;margin:0 0 12px 0;}
  p{font-size:15px;line-height:1.6;color:#8899bb;margin:0 0 16px 0;}
  .btn{display:inline-block;background:linear-gradient(135deg,#3d7fff,#0057ff);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;margin:8px 0;}
  .code{background:#131b33;border:1px solid rgba(61,127,255,0.3);border-radius:8px;padding:16px 20px;font-family:monospace;font-size:20px;letter-spacing:0.15em;color:#3d7fff;text-align:center;margin:16px 0;}
  .foot{padding:20px 36px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#445;}
</style></head>
<body><div class="wrap">
  <div class="head"><div class="logo">⬡ Boundary<span>.IQ</span></div></div>
  <div class="body">${body}</div>
  <div class="foot">Survey Intelligence Platform · <a href="${APP_URL}" style="color:#3d7fff;">Open App</a></div>
</div></body></html>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendWelcomeEmail({ to, username, plan = 'free' }) {
  if (!to) return;
  const subject = `Welcome to Boundary.IQ, ${username}!`;
  const html = baseHtml('Welcome', `
    <h1>Welcome aboard, ${username}!</h1>
    <p>Your Boundary.IQ account has been created. You're on the <strong style="color:#50c878">${plan.toUpperCase()}</strong> plan.</p>
    <p>You can access your workspace immediately:</p>
    <a class="btn" href="${APP_URL}">Open Workspace →</a>
    ${plan === 'free' ? `<p style="margin-top:20px;font-size:13px;">💡 Upgrade to <strong>Pro</strong> for unlimited deed solves, Batch processing, and Plat Extraction.</p>` : ''}
  `);
  const text = `Welcome to Boundary.IQ, ${username}! Your account is ready. Open: ${APP_URL}`;
  return sendEmail({ to, subject, html, text });
}

export async function sendPasswordChangedEmail({ to, username }) {
  if (!to) return;
  const subject = 'Your Boundary.IQ password was changed';
  const html = baseHtml('Password Changed', `
    <h1>Password Updated</h1>
    <p>Hi ${username}, your Boundary.IQ password was just changed.</p>
    <p>If you made this change, you can safely ignore this email.</p>
    <p>If you did not request this change, please contact your administrator immediately.</p>
    <a class="btn" href="${APP_URL}">Go to App →</a>
  `);
  const text = `Hi ${username}, your Boundary.IQ password was changed. If this wasn't you, contact your admin.`;
  return sendEmail({ to, subject, html, text });
}

export async function sendTempPasswordEmail({ to, username, tempPassword }) {
  if (!to) return;
  const subject = 'Your Boundary.IQ temporary password';
  const html = baseHtml('Password Reset', `
    <h1>Temporary Password</h1>
    <p>Hi ${username}, an administrator has reset your password. Use the temporary password below to log in, then change it immediately in Settings.</p>
    <div class="code">${tempPassword}</div>
    <a class="btn" href="${APP_URL}">Log In →</a>
    <p style="margin-top:16px;font-size:13px;color:#667;">This temporary password should be changed immediately after login.</p>
  `);
  const text = `Hi ${username}, your temp password is: ${tempPassword}. Log in at ${APP_URL} and change it.`;
  return sendEmail({ to, subject, html, text });
}

export async function sendPlanChangedEmail({ to, username, plan }) {
  if (!to) return;
  const planLabels = { free: 'Free', pro: 'Pro ⭐', enterprise: 'Enterprise 🏢' };
  const subject = `Your Boundary.IQ plan has been updated`;
  const html = baseHtml('Plan Updated', `
    <h1>Plan Updated</h1>
    <p>Hi ${username}, your subscription has been updated to <strong style="color:#50c878">${planLabels[plan] || plan}</strong>.</p>
    <a class="btn" href="${APP_URL}">Open Workspace →</a>
  `);
  const text = `Hi ${username}, your Boundary.IQ plan has been updated to ${plan}. Open: ${APP_URL}`;
  return sendEmail({ to, subject, html, text });
}

export async function sendInviteEmail({ to, inviteUrl, inviterUsername, note }) {
  if (!to) return;
  const subject = `${inviterUsername} invited you to Boundary.IQ`;
  const html = baseHtml('You\'re Invited', `
    <h1>You're Invited!</h1>
    <p>${inviterUsername} has invited you to join <strong>Boundary.IQ</strong> — the professional survey intelligence platform.</p>
    ${note ? `<p style="background:#131b33;border-radius:8px;padding:12px 16px;font-style:italic;">"${note}"</p>` : ''}
    <p>Click the button below to create your account. This link expires in 72 hours.</p>
    <a class="btn" href="${inviteUrl}">Accept Invitation →</a>
    <p style="margin-top:16px;font-size:12px;color:#445;">Link: <a href="${inviteUrl}" style="color:#3d7fff;">${inviteUrl}</a></p>
  `);
  const text = `You've been invited to Boundary.IQ by ${inviterUsername}. Accept here: ${inviteUrl}`;
  return sendEmail({ to, subject, html, text });
}

export async function sendVerificationEmail({ to, code }) {
  if (!to) return;
  const subject = `Verify your Boundary.IQ account`;
  const html = baseHtml('Verify Email', `
    <h1>Verify Your Account</h1>
    <p>Thank you for signing up for Boundary.IQ. Use the verification code below to complete your registration:</p>
    <div class="code">${code}</div>
    <p>This verification code is valid for 15 minutes.</p>
  `);
  const text = `Your Boundary.IQ verification code is: ${code}. Enter it to complete registration.`;
  return sendEmail({ to, subject, html, text });
}

export async function sendLicenseKeyEmail({ to, username, plan, licenseKey, note }) {
  if (!to) return;
  const planLabels = { basic: 'Basic', pro: 'Pro ⭐', enterprise: 'Enterprise 🏢' };
  const subject = `Your Boundary.IQ ${planLabels[plan] || plan} License Key`;
  const html = baseHtml('License Key', `
    <h1>Your License Key</h1>
    <p>Hi ${username}, here is your <strong style="color:#50c878">${planLabels[plan] || plan}</strong> license key for Boundary.IQ:</p>
    <div class="code">${licenseKey}</div>
    <p>To activate, go to <strong>Settings → License Key</strong> in the app and paste this key.</p>
    ${note ? `<p style="background:#131b33;border-radius:8px;padding:12px 16px;font-style:italic;font-size:13px;">${note}</p>` : ''}
    <a class="btn" href="${APP_URL}">Open Workspace →</a>
    <p style="margin-top:16px;font-size:12px;color:#445;">Keep this key safe — it can only be redeemed once.</p>
  `);
  const text = `Your Boundary.IQ license key: ${licenseKey}\nActivate in Settings → License Key at ${APP_URL}`;
  return sendEmail({ to, subject, html, text });
}

export const isMockMode = () => MOCK_MODE;
