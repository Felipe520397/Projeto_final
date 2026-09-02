const nodemailer = require('nodemailer');
require('dotenv').config();

// Configuração do transporter SMTP (Mailtrap em desenvolvimento / Brevo ou outro em produção)
function createTransporter() {
  const host = process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io';
  const port = parseInt(process.env.SMTP_PORT || '2525', 10);
  const user = (process.env.SMTP_USER || '').trim();
  // Remove espaços caso o usuário tenha colado a senha do Google com espaços (ex: 'ryzt ydec oeay bswq')
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  if (!user || !pass) {
    console.warn('[Mailer] ATENÇÃO: Credenciais SMTP não configuradas (SMTP_USER / SMTP_PASS).');
  }

  // Configuração específica para Gmail ou genérica para outros SMTPs
  if (host.includes('gmail')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user,
        pass
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass
    },
    tls: {
      rejectUnauthorized: false
    }
  });
}

/**
 * Envia o e-mail de recuperação de senha com link temporário (30 minutos)
 */
async function sendPasswordResetEmail(toEmail, userName, resetLink) {
  const transporter = createTransporter();
  const from = process.env.SMTP_FROM || '"Catálogo Tom Hanks" <no-reply@catalogofilmes.com>';

  const mailOptions = {
    from,
    to: toEmail,
    subject: 'Recuperação de Senha — Catálogo de Filmes',
    html: `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f9; margin: 0; padding: 20px; color: #333; }
          .container { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.08); }
          .header { background: #141414; color: #ffffff; padding: 24px; text-align: center; }
          .header h1 { margin: 0; font-size: 20px; letter-spacing: 1px; color: #e50914; }
          .content { padding: 30px; line-height: 1.6; }
          .btn-container { text-align: center; margin: 30px 0; }
          .btn { background-color: #e50914; color: #ffffff !important; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; }
          .warning { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 20px 0; font-size: 0.9em; color: #856404; }
          .footer { background: #f9f9f9; padding: 15px; text-align: center; font-size: 0.8em; color: #888; border-top: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎬 CATÁLOGO TOM HANKS</h1>
          </div>
          <div class="content">
            <p>Olá, <strong>${userName || 'Usuário'}</strong>!</p>
            <p>Recebemos uma solicitação para redefinir a senha da sua conta no Catálogo de Filmes.</p>
            
            <div class="btn-container">
              <a href="${resetLink}" class="btn" target="_blank">Redefinir Minha Senha</a>
            </div>

            <div class="warning">
              ⏰ <strong>Atenção:</strong> Este link expira em <strong>30 minutos</strong> e só pode ser utilizado <strong>uma única vez</strong>.
            </div>

            <p style="font-size: 0.9em; color: #666;">
              Se o botão acima não funcionar, copie e cole o seguinte link no seu navegador:<br>
              <a href="${resetLink}" style="word-break: break-all; color: #007bff;">${resetLink}</a>
            </p>

            <p style="font-size: 0.85em; color: #999; margin-top: 25px;">
              Se você não solicitou a alteração de senha, ignore este e-mail. Sua senha permanecerá a mesma.
            </p>
          </div>
          <div class="footer">
            Atividade 3 — Serviços Desacoplados | ISW055 · Introdução à Computação em Nuvem
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Olá ${userName || 'Usuário'},\n\nRecebemos uma solicitação para redefinir sua senha.\nAcesse o link abaixo para criar uma nova senha (válido por 30 minutos):\n\n${resetLink}\n\nSe não foi você quem solicitou, ignore esta mensagem.`
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`[Mailer] E-mail de recuperação enviado para ${toEmail}. MessageId: ${info.messageId}`);
  return info;
}

module.exports = { sendPasswordResetEmail };

