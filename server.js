const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const { initMinioBucket, uploadProfilePhoto, getProfilePhotoStream } = require('./minioClient');

const app = express();

app.set('view engine', 'ejs');

// Captura rawBody como Buffer para verificação de assinatura HMAC do Stripe Webhook
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configuração do Stripe SDK (Modo de Teste - Atividade 7)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
let stripe = null;

if (STRIPE_SECRET_KEY) {
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
    console.log('[Stripe] SDK inicializado com sucesso em Test Mode.');
  } catch (stripeInitErr) {
    console.error('[Stripe] Erro ao inicializar SDK:', stripeInitErr.message);
  }
} else {
  console.warn('[Stripe Warning] STRIPE_SECRET_KEY não definida no ambiente. O checkout necessitará da chave.');
}

// Configuração do Multer (Upload em Memória, máx 5MB, somente imagens)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 Megabytes
  },
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (tiposPermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato de arquivo inválido. Apenas imagens (JPEG, PNG, WEBP, GIF) são permitidas.'));
    }
  }
});

// Configuração de Sessão
app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo_padrao_catalogo_filmes',
  resave: false,
  saveUninitialized: false
}));

// URLs dos Microsserviços Internos (Comunicação via Rede Interna Docker)
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
const LOG_SERVICE_URL = process.env.LOG_SERVICE_URL || 'http://log-service:3002';

/**
 * Função Auxiliar: Dispara logs de auditoria para o microsserviço log-service
 */
async function sendAuditLog(req, acao, detalhes = {}) {
  try {
    const user = req.session?.usuario || {};
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    await axios.post(`${LOG_SERVICE_URL}/logs`, {
      usuario_id: user.id || 'anonimo',
      usuario_nome: user.nome || 'Anônimo',
      usuario_email: user.email || '',
      acao,
      detalhes,
      ip: clientIp,
      timestamp: new Date().toISOString(),
      servico_origem: 'catalogo'
    }, { timeout: 2000 });
  } catch (err) {
    console.warn('[Audit Log Warning] Falha ao enviar evento para log-service:', err.message);
  }
}

// Pool de conexão para Favoritos e Comentários do Catálogo
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mariadb',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'rootpassword',
  database: process.env.DB_NAME || 'filmes_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Inicialização das tabelas do catálogo (favoritos, comentários e migrações de perfil)
async function initCatalogDb() {
  try {
    const conn = await pool.getConnection();
    
    // Tabela de favoritos
    await conn.query(`
      CREATE TABLE IF NOT EXISTS favoritos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        filme_id INT NOT NULL,
        titulo VARCHAR(255),
        poster_path VARCHAR(255),
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_usuario_filme (usuario_id, filme_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de comentários
    await conn.query(`
      CREATE TABLE IF NOT EXISTS comentarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        usuario_nome VARCHAR(255),
        filme_id INT NOT NULL,
        texto TEXT NOT NULL,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Garante que as colunas usuario_nome, bio e foto_url existam
    try {
      const [colsNome] = await conn.query("SHOW COLUMNS FROM comentarios LIKE 'usuario_nome'");
      if (colsNome.length === 0) {
        await conn.query("ALTER TABLE comentarios ADD COLUMN usuario_nome VARCHAR(255) DEFAULT 'Usuário'");
      }

      const [colsBio] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'bio'");
      if (colsBio.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN bio TEXT NULL");
      }

      const [colsFoto] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'foto_url'");
      if (colsFoto.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN foto_url VARCHAR(500) NULL");
      }

      // Migração Atividade 7: Plano Premium com Stripe
      const [colsPremium] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'is_premium'");
      if (colsPremium.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN is_premium TINYINT(1) NOT NULL DEFAULT 0");
        console.log('[Catalog DB] Coluna "is_premium" adicionada à tabela "usuarios".');
      }

      const [colsStripeCust] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'stripe_customer_id'");
      if (colsStripeCust.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN stripe_customer_id VARCHAR(255) NULL");
        console.log('[Catalog DB] Coluna "stripe_customer_id" adicionada à tabela "usuarios".');
      }

      const [colsStripeSub] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'stripe_subscription_id'");
      if (colsStripeSub.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN stripe_subscription_id VARCHAR(255) NULL");
        console.log('[Catalog DB] Coluna "stripe_subscription_id" adicionada à tabela "usuarios".');
      }

      const [colsPremiumEm] = await conn.query("SHOW COLUMNS FROM usuarios LIKE 'premium_em'");
      if (colsPremiumEm.length === 0) {
        await conn.query("ALTER TABLE usuarios ADD COLUMN premium_em DATETIME NULL");
        console.log('[Catalog DB] Coluna "premium_em" adicionada à tabela "usuarios".');
      }
    } catch (colErr) {
      console.warn('[Catalog DB] Aviso ao verificar colunas:', colErr.message);
    }

    conn.release();
    console.log('[Catalog DB] Tabelas do catálogo inicializadas com sucesso.');
  } catch (err) {
    console.warn('[Catalog DB] Aviso ao inicializar banco de dados:', err.message);
  }
}
initCatalogDb();
initMinioBucket();

// Middleware de Autenticação (Quem é você?)
function checkAuth(req, res, next) {
  if (req.session.usuario) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Middleware de Autorização RBAC (O que você pode fazer?)
function requireAdmin(req, res, next) {
  if (!req.session.usuario) {
    return res.redirect('/login');
  }
  
  if (req.session.usuario.role !== 'admin') {
    sendAuditLog(req, 'ACESSO_NEGADO_403_ADMIN_ROUTE', {
      rota_tentada: req.originalUrl,
      papel_usuario: req.session.usuario.role
    });

    return res.status(403).render('403', {
      usuario: req.session.usuario,
      mensagem: 'Acesso Negado (HTTP 403): Esta ação ou página é restrita a Administradores do sistema.'
    });
  }

  next();
}

// ==========================================
// ROTA PÚBLICA DE PROXY DE FOTOS DO MINIO
// ==========================================
app.get('/uploads/perfil/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const stream = await getProfilePhotoStream(key);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.pipe(res);
  } catch (err) {
    res.status(404).send('Foto de perfil não encontrada no Object Storage.');
  }
});

// ==========================================
// ROTAS DE AUTENTICAÇÃO E CATÁLOGO
// ==========================================

app.get('/', (req, res) => {
  if (req.session.usuario) {
    res.redirect('/home');
  } else {
    res.redirect('/login');
  }
});

// LOGIN
app.get('/login', (req, res) => {
  res.render('login', { erro: null, sucesso: null });
});

app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/login`, { email, senha });

    if (response.data && response.data.success) {
      req.session.usuario = response.data.user;
      return res.redirect('/home');
    }

    res.render('login', { erro: 'Credenciais inválidas.', sucesso: null });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao conectar ao serviço de autenticação.';
    res.render('login', { erro: msgErro, sucesso: null });
  }
});

// CADASTRO
app.get('/cadastro', (req, res) => {
  res.render('cadastro', { erro: null });
});

app.post('/cadastro', async (req, res) => {
  const { nome, email, senha, role } = req.body;
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/register`, { nome, email, senha, role });

    if (response.data && response.data.success) {
      req.session.usuario = response.data.user;
      return res.redirect('/home');
    }

    res.render('cadastro', { erro: 'Não foi possível realizar o cadastro.' });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao conectar ao serviço de autenticação.';
    res.render('cadastro', { erro: msgErro });
  }
});

// ESQUECI MINHA SENHA
app.get('/esqueci-senha', (req, res) => {
  res.render('esqueci-senha', { erro: null, sucesso: null });
});

app.post('/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  const appUrl = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/forgot-password`, { email, appUrl });
    res.render('esqueci-senha', { erro: null, sucesso: response.data.message });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao processar solicitação de recuperação de senha.';
    res.render('esqueci-senha', { erro: msgErro, sucesso: null });
  }
});

// REDEFINIR SENHA
app.get('/redefinir-senha', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.render('redefinir-senha', {
      valid: false,
      erro: 'Token de recuperação não fornecido.',
      token: ''
    });
  }

  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/auth/validate-token/${token}`);

    res.render('redefinir-senha', {
      valid: true,
      erro: null,
      token,
      email: response.data.email,
      nome: response.data.nome
    });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Link de recuperação inválido ou expirado.';
    res.render('redefinir-senha', {
      valid: false,
      erro: msgErro,
      token: ''
    });
  }
});

app.post('/redefinir-senha', async (req, res) => {
  const { token, novaSenha, confirmarSenha } = req.body;

  if (novaSenha !== confirmarSenha) {
    return res.render('redefinir-senha', {
      valid: true,
      erro: 'As senhas digitadas não coincidem.',
      token
    });
  }

  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/reset-password`, {
      token,
      novaSenha
    });

    res.render('login', {
      erro: null,
      sucesso: response.data.message || 'Senha redefinida com sucesso! Acesse sua conta com a nova senha.'
    });
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao redefinir senha.';
    res.render('redefinir-senha', {
      valid: false,
      erro: msgErro,
      token
    });
  }
});

// HOME (CATÁLOGO DE FILMES)
app.get('/home', checkAuth, async (req, res) => {
  try {
    // Sincroniza o status premium mais recente diretamente do banco de dados
    try {
      const [uRows] = await pool.query('SELECT is_premium FROM usuarios WHERE id = ?', [req.session.usuario.id]);
      if (uRows.length > 0) {
        req.session.usuario.is_premium = Boolean(uRows[0].is_premium);
      }
    } catch (uErr) {
      console.warn('Aviso sincronizacao usuario:', uErr.message);
    }

    let favoritos = [];
    try {
      const [rows] = await pool.query(
        'SELECT filme_id FROM favoritos WHERE usuario_id = ?',
        [req.session.usuario.id]
      );
      favoritos = rows;
    } catch (dbErr) {
      console.log('Aviso favoritos:', dbErr.message);
    }
    const favMap = new Set(favoritos.map(f => f.filme_id));

    const commMap = {};
    try {
      const [comentarios] = await pool.query(`
        SELECT c.id, c.usuario_id, c.usuario_nome, c.filme_id, c.texto, c.criado_em, COALESCE(u.is_premium, 0) as is_premium
        FROM comentarios c
        LEFT JOIN usuarios u ON u.id = c.usuario_id
        ORDER BY c.criado_em ASC
      `);
      comentarios.forEach(c => {
        if (!commMap[c.filme_id]) {
          commMap[c.filme_id] = [];
        }
        commMap[c.filme_id].push({
          id: c.id,
          usuario_id: c.usuario_id,
          usuario_nome: c.usuario_nome || 'Usuário',
          is_premium: Boolean(c.is_premium),
          texto: c.texto,
          criado_em: c.criado_em
        });
      });
    } catch (dbErr) {
      console.log('Aviso comentarios:', dbErr.message);
    }

    let filmes = [];
    if (process.env.TMDB_API_KEY) {
      try {
        const response = await axios.get(`https://api.themoviedb.org/3/person/31/movie_credits`, {
          params: { 
            api_key: process.env.TMDB_API_KEY, 
            language: 'pt-BR' 
          }
        });
        const rawFilmes = response.data.cast || [];
        filmes = rawFilmes.map(f => ({
          id: f.id,
          title: f.title || f.name || 'Título Indisponível',
          poster_path: f.poster_path ? `https://image.tmdb.org/t/p/w500${f.poster_path}` : null,
          overview: f.overview || ''
        }));
      } catch (tmdbErr) {
        console.error('Erro ao buscar TMDB:', tmdbErr.message);
      }
    }

    res.render('index', { 
      usuario: req.session.usuario, 
      filmes, 
      favMap, 
      commMap,
      erro: req.query.erro || null,
      sucesso: req.query.sucesso || null
    });
  } catch (error) {
    console.error('Erro na Home:', error.message);
    res.render('index', { 
      usuario: req.session.usuario, 
      filmes: [], 
      favMap: new Set(), 
      commMap: {},
      erro: 'Não foi possível carregar o catálogo de filmes.',
      sucesso: null
    });
  }
});

// Adicionar Favorito (Requisito 4: Diferença real de comportamento entre Comum e Premium)
app.post('/favoritar', checkAuth, async (req, res) => {
  const { filme_id, titulo, poster_path } = req.body;
  const isPremium = Boolean(req.session.usuario.is_premium);

  try {
    // 1. Verifica quantos favoritos o usuário já tem
    const [favRows] = await pool.query(
      'SELECT COUNT(*) as total FROM favoritos WHERE usuario_id = ?',
      [req.session.usuario.id]
    );
    const totalFavoritos = favRows[0]?.total || 0;

    // Regra de Negócio: Usuário comum tem limite de 3 favoritos; Premium tem favoritos ILIMITADOS
    if (!isPremium && totalFavoritos >= 3) {
      sendAuditLog(req, 'BLOQUEIO_LIMITE_FAVORITOS', {
        usuario_id: req.session.usuario.id,
        total_atual: totalFavoritos,
        limite: 3,
        filme_id,
        titulo
      });

      return res.redirect('/home?erro=' + encodeURIComponent('Limite de favoritos atingido (máx 3 para contas gratuitas). Assine o Plano Premium por R$ 9,90/mês para favoritar sem limites!'));
    }

    await pool.query(
      'INSERT IGNORE INTO favoritos (usuario_id, filme_id, titulo, poster_path) VALUES (?, ?, ?, ?)',
      [req.session.usuario.id, filme_id, titulo, poster_path]
    );

    sendAuditLog(req, 'FAVORITAR_FILME', { filme_id, titulo, is_premium: isPremium });
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao favoritar:', error);
    res.redirect('/home');
  }
});

// Remover Favorito
app.post('/desfavoritar', checkAuth, async (req, res) => {
  const { filme_id } = req.body;
  try {
    await pool.query(
      'DELETE FROM favoritos WHERE usuario_id = ? AND filme_id = ?',
      [req.session.usuario.id, filme_id]
    );

    sendAuditLog(req, 'DESFAVORITAR_FILME', { filme_id });
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao desfavoritar:', error);
    res.redirect('/home');
  }
});

// Adicionar Comentário
app.post('/comentar', checkAuth, async (req, res) => {
  const { filme_id, texto } = req.body;
  try {
    if (texto && texto.trim() !== '') {
      await pool.query(
        'INSERT INTO comentarios (usuario_id, usuario_nome, filme_id, texto) VALUES (?, ?, ?, ?)',
        [req.session.usuario.id, req.session.usuario.nome, filme_id, texto.trim()]
      );

      sendAuditLog(req, 'CRIAR_COMENTARIO', {
        filme_id,
        texto_resumo: texto.trim().substring(0, 40)
      });
    }
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao comentar:', error);
    res.redirect('/home');
  }
});

// Excluir Comentário (RBAC)
app.post('/comentarios/:id/deletar', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT * FROM comentarios WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.redirect('/home');
    }

    const comentario = rows[0];
    const isOwner = (comentario.usuario_id === req.session.usuario.id);
    const isAdmin = (req.session.usuario.role === 'admin');

    if (!isOwner && !isAdmin) {
      sendAuditLog(req, 'ACESSO_NEGADO_403_MODERACAO', {
        comentario_id: id,
        autor_comentario_id: comentario.usuario_id,
        autor_comentario_nome: comentario.usuario_nome
      });

      return res.status(403).render('403', {
        usuario: req.session.usuario,
        mensagem: 'Acesso Negado (HTTP 403): Você não tem permissão para excluir o comentário de outro usuário.'
      });
    }

    await pool.query('DELETE FROM comentarios WHERE id = ?', [id]);

    if (isAdmin && !isOwner) {
      sendAuditLog(req, 'MODERAR_COMENTARIO_ADMIN', {
        comentario_id: id,
        autor_original: comentario.usuario_nome,
        filme_id: comentario.filme_id,
        texto_resumo: comentario.texto.substring(0, 30)
      });
    } else {
      sendAuditLog(req, 'EXCLUIR_COMENTARIO_PROPRIO', {
        comentario_id: id,
        filme_id: comentario.filme_id
      });
    }

    res.redirect(req.headers.referer || '/home');
  } catch (error) {
    console.error('Erro ao deletar comentário:', error);
    res.redirect('/home');
  }
});

// ==========================================
// ROTAS DE PERFIL E UPLOAD MINIO (ATIVIDADE 6)
// ==========================================

// Visualizar Próprio Perfil
app.get('/perfil', checkAuth, async (req, res) => {
  try {
    let perfilUsuario = {
      id: req.session.usuario.id,
      nome: req.session.usuario.nome,
      email: req.session.usuario.email,
      role: req.session.usuario.role,
      bio: '',
      foto_url: null,
      is_premium: 0,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      premium_em: null,
      criado_em: new Date()
    };

    try {
      const [userRows] = await pool.query(
        'SELECT id, nome, email, role, bio, foto_url, is_premium, stripe_customer_id, stripe_subscription_id, premium_em, criado_em FROM usuarios WHERE id = ?',
        [req.session.usuario.id]
      );
      if (userRows.length > 0) {
        perfilUsuario = { ...perfilUsuario, ...userRows[0] };
        req.session.usuario.is_premium = Boolean(userRows[0].is_premium);
      }
    } catch (dbErr) {
      console.warn('[Perfil] Aviso ao buscar dados completos do usuário:', dbErr.message);
      try {
        const [fallbackRows] = await pool.query(
          'SELECT id, nome, email, role, criado_em FROM usuarios WHERE id = ?',
          [req.session.usuario.id]
        );
        if (fallbackRows.length > 0) {
          perfilUsuario = { ...perfilUsuario, ...fallbackRows[0] };
        }
      } catch (fbErr) {
        console.warn('[Perfil] Fallback usuário:', fbErr.message);
      }
    }

    let favoritos = [];
    try {
      const [favRows] = await pool.query(
        'SELECT filme_id, titulo, poster_path, criado_em FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC',
        [req.session.usuario.id]
      );
      favoritos = favRows;
    } catch (favErr) {
      console.warn('[Perfil] Aviso favoritos:', favErr.message);
    }

    res.render('perfil', {
      usuario: req.session.usuario,
      perfilUsuario,
      favoritos,
      isOwner: true,
      sucesso: req.query.sucesso || null,
      erro: req.query.erro || null
    });
  } catch (error) {
    console.error('Erro crítico ao carregar perfil:', error);
    res.status(500).send(`Erro ao carregar perfil: ${error.message}`);
  }
});

// Visualizar Perfil Público de Outro Usuário
app.get('/perfil/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    let perfilUsuario = null;

    try {
      const [userRows] = await pool.query(
        'SELECT id, nome, email, role, bio, foto_url, is_premium, stripe_customer_id, stripe_subscription_id, premium_em, criado_em FROM usuarios WHERE id = ?',
        [id]
      );
      if (userRows.length > 0) {
        perfilUsuario = userRows[0];
      }
    } catch (dbErr) {
      console.warn('[Perfil Publico] Aviso colunas:', dbErr.message);
      try {
        const [fallbackRows] = await pool.query(
          'SELECT id, nome, email, role, criado_em FROM usuarios WHERE id = ?',
          [id]
        );
        if (fallbackRows.length > 0) {
          perfilUsuario = { ...fallbackRows[0], bio: '', foto_url: null, is_premium: 0 };
        }
      } catch (fbErr) {
        console.warn('[Perfil Publico] Fallback:', fbErr.message);
      }
    }

    if (!perfilUsuario) {
      return res.status(404).send('Usuário não encontrado.');
    }

    const isOwner = (req.session.usuario.id == id);

    let favoritos = [];
    try {
      const [favRows] = await pool.query(
        'SELECT filme_id, titulo, poster_path, criado_em FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC',
        [id]
      );
      favoritos = favRows;
    } catch (favErr) {
      console.warn('[Perfil Publico] Aviso favoritos:', favErr.message);
    }

    res.render('perfil', {
      usuario: req.session.usuario,
      perfilUsuario,
      favoritos,
      isOwner,
      sucesso: req.query.sucesso || null,
      erro: req.query.erro || null
    });
  } catch (error) {
    console.error('Erro ao carregar perfil público:', error);
    res.status(500).send(`Erro ao carregar perfil público: ${error.message}`);
  }
});

// Editar Perfil com Upload de Imagem para MinIO (Requisito 4: Proteção RBAC)
app.post('/perfil/editar', checkAuth, (req, res, next) => {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      return res.redirect(`/perfil?erro=${encodeURIComponent(err.message)}`);
    }
    next();
  });
}, async (req, res) => {
  const loggedUserId = req.session.usuario.id;
  const { nome, bio, usuario_id } = req.body;

  // Enforcement de RBAC: Um usuário NUNCA pode editar perfil de outro
  if (usuario_id && String(usuario_id) !== String(loggedUserId)) {
    sendAuditLog(req, 'ACESSO_NEGADO_403_EDITAR_PERFIL_ALHEIO', {
      usuario_alvo_id: usuario_id,
      usuario_tentativa_id: loggedUserId
    });

    return res.status(403).render('403', {
      usuario: req.session.usuario,
      mensagem: 'Acesso Negado (HTTP 403): Você não tem permissão para editar o perfil de outro usuário.'
    });
  }

  try {
    let fotoUrlFinal = null;

    // Se houver upload de arquivo, envia para o MinIO Object Storage
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.png';
      const fileName = `avatar-${loggedUserId}-${Date.now()}${ext}`;

      // Upload do binário para o MinIO
      await uploadProfilePhoto(fileName, req.file.buffer, req.file.mimetype);
      
      // Chave / URL da imagem que será salva como referência no banco
      fotoUrlFinal = `/uploads/perfil/${fileName}`;

      sendAuditLog(req, 'UPLOAD_FOTO_PERFIL', {
        arquivo: fileName,
        tamanho_bytes: req.file.size,
        mimetype: req.file.mimetype,
        storage: 'MinIO'
      });
    }

    const nomeFinal = (nome && nome.trim() !== '') ? nome.trim() : req.session.usuario.nome;
    const bioFinal = bio !== undefined ? bio.trim() : '';

    if (fotoUrlFinal) {
      await pool.query(
        'UPDATE usuarios SET nome = ?, bio = ?, foto_url = ? WHERE id = ?',
        [nomeFinal, bioFinal, fotoUrlFinal, loggedUserId]
      );
      req.session.usuario.foto_url = fotoUrlFinal;
    } else {
      await pool.query(
        'UPDATE usuarios SET nome = ?, bio = ? WHERE id = ?',
        [nomeFinal, bioFinal, loggedUserId]
      );
    }

    req.session.usuario.nome = nomeFinal;

    sendAuditLog(req, 'ATUALIZAR_PERFIL', {
      nome: nomeFinal,
      bio_atualizada: bioFinal !== '',
      foto_atualizada: Boolean(fotoUrlFinal)
    });

    res.redirect('/perfil?sucesso=Perfil atualizado com sucesso!');
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.redirect(`/perfil?erro=${encodeURIComponent('Erro ao salvar alterações no perfil.')}`);
  }
});

// ==========================================
// ROTAS DE PAGAMENTO & STRIPE (ATIVIDADE 7)
// ==========================================

/**
 * 1. Endpoint de Checkout do Stripe (GET e POST)
 * Redireciona o usuário logado para a Checkout Session oficial hospedada pelo Stripe
 */
app.all(['/checkout/premium', '/checkout'], checkAuth, async (req, res) => {
  // Se o usuário já é premium, redireciona de volta
  if (req.session.usuario.is_premium) {
    return res.redirect('/perfil?sucesso=' + encodeURIComponent('Você já é um assinante do Plano Premium! Seus benefícios estão ativos.'));
  }

  // Verifica se o SDK do Stripe foi devidamente configurado com a secret key
  if (!stripe) {
    console.error('[Stripe Error] Tentativa de checkout sem STRIPE_SECRET_KEY configurada.');
    return res.redirect('/perfil?erro=' + encodeURIComponent('Stripe não configurado no servidor. Defina STRIPE_SECRET_KEY no arquivo .env para iniciar pagamentos em modo de teste.'));
  }

  try {
    const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    // Se houver STRIPE_PRICE_ID definido no ambiente, usa o Price ID configurado no painel;
    // Caso contrário, gera uma assinatura dinâmica inline no valor de R$ 9,90/mês.
    let lineItems;
    if (STRIPE_PRICE_ID) {
      lineItems = [{
        price: STRIPE_PRICE_ID,
        quantity: 1
      }];
    } else {
      lineItems = [{
        price_data: {
          currency: 'brl',
          product_data: {
            name: 'Plano Premium — Catálogo de Filmes Tom Hanks',
            description: 'Acesso VIP com favoritos ilimitados e selo de membro premium exclusivo em perfil e comentários.',
          },
          unit_amount: 990, // R$ 9,90
          recurring: {
            interval: 'month'
          }
        },
        quantity: 1
      }];
    }

    // Criação da sessão de checkout no Stripe (Modo de Teste com Dynamic Payment Methods)
    const session = await stripe.checkout.sessions.create({
      line_items: lineItems,
      mode: 'subscription',
      customer_email: req.session.usuario.email,
      client_reference_id: String(req.session.usuario.id),
      metadata: {
        usuario_id: String(req.session.usuario.id),
        usuario_nome: req.session.usuario.nome,
        usuario_email: req.session.usuario.email
      },
      subscription_data: {
        metadata: {
          usuario_id: String(req.session.usuario.id)
        }
      },
      success_url: `${baseUrl}/checkout/sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancelado`
    });

    sendAuditLog(req, 'STRIPE_CHECKOUT_INICIADO', {
      session_id: session.id,
      usuario_id: req.session.usuario.id,
      email: req.session.usuario.email,
      modo: 'subscription',
      valor: 'R$ 9,90/mês'
    });

    console.log(`[Stripe Checkout] Sessão ${session.id} criada para o usuário ${req.session.usuario.email}. Redirecionando...`);
    return res.redirect(303, session.url);
  } catch (stripeErr) {
    console.error('[Stripe Error] Erro ao criar Checkout Session:', stripeErr);
    return res.redirect('/perfil?erro=' + encodeURIComponent(`Erro ao iniciar Stripe Checkout: ${stripeErr.message}`));
  }
});

/**
 * 2. Endpoint de Retorno de Sucesso pós-Checkout
 */
app.get('/checkout/sucesso', checkAuth, async (req, res) => {
  const { session_id } = req.query;

  if (session_id && stripe) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session && (session.payment_status === 'paid' || session.status === 'complete')) {
        const usuarioId = session.client_reference_id || session.metadata?.usuario_id || req.session.usuario.id;
        
        await pool.query(
          'UPDATE usuarios SET is_premium = 1, stripe_customer_id = ?, stripe_subscription_id = ?, premium_em = NOW() WHERE id = ?',
          [session.customer || null, session.subscription || null, usuarioId]
        );

        req.session.usuario.is_premium = 1;

        sendAuditLog(req, 'CHECKOUT_SUCESSO_CONFIRMADO', {
          session_id,
          usuario_id: usuarioId,
          customer_id: session.customer,
          subscription_id: session.subscription
        });
      }
    } catch (retrieveErr) {
      console.warn('[Stripe] Aviso ao consultar sessão após retorno:', retrieveErr.message);
    }
  }

  // Garante que o status premium na sessão seja 1
  req.session.usuario.is_premium = 1;
  res.render('checkout-sucesso', { usuario: req.session.usuario });
});

/**
 * 3. Endpoint de Cancelamento pós-Checkout
 */
app.get('/checkout/cancelado', (req, res) => {
  res.render('checkout-cancelado', { usuario: req.session?.usuario || {} });
});

/**
 * 4. Endpoint de Webhook do Stripe (Validação Criptográfica de Assinatura)
 * Recebe notificações assíncronas do Stripe e atualiza is_premium: true no banco de dados
 */
app.post(['/webhook/stripe', '/webhook'], async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawPayload = req.rawBody || req.body;

    // Validação estrita de assinatura do webhook com Stripe SDK
    if (STRIPE_WEBHOOK_SECRET && sig && stripe) {
      event = stripe.webhooks.constructEvent(rawPayload, sig, STRIPE_WEBHOOK_SECRET);
    } else if (!STRIPE_WEBHOOK_SECRET) {
      // Fallback permissivo para desenvolvimento / testes manuais sem secret configurada
      console.warn('[Webhook Stripe] STRIPE_WEBHOOK_SECRET não configurada. Parseando payload diretamente.');
      event = typeof rawPayload === 'string' || Buffer.isBuffer(rawPayload)
        ? JSON.parse(rawPayload.toString())
        : rawPayload;
    } else {
      console.error('[Webhook Stripe] Cabeçalho stripe-signature ausente.');
      return res.status(400).send('Webhook Error: Cabeçalho stripe-signature ausente.');
    }
  } catch (err) {
    console.error('[Webhook Stripe Error] Falha na validação de assinatura:', err.message);
    return res.status(400).send(`Webhook Signature Verification Error: ${err.message}`);
  }

  console.log(`[Webhook Stripe] Evento recebido: ${event.type}`);

  try {
    // Caso 1: Pagamento / Checkout concluído com sucesso
    if (event.type === 'checkout.session.completed') {
      const sessionObj = event.data.object;
      const usuarioId = sessionObj.client_reference_id || sessionObj.metadata?.usuario_id;
      const customerId = sessionObj.customer;
      const subscriptionId = sessionObj.subscription;
      const customerEmail = sessionObj.customer_details?.email || sessionObj.customer_email || sessionObj.metadata?.usuario_email;

      console.log(`[Webhook Stripe] Processando checkout.session.completed para usuarioId=${usuarioId}, email=${customerEmail}`);

      // Atualiza usuário no MariaDB
      if (usuarioId) {
        await pool.query(
          'UPDATE usuarios SET is_premium = 1, stripe_customer_id = ?, stripe_subscription_id = ?, premium_em = NOW() WHERE id = ?',
          [customerId || null, subscriptionId || null, usuarioId]
        );
      } else if (customerEmail) {
        await pool.query(
          'UPDATE usuarios SET is_premium = 1, stripe_customer_id = ?, stripe_subscription_id = ?, premium_em = NOW() WHERE email = ?',
          [customerId || null, subscriptionId || null, customerEmail]
        );
      }

      // Sincroniza via microsserviço auth-service se disponível
      if (usuarioId) {
        try {
          await axios.post(`${AUTH_SERVICE_URL}/auth/users/${usuarioId}/premium`, {
            is_premium: 1,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId
          }, { timeout: 2000 });
        } catch (authErr) {
          console.warn('[Webhook Stripe] Aviso de sincronização com auth-service:', authErr.message);
        }
      }

      // Registro de Auditoria no Redis Streams (Microsserviço log-service)
      await sendAuditLog(req, 'ASSINATURA_PREMIUM_CONFIRMADA_WEBHOOK', {
        usuario_id: usuarioId,
        email: customerEmail,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        evento: event.type
      });

      console.log(`[Webhook Stripe] Usuário ${usuarioId || customerEmail} atualizado para PREMIUM com sucesso!`);
    }

    // Caso 2: Cobrança recorrente de fatura concluída
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      await pool.query(
        'UPDATE usuarios SET is_premium = 1 WHERE stripe_customer_id = ? OR stripe_subscription_id = ?',
        [customerId, subscriptionId]
      );

      sendAuditLog(req, 'FATURA_STRIPE_PAGA_SUCESSO', {
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId
      });
    }

    // Caso 3: Cancelamento de Assinatura no Stripe
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await pool.query(
        'UPDATE usuarios SET is_premium = 0 WHERE stripe_subscription_id = ?',
        [sub.id]
      );

      sendAuditLog(req, 'ASSINATURA_PREMIUM_CANCELADA_WEBHOOK', {
        stripe_subscription_id: sub.id
      });

      console.log(`[Webhook Stripe] Assinatura ${sub.id} cancelada. Usuário rebaixado para gratuito.`);
    }

    return res.status(200).json({ received: true });
  } catch (procErr) {
    console.error('[Webhook Stripe Error] Erro ao processar dados do evento:', procErr);
    return res.status(500).json({ error: 'Erro interno ao processar evento de webhook' });
  }
});

/**
 * 5. Endpoint Auxiliar: Simulação de Webhook Stripe em Ambiente Local / Avaliação
 * Permite comprovar o fluxo de webhook e mudança de status sem depender exclusivamente da CLI externa
 */
app.post('/admin/simular-webhook-stripe', checkAuth, async (req, res) => {
  const targetUserId = req.body.usuario_id || req.session.usuario.id;
  const mockCustomer = 'cus_test_' + Date.now();
  const mockSub = 'sub_test_' + Date.now();

  try {
    await pool.query(
      'UPDATE usuarios SET is_premium = 1, stripe_customer_id = ?, stripe_subscription_id = ?, premium_em = NOW() WHERE id = ?',
      [mockCustomer, mockSub, targetUserId]
    );

    if (String(req.session.usuario.id) === String(targetUserId)) {
      req.session.usuario.is_premium = 1;
    }

    sendAuditLog(req, 'ASSINATURA_PREMIUM_SIMULADA_TESTE', {
      usuario_id: targetUserId,
      stripe_customer_id: mockCustomer,
      stripe_subscription_id: mockSub
    });

    res.redirect('/perfil?sucesso=' + encodeURIComponent('Simulação de webhook Stripe executada com sucesso! Conta promovida a PREMIUM.'));
  } catch (simErr) {
    res.redirect('/perfil?erro=' + encodeURIComponent(`Erro na simulação: ${simErr.message}`));
  }
});

// ==========================================
// ROTAS ADMINISTRATIVAS (EXCLUSIVAS PARA ADMIN)
// ==========================================

app.get('/admin', requireAdmin, (req, res) => res.redirect('/admin/usuarios'));

app.get('/admin/usuarios', requireAdmin, async (req, res) => {
  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/auth/users`);
    const usuarios = response.data.users || [];

    let todosComentarios = [];
    try {
      const [rows] = await pool.query(
        'SELECT id, usuario_id, usuario_nome, filme_id, texto, criado_em FROM comentarios ORDER BY criado_em DESC'
      );
      todosComentarios = rows;
    } catch (cErr) {
      console.warn('[Admin] Aviso ao buscar comentários:', cErr.message);
    }

    res.render('admin-usuarios', {
      usuario: req.session.usuario,
      usuarios,
      comentarios: todosComentarios,
      sucesso: req.query.sucesso || null,
      erro: req.query.erro || null
    });
  } catch (error) {
    console.error('Erro ao carregar painel de usuários:', error.message);
    res.render('admin-usuarios', {
      usuario: req.session.usuario,
      usuarios: [],
      comentarios: [],
      sucesso: null,
      erro: 'Não foi possível carregar os dados do serviço de autenticação.'
    });
  }
});

// Alterar Papel de Usuário
app.post('/admin/usuarios/:id/role', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/users/${id}/role`, {
      role,
      requesterRole: req.session.usuario.role
    });

    res.redirect(`/admin/usuarios?sucesso=${encodeURIComponent(response.data.message || 'Papel alterado com sucesso!')}`);
  } catch (error) {
    const msgErro = error.response?.data?.error || 'Erro ao alterar papel do usuário.';
    res.redirect(`/admin/usuarios?erro=${encodeURIComponent(msgErro)}`);
  }
});

// Painel de Logs de Auditoria (Redis Streams)
app.get('/admin/logs', requireAdmin, async (req, res) => {
  try {
    const response = await axios.get(`${LOG_SERVICE_URL}/logs`, {
      params: {
        limit: 100,
        acao: req.query.acao || undefined
      }
    });

    res.render('admin-logs', {
      usuario: req.session.usuario,
      logs: response.data.logs || [],
      filtroAcao: req.query.acao || ''
    });
  } catch (error) {
    console.error('Erro ao consultar logs do log-service:', error.message);
    res.render('admin-logs', {
      usuario: req.session.usuario,
      logs: [],
      filtroAcao: req.query.acao || ''
    });
  }
});

// LOGOUT
app.get('/logout', (req, res) => {
  if (req.session.usuario) {
    sendAuditLog(req, 'LOGOUT', { email: req.session.usuario.email });
  }
  req.session.destroy();
  res.redirect('/login');
});

const PORT = process.env.INTERNAL_PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`>>> [CATÁLOGO] SERVIDOR RODANDO INTERNAMENTE NA PORTA ${PORT} <<<`);
  console.log(`>>> [CATÁLOGO] Microsserviço de Auth conectado em: ${AUTH_SERVICE_URL} <<<`);
  console.log(`>>> [CATÁLOGO] Microsserviço de Logs conectado em: ${LOG_SERVICE_URL} <<<`);
});