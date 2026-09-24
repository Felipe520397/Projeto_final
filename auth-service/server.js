const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const { pool, initDatabase } = require('./db');
const { sendPasswordResetEmail } = require('./mailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const LOG_SERVICE_URL = process.env.LOG_SERVICE_URL || 'http://log-service:3002';

/**
 * Envia evento de auditoria para o microsserviço log-service
 */
async function logAuditEvent({ usuario_id, usuario_nome, usuario_email, acao, detalhes, ip }) {
  try {
    await axios.post(`${LOG_SERVICE_URL}/logs`, {
      usuario_id,
      usuario_nome,
      usuario_email,
      acao,
      detalhes,
      ip,
      timestamp: new Date().toISOString(),
      servico_origem: 'auth-service'
    }, { timeout: 2000 });
  } catch (err) {
    console.warn('[Auth-Service Log Warning] Não foi possível registrar evento no log-service:', err.message);
  }
}

// Inicializa banco de dados (tabelas e migrações)
initDatabase();

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

/**
 * ROTA: Cadastro de usuário
 * POST /auth/register
 * Body: { nome, email, senha, role }
 */
app.post('/auth/register', async (req, res) => {
  const { nome, email, senha, role } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  if (!nome || !email || !senha) {
    return res.status(400).json({ success: false, error: 'Nome, e-mail e senha são obrigatórios.' });
  }

  try {
    const [existentes] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (existentes.length > 0) {
      logAuditEvent({
        usuario_id: null,
        usuario_nome: nome,
        usuario_email: email,
        acao: 'CADASTRO_FALHA_EMAIL_DUPLICADO',
        detalhes: { motivo: 'email_ja_cadastrado' },
        ip: clientIp
      });
      return res.status(400).json({ success: false, error: 'Este e-mail já está cadastrado.' });
    }

    const roleFinal = (role === 'admin') ? 'admin' : 'usuario';
    const senhaHash = await bcrypt.hash(senha, 10);

    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES (?, ?, ?, ?)',
      [nome, email, senhaHash, roleFinal]
    );

    const novoUsuario = {
      id: result.insertId,
      nome,
      email,
      role: roleFinal
    };

    // Log de auditoria
    logAuditEvent({
      usuario_id: result.insertId,
      usuario_nome: nome,
      usuario_email: email,
      acao: 'CADASTRO_USUARIO',
      detalhes: { role: roleFinal },
      ip: clientIp
    });

    return res.status(201).json({
      success: true,
      message: 'Usuário cadastrado com sucesso!',
      user: novoUsuario
    });
  } catch (error) {
    console.error('[Auth-Service] Erro no cadastro:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao cadastrar usuário.' });
  }
});

/**
 * ROTA: Login de usuário
 * POST /auth/login
 * Body: { email, senha }
 */
app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  if (!email || !senha) {
    return res.status(400).json({ success: false, error: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) {
      logAuditEvent({
        usuario_id: null,
        usuario_nome: 'Anônimo',
        usuario_email: email,
        acao: 'LOGIN_FALHA_USUARIO_NAO_ENCONTRADO',
        detalhes: { motivo: 'usuario_nao_encontrado' },
        ip: clientIp
      });
      return res.status(401).json({ success: false, error: 'Usuário não encontrado.' });
    }

    const usuario = rows[0];
    const hashArmazenado = usuario.senha_hash || usuario.senha;
    let senhaValida = false;

    try {
      senhaValida = await bcrypt.compare(senha, hashArmazenado);
    } catch {
      senhaValida = (senha === hashArmazenado);
    }

    if (!senhaValida) {
      logAuditEvent({
        usuario_id: usuario.id,
        usuario_nome: usuario.nome,
        usuario_email: usuario.email,
        acao: 'LOGIN_FALHA_SENHA_INCORRETA',
        detalhes: { motivo: 'senha_incorreta' },
        ip: clientIp
      });
      return res.status(401).json({ success: false, error: 'Senha incorreta.' });
    }

    const userRetorno = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      role: usuario.role || 'usuario'
    };

    // Log de auditoria
    logAuditEvent({
      usuario_id: usuario.id,
      usuario_nome: usuario.nome,
      usuario_email: usuario.email,
      acao: 'LOGIN_SUCESSO',
      detalhes: { role: userRetorno.role },
      ip: clientIp
    });

    return res.json({
      success: true,
      message: 'Login realizado com sucesso!',
      user: userRetorno
    });
  } catch (error) {
    console.error('[Auth-Service] Erro no login:', error);
    return res.status(500).json({ success: false, error: 'Erro interno no serviço de autenticação.' });
  }
});

/**
 * ROTA: Consulta de usuário / papel (role)
 * GET /auth/user-role/:id
 */
app.get('/auth/user-role/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await pool.query('SELECT id, nome, email, role FROM usuarios WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    }

    return res.json({
      success: true,
      user: rows[0],
      role: rows[0].role || 'usuario'
    });
  } catch (error) {
    console.error('[Auth-Service] Erro ao consultar role:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao consultar papel do usuário.' });
  }
});

/**
 * ROTA: Listar todos os usuários (Exclusivo Admin)
 * GET /auth/users
 */
app.get('/auth/users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nome, email, role, criado_em FROM usuarios ORDER BY id ASC');
    return res.json({ success: true, users: rows });
  } catch (error) {
    console.error('[Auth-Service] Erro ao listar usuários:', error);
    return res.status(500).json({ success: false, error: 'Erro ao listar usuários.' });
  }
});

/**
 * ROTA: Alterar papel (role) de um usuário (Exclusivo Admin - Enforcement 403)
 * POST /auth/users/:id/role
 * Body: { role, requesterRole }
 */
app.post('/auth/users/:id/role', async (req, res) => {
  const { id } = req.params;
  const { role, requesterRole } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  // Validação no servidor: apenas admin pode alterar papéis
  if (requesterRole !== 'admin') {
    logAuditEvent({
      usuario_id: null,
      usuario_nome: 'Tentativa Não Autorizada',
      acao: 'ACESSO_NEGADO_403_ALTERAR_ROLE',
      detalhes: { target_usuario_id: id, role_solicitada: role },
      ip: clientIp
    });

    return res.status(403).json({
      success: false,
      error: 'Acesso negado (HTTP 403): apenas administradores têm permissão para alterar papéis de usuários.'
    });
  }

  if (!['usuario', 'admin'].includes(role)) {
    return res.status(400).json({ success: false, error: 'Papel inválido. Deve ser "usuario" ou "admin".' });
  }

  try {
    const [result] = await pool.query('UPDATE usuarios SET role = ? WHERE id = ?', [role, id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    }

    logAuditEvent({
      usuario_id: id,
      usuario_nome: 'Administrador',
      acao: 'ALTERAR_ROLE_SUCESSO',
      detalhes: { target_usuario_id: id, novo_role: role },
      ip: clientIp
    });

    console.log(`[Auth-Service] Papel do usuário ID ${id} alterado para "${role}".`);
    return res.json({ success: true, message: `Papel do usuário atualizado para "${role}" com sucesso!` });
  } catch (error) {
    console.error('[Auth-Service] Erro ao alterar papel:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao alterar papel do usuário.' });
  }
});

/**
 * ROTA: Esqueci minha senha (Gera token de 30 minutos e envia e-mail)
 * POST /auth/forgot-password
 * Body: { email, appUrl }
 */
app.post('/auth/forgot-password', async (req, res) => {
  const { email, appUrl } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  if (!email) {
    return res.status(400).json({ success: false, error: 'E-mail é obrigatório.' });
  }

  try {
    const [rows] = await pool.query('SELECT id, nome, email FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) {
      console.log(`[Auth-Service] Solicitação de recuperação para e-mail não cadastrado: ${email}`);
      return res.json({
        success: true,
        message: 'Se o e-mail informado estiver cadastrado, um link de recuperação foi enviado.'
      });
    }

    const usuario = rows[0];

    // Gera token seguro e único de 32 bytes (64 caracteres hex)
    const token = crypto.randomBytes(32).toString('hex');

    // Validade de exatamente 30 minutos
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + 30 * 60 * 1000);
    const expiraEmSql = expiraEm.toISOString().slice(0, 19).replace('T', ' ');

    await pool.query(
      'INSERT INTO reset_tokens (token, usuario_id, criado_em, expira_em, usado) VALUES (?, ?, NOW(), ?, 0)',
      [token, usuario.id, expiraEmSql]
    );

    const baseUrl = appUrl || process.env.APP_URL || 'http://localhost:8204';
    const resetLink = `${baseUrl.replace(/\/$/, '')}/redefinir-senha?token=${token}`;

    logAuditEvent({
      usuario_id: usuario.id,
      usuario_nome: usuario.nome,
      usuario_email: usuario.email,
      acao: 'SOLICITAR_RECUPERACAO_SENHA',
      detalhes: { expira_em: expiraEmSql },
      ip: clientIp
    });

    console.log(`[Auth-Service] Token gerado para ${usuario.email}: ${token} (Expira em: ${expiraEmSql})`);

    // Envio do e-mail via SMTP
    try {
      await sendPasswordResetEmail(usuario.email, usuario.nome, resetLink);
    } catch (mailErr) {
      console.error('[Auth-Service] Falha ao enviar e-mail via SMTP:', mailErr.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao enviar e-mail de recuperação. Verifique as configurações de SMTP.'
      });
    }

    return res.json({
      success: true,
      message: 'E-mail de recuperação enviado com sucesso! O link é válido por 30 minutos.'
    });
  } catch (error) {
    console.error('[Auth-Service] Erro ao solicitar recuperação de senha:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao processar recuperação de senha.' });
  }
});

/**
 * ROTA: Validação de Token de Recuperação
 * GET /auth/validate-token/:token
 */
app.get('/auth/validate-token/:token', async (req, res) => {
  const { token } = req.params;

  if (!token) {
    return res.status(400).json({ valid: false, error: 'Token não fornecido.' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT r.*, u.nome, u.email FROM reset_tokens r JOIN usuarios u ON u.id = r.usuario_id WHERE r.token = ?',
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ valid: false, error: 'Token de recuperação inválido ou inexistente.' });
    }

    const tokenData = rows[0];

    // 1. Checa se o token já foi usado
    if (tokenData.usado === 1 || tokenData.usado === true) {
      return res.status(400).json({ valid: false, error: 'Este link de recuperação já foi utilizado.' });
    }

    // 2. Checa se o token expirou (mais de 30 minutos)
    const agora = new Date();
    const expiraEm = new Date(tokenData.expira_em);

    if (agora.getTime() > expiraEm.getTime()) {
      return res.status(400).json({
        valid: false,
        error: 'Este link de recuperação expirou (ultrapassou o prazo de 30 minutos). Solicite um novo link.'
      });
    }

    return res.json({
      valid: true,
      message: 'Token válido.',
      usuario_id: tokenData.usuario_id,
      email: tokenData.email,
      nome: tokenData.nome
    });
  } catch (error) {
    console.error('[Auth-Service] Erro ao validar token:', error);
    return res.status(500).json({ valid: false, error: 'Erro interno ao validar token.' });
  }
});

/**
 * ROTA: Redefinição de senha com validação completa do token
 * POST /auth/reset-password
 * Body: { token, novaSenha }
 */
app.post('/auth/reset-password', async (req, res) => {
  const { token, novaSenha } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  if (!token || !novaSenha) {
    return res.status(400).json({ success: false, error: 'Token e nova senha são obrigatórios.' });
  }

  if (novaSenha.length < 4) {
    return res.status(400).json({ success: false, error: 'A nova senha deve ter pelo menos 4 caracteres.' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM reset_tokens WHERE token = ?', [token]);

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Token de recuperação inválido ou inexistente.' });
    }

    const tokenData = rows[0];

    // 1. Checa se já foi usado
    if (tokenData.usado === 1 || tokenData.usado === true) {
      return res.status(400).json({
        success: false,
        error: 'Este link de recuperação já foi utilizado. Solicite um novo link.'
      });
    }

    // 2. Checa se expirou (> 30 minutos)
    const agora = new Date();
    const expiraEm = new Date(tokenData.expira_em);

    if (agora.getTime() > expiraEm.getTime()) {
      return res.status(400).json({
        success: false,
        error: 'Este link de recuperação expirou (ultrapassou o prazo de 30 minutos). Solicite um novo link.'
      });
    }

    // 3. Atualiza senha do usuário com hash bcrypt
    const senhaHash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [senhaHash, tokenData.usuario_id]);

    // 4. Marca o token como usado para evitar reutilização
    await pool.query('UPDATE reset_tokens SET usado = 1 WHERE id = ?', [tokenData.id]);

    logAuditEvent({
      usuario_id: tokenData.usuario_id,
      usuario_nome: 'Usuário',
      acao: 'REDEFINIR_SENHA_SUCESSO',
      detalhes: { token: token.substring(0, 8) + '...' },
      ip: clientIp
    });

    console.log(`[Auth-Service] Senha do usuário ID ${tokenData.usuario_id} redefinida com sucesso via token ${token}.`);

    return res.json({
      success: true,
      message: 'Senha redefinida com sucesso! Você já pode fazer login com a nova senha.'
    });
  } catch (error) {
    console.error('[Auth-Service] Erro ao redefinir senha:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao redefinir senha.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`>>> [AUTH-SERVICE] RODANDO INTERNAMENTE NA PORTA ${PORT} <<<`);
});
