const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const axios = require('axios');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo_padrao',
  resave: false,
  saveUninitialized: false
}));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

function checkAuth(req, res, next) {
  if (req.session.usuario) {
    next();
  } else {
    res.redirect('/login');
  }
}

// ROTAS

app.get('/', (req, res) => {
  if (req.session.usuario) {
    res.redirect('/home');
  } else {
    res.redirect('/login');
  }
});

app.get('/login', (req, res) => {
  res.render('login', { erro: null });
});

app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.render('login', { erro: 'Usuário não encontrado.' });
    }

    const usuario = rows[0];
    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash || usuario.senha).catch(() => senha === usuario.senha);
    
    if (!senhaValida) {
      return res.render('login', { erro: 'Senha incorreta.' });
    }

    req.session.usuario = { id: usuario.id, nome: usuario.nome, email: usuario.email };
    res.redirect('/home');
  } catch (error) {
    console.error('Erro no Login:', error);
    res.render('login', { erro: 'Erro ao conectar ao banco de dados.' });
  }
});

app.get('/cadastro', (req, res) => {
  res.render('cadastro', { erro: null });
});

app.post('/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const [existentes] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (existentes.length > 0) {
      return res.render('cadastro', { erro: 'Este e-mail já está cadastrado.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)',
      [nome, email, senhaHash]
    );

    req.session.usuario = { id: result.insertId, nome, email };
    res.redirect('/home');
  } catch (error) {
    console.error('Erro no Cadastro:', error);
    res.render('cadastro', { erro: 'Erro ao cadastrar no banco de dados.' });
  }
});

app.get('/home', checkAuth, async (req, res) => {
  try {
    // 1. Busca favoritos
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

    // 2. Busca comentários e organiza no objeto commMap
    const commMap = {};
    try {
      const [comentarios] = await pool.query(
        'SELECT filme_id, texto FROM comentarios WHERE usuario_id = ?',
        [req.session.usuario.id]
      );
      comentarios.forEach(c => {
        if (!commMap[c.filme_id]) {
          commMap[c.filme_id] = [];
        }
        commMap[c.filme_id].push(c.texto);
      });
    } catch (dbErr) {
      console.log('Aviso comentarios:', dbErr.message);
    }

    // 3. Busca filmes do TMDB
    const response = await axios.get(`https://api.themoviedb.org/3/person/31/movie_credits`, {
      params: { 
        api_key: process.env.TMDB_API_KEY, 
        language: 'pt-BR' 
      }
    });

    const rawFilmes = response.data.cast || [];
    const filmes = rawFilmes.map(f => ({
      id: f.id,
      title: f.title || f.name || 'Título Indisponível',
      poster_path: f.poster_path ? `https://image.tmdb.org/t/p/w500${f.poster_path}` : 'https://via.placeholder.com/500x750?text=Sem+Foto',
      overview: f.overview || ''
    }));

    res.render('index', { usuario: req.session.usuario, filmes, favMap, commMap });
  } catch (error) {
    console.error('Erro na Home:', error.message);
    res.render('index', { usuario: req.session.usuario, filmes: [], favMap: new Set(), commMap: {} });
  }
});

// Adicionar Favorito
app.post('/favoritar', checkAuth, async (req, res) => {
  const { filme_id, titulo, poster_path } = req.body;
  try {
    await pool.query(
      'INSERT IGNORE INTO favoritos (usuario_id, filme_id, titulo, poster_path) VALUES (?, ?, ?, ?)',
      [req.session.usuario.id, filme_id, titulo, poster_path]
    );
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
        'INSERT INTO comentarios (usuario_id, filme_id, texto) VALUES (?, ?, ?)',
        [req.session.usuario.id, filme_id, texto]
      );
    }
    res.redirect('/home');
  } catch (error) {
    console.error('Erro ao comentar:', error);
    res.redirect('/home');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`>>> SERVIDOR RODANDO EM http://localhost:${PORT} <<<`);
});