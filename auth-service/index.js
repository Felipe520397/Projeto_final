const express = require('express');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());

const dbConfig = {
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root_password',
  database: process.env.DB_NAME || 'app_db'
};

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io',
  port: Number(process.env.SMTP_PORT) || 2525,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Login (Retorna dados do usuário e sua Role)
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute('SELECT * FROM usuarios WHERE email = ?', [email]);
    await connection.end();

    if (rows.length === 0) return res.status(401).json({ error: 'Usuário não encontrado' });

    const usuario = rows[0];
    const senhaValida = await bcrypt.compare(senha, usuario.senha);

    if (!senhaValida) return res.status(401).json({ error: 'Senha incorreta' });

    return res.json({
      message: 'Login realizado com sucesso!',
      usuario: { id: usuario.id, email: usuario.email, role: usuario.role }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Cadastro (Role 'usuario' por padrão)
app.post('/cadastro', async (req, res) => {
  const { nome, email, senha, role } = req.body;
  try {
    const userRole = role || 'usuario';
    const hash = await bcrypt.hash(senha, 10);
    const connection = await mysql.createConnection(dbConfig);
    await connection.execute('INSERT INTO usuarios (nome, email, senha, role) VALUES (?, ?, ?, ?)', [nome, email, hash, userRole]);
    await connection.end();
    return res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Esqueci a Senha (Gera token com expiração de 30 minutos e salva na tabela reset_tokens)
app.post('/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute('SELECT * FROM usuarios WHERE email = ?', [email]);

    if (rows.length === 0) {
      await connection.end();
      return res.status(404).json({ error: 'E-mail não cadastrado' });
    }

    const usuario = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    
    // Regra de expiração: Exatamente 30 minutos no futuro
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + 30 * 60 * 1000);

    await connection.execute(
      'INSERT INTO reset_tokens (token, usuario_id, criado_em, expira_em, usado) VALUES (?, ?, ?, ?, ?)',
      [token, usuario.id, agora, expiraEm, false]
    );
    await connection.end();

    const resetLink = `http://localhost:8080/redefinir-senha?token=${token}`;

    await transporter.sendMail({
      from: '"Suporte Catálogo" <no-reply@catalogo.com>',
      to: email,
      subject: 'Recuperação de Senha',
      html: `<p>Você solicitou a redefinição de senha.</p><p>Clique no link para redefinir (Válido por 30 minutos): <a href="${resetLink}">${resetLink}</a></p>`
    });

    return res.json({ message: 'E-mail enviado com sucesso!' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Redefinir Senha (Valida se o token existe, não expirou e ainda não foi usado)
app.post('/redefinir-senha', async (req, res) => {
  const { token, novaSenha } = req.body;
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute(
      'SELECT * FROM reset_tokens WHERE token = ? AND usado = FALSE AND expira_em > NOW()',
      [token]
    );

    if (rows.length === 0) {
      await connection.end();
      return res.status(400).json({ error: 'Token inválido, expirado ou já utilizado' });
    }

    const resetRequest = rows[0];
    const hash = await bcrypt.hash(novaSenha, 10);

    // Atualiza a senha do usuário
    await connection.execute('UPDATE usuarios SET senha = ? WHERE id = ?', [hash, resetRequest.usuario_id]);
    
    // Marca o token como utilizado para evitar reuso
    await connection.execute('UPDATE reset_tokens SET usado = TRUE WHERE id = ?', [resetRequest.id]);
    
    await connection.end();

    return res.json({ message: 'Senha alterada com sucesso!' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Auth-Service rodando internamente na porta 3000'));